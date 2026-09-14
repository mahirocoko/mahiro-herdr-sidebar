import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse as parsePath, resolve as resolvePath, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { readUsageCache, refresh, sanitizeToken, usageCacheDir } from './core.mjs'

export const DEFAULT_CACHE_FILENAME = 'agy.json'
export const DEDUPE_TTL_MS = 120 * 1000

const MAX_CACHE_BYTES = 64 * 1024
const MIN_TIMESTAMP = Date.UTC(2020, 0, 1)
const MAX_RESET_AHEAD_MS = 370 * 24 * 60 * 60 * 1000
const MAX_RESET_AHEAD_SECONDS = 370 * 24 * 60 * 60
const COMMAND_TIMEOUT_MS = 5 * 1000

export const BUCKET_MAPPINGS = Object.freeze([
  Object.freeze({ id: 'gemini-5h', label: 'Gemini:5h' }),
  Object.freeze({ id: 'gemini-weekly', label: 'Gemini:7d' }),
  Object.freeze({ id: '3p-5h', label: 'Claude-GPT:5h' }),
  Object.freeze({ id: '3p-weekly', label: 'Claude-GPT:7d' })
])

export function isRunningUnderHerdr(env = process.env) {
  return env.HERDR_ENV === '1' && typeof env.HERDR_PANE_ID === 'string' && env.HERDR_PANE_ID.length > 0
}

function parseIsoTimestamp(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/u.test(value)) {
    return null
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || Number.isNaN(new Date(parsed).getTime())) {
    return null
  }
  if (parsed < MIN_TIMESTAMP || parsed > now + MAX_RESET_AHEAD_MS) {
    return null
  }
  return parsed
}

function parseSecondsFallback(value, now) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_RESET_AHEAD_SECONDS) {
    return null
  }
  return now + Math.round(value * 1000)
}

export function normalizeAgyQuota(payload, options = {}) {
  let parsed = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const quota = parsed.quota
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return null

  const clock = options.clock || Date.now
  const now = clock()
  const fetched = typeof options.fetched === 'number' && Number.isFinite(options.fetched)
    ? options.fetched
    : now

  if (fetched < MIN_TIMESTAMP || fetched > now) return null

  const windows = []
  for (const { id, label } of BUCKET_MAPPINGS) {
    if (!Object.hasOwn(quota, id)) continue
    const bucket = quota[id]
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue

    const fraction = bucket.remaining_fraction
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      continue
    }
    const remaining = Math.round(fraction * 10000) / 100

    let reset = parseIsoTimestamp(bucket.reset_time, now)
    if (reset === null) {
      reset = parseSecondsFallback(bucket.reset_in_seconds, now)
    }
    if (reset === null) continue

    const cleanLabel = sanitizeToken(label)
    if (cleanLabel !== label) continue

    windows.push({ label, remaining, reset })
  }

  if (windows.length === 0) return null
  return { fetched, failed: false, windows }
}

function areWindowsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const wa = a[index]
    const wb = b[index]
    if (!wa || !wb) return false
    if (wa.label !== wb.label || wa.remaining !== wb.remaining || Math.abs(wa.reset - wb.reset) > DEDUPE_TTL_MS) {
      return false
    }
  }
  return true
}

async function verifyDirectoryChain(directory) {
  const absolute = resolvePath(directory)
  const root = parsePath(absolute).root
  let current = root
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    let details
    try {
      details = await lstat(current)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`refusing symlink or non-directory cache path component: ${current}`)
    }
  }
}

async function verifyCacheSafety(targetPath) {
  const dir = dirname(targetPath)
  await verifyDirectoryChain(dir)
  let dirStat
  try {
    dirStat = await lstat(dir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (dirStat) {
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`refusing symlink or non-directory cache directory: ${dir}`)
    }
    if ((dirStat.mode & 0o077) !== 0) {
      throw new Error(`refusing cache directory without user-only permissions: ${dir}`)
    }
  }

  let fileStat
  try {
    fileStat = await lstat(targetPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (fileStat) {
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`refusing symlink or non-regular cache target: ${targetPath}`)
    }
  }
  return { dirStat, fileStat }
}

async function atomicWriteCache(targetPath, bytes) {
  const dir = dirname(targetPath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await verifyDirectoryChain(dir)
  const dirStat = await lstat(dir)
  if ((dirStat.mode & 0o077) !== 0) {
    throw new Error(`refusing cache directory without user-only permissions: ${dir}`)
  }

  try {
    const check = await lstat(targetPath)
    if (check.isSymbolicLink() || !check.isFile()) {
      throw new Error(`refusing symlink or non-regular cache target: ${targetPath}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const temporary = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, targetPath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function publishAgyQuota(payload, options = {}) {
  const clock = options.clock || Date.now
  const now = clock()
  const normalized = normalizeAgyQuota(payload, { clock: () => now, fetched: now })
  if (!normalized) {
    return { published: false, unavailable: true, reason: 'quota_unavailable' }
  }

  const env = options.env || process.env
  if (options.cachePath !== undefined && (!isAbsolute(options.cachePath) || options.cachePath.includes('\0'))) {
    throw new Error('cachePath must be a non-empty absolute path')
  }
  if (options.cacheDir !== undefined && (!isAbsolute(options.cacheDir) || options.cacheDir.includes('\0'))) {
    throw new Error('cacheDir must be a non-empty absolute path')
  }
  const targetPath = options.cachePath
    ? resolvePath(options.cachePath)
    : join(options.cacheDir ? resolvePath(options.cacheDir) : usageCacheDir(env), DEFAULT_CACHE_FILENAME)

  await verifyCacheSafety(targetPath)

  const existing = await readUsageCache(targetPath, clock)
  if (existing) {
    const age = now - existing.fetched
    if (age >= 0 && age < DEDUPE_TTL_MS && areWindowsEqual(existing.windows, normalized.windows)) {
      return {
        published: false,
        skipped: true,
        reason: 'unchanged_within_dedupe_window',
        path: targetPath,
        windows: normalized.windows,
        refreshed: false
      }
    }
  }

  const content = Buffer.from(JSON.stringify(normalized, null, 2) + '\n')
  if (content.length > MAX_CACHE_BYTES) {
    throw new Error('normalized cache exceeds maximum allowed size')
  }

  await atomicWriteCache(targetPath, content)

  let refreshed = false
  let refreshError = null
  const shouldRefresh = options.refreshHerdr !== false && isRunningUnderHerdr(env)

  if (shouldRefresh) {
    try {
      // Internal deterministic-test seam only. Production callers use the
      // deadline-bounded core refresh path below.
      if (typeof options._refreshHerdrForTest === 'function') {
        await options._refreshHerdrForTest(env)
      } else {
        await refresh(env, { clock, deadline: now + COMMAND_TIMEOUT_MS })
      }
      refreshed = true
    } catch (error) {
      refreshError = error
    }
  }

  return {
    published: true,
    path: targetPath,
    windows: normalized.windows,
    refreshed,
    refreshError
  }
}

export const publishAgyStatusline = publishAgyQuota
