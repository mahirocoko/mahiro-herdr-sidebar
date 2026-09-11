import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const SOURCE = 'mahiro-herdr-sidebar.usage'
export const FRESH_MS = 5 * 60 * 1000
export const MAX_TARGETS = 128
export const OWNED_TOKENS = [
  'mahiro_sidebar_agy_scope',
  'mahiro_sidebar_q1_ok',
  'mahiro_sidebar_q1_warn',
  'mahiro_sidebar_q1_critical',
  'mahiro_sidebar_q2_ok',
  'mahiro_sidebar_q2_warn',
  'mahiro_sidebar_q2_critical'
]

const OWNER = 'mahiro-herdr-sidebar'
const MAX_CACHE_BYTES = 64 * 1024
const MAX_EVENT_BYTES = 64 * 1024
const MAX_ID_CHARS = 128
const MAX_OUTPUT_BYTES = 256 * 1024
const COMMAND_TIMEOUT_MS = 5 * 1000
const INVOCATION_DEADLINE_MS = 30 * 1000
const FRESHNESS_MARGIN_MS = 5 * 1000
const RESET_MARGIN_MS = 5 * 1000
const DELIVERY_HEADROOM_MS = 1000
const MIN_TIMESTAMP = Date.UTC(2020, 0, 1)
const MAX_RESET_AHEAD_MS = 370 * 24 * 60 * 60 * 1000
const MAX_U64 = (1n << 64n) - 1n
const EVENT_NAMES = new Set([
  'pane_focused',
  'pane_agent_detected',
  'pane_agent_status_changed'
])

const SIDEBAR_BLOCK = `# ${OWNER}:begin
[ui.sidebar.agents] # ${OWNER}:owner
row_gap = 0 # ${OWNER}:row-gap
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [{ token = "$mahiro_sidebar_model", fg = "#A5A8AB", dim = true }],
  [{ token = "$mahiro_sidebar_context", fg = "#BEBEEE" }],
  [{ token = "$mahiro_sidebar_agy_scope", fg = "#A5A8AB", dim = true }],
  [
    { token = "$mahiro_sidebar_q1_ok", fg = "#64CF64" },
    { token = "$mahiro_sidebar_q1_warn", fg = "#FEE19C" },
    { token = "$mahiro_sidebar_q1_critical", fg = "#F1689F" },
  ],
  [
    { token = "$mahiro_sidebar_q2_ok", fg = "#64CF64" },
    { token = "$mahiro_sidebar_q2_warn", fg = "#FEE19C" },
    { token = "$mahiro_sidebar_q2_critical", fg = "#F1689F" },
  ],
  [{ token = "$summary", fg = "#A5A8AB", dim = true }],
] # ${OWNER}:rows
# ${OWNER}:end
`

function pluginConfigDir(env = process.env) {
  if (!env.HERDR_PLUGIN_CONFIG_DIR) throw new Error('HERDR_PLUGIN_CONFIG_DIR is required')
  return resolvePath(env.HERDR_PLUGIN_CONFIG_DIR)
}

function herdrConfigPath(env = process.env) {
  return resolvePath(env.HERDR_CONFIG_PATH || join(env.HOME || homedir(), '.config', 'herdr', 'config.toml'))
}

export function usageCacheDir(env = process.env) {
  const override = env.MAHIRO_HERDR_USAGE_CACHE_DIR
  if (override !== undefined) {
    if (typeof override !== 'string' || override.length === 0 || !isAbsolute(override) || override.includes('\0')) {
      throw new Error('MAHIRO_HERDR_USAGE_CACHE_DIR must be a non-empty absolute path')
    }
    return resolvePath(override)
  }
  return resolvePath(env.HOME || homedir(), '.letta', 'mods', 'mahiro-usage')
}

async function atomicWrite(path, bytes, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, bytes, { mode })
    await chmod(temporary, mode)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function readOptional(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function parseOwnerRecord(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.nonce !== 'string' || parsed.nonce.length < 8 || parsed.nonce.length > 128) return null
    return parsed
  } catch {
    return null
  }
}

function processState(pid, kill = process.kill) {
  try {
    kill(pid, 0)
    return 'alive'
  } catch (error) {
    if (error.code === 'ESRCH') return 'dead'
    return 'ambiguous'
  }
}

async function readLockOwner(lockPath) {
  let entries
  try {
    entries = await readdir(lockPath, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (entries.length !== 1 || !entries[0].isFile() || !entries[0].name.startsWith('owner-') || !entries[0].name.endsWith('.json')) return null
  const ownerPath = join(lockPath, entries[0].name)
  const details = await lstat(ownerPath)
  if (!details.isFile() || details.isSymbolicLink() || details.size > 1024) return null
  const owner = parseOwnerRecord(await readFile(ownerPath))
  if (!owner || entries[0].name !== `owner-${owner.nonce}.json`) return null
  return { ...owner, ownerPath }
}

export async function acquireConfigLock(directory, options = {}) {
  const lockPath = join(resolvePath(directory), 'config.lock')
  const nonce = options.nonce || randomUUID()
  const pid = options.pid || process.pid
  const kill = options.kill || process.kill
  if (!/^[A-Za-z0-9-]{8,128}$/u.test(nonce)) throw new Error('invalid config lock nonce')
  const ownerPath = join(lockPath, `owner-${nonce}.json`)
  await mkdir(directory, { recursive: true })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false
    try {
      await mkdir(lockPath, { mode: 0o700 })
      created = true
      await atomicWrite(ownerPath, Buffer.from(JSON.stringify({ pid, nonce }) + '\n'), 0o600)
      let released = false
      return async () => {
        if (released) return false
        released = true
        try {
          await unlink(ownerPath)
        } catch (error) {
          if (error.code === 'ENOENT') return false
          throw error
        }
        try {
          await rmdir(lockPath)
          return true
        } catch {
          return false
        }
      }
    } catch (error) {
      if (created) {
        await unlink(ownerPath).catch(() => {})
        await rmdir(lockPath).catch(() => {})
      }
      if (error.code !== 'EEXIST') throw error
      const owner = await readLockOwner(lockPath)
      if (!owner) throw new Error('refusing to continue: config lock is ownerless or malformed')
      const state = processState(owner.pid, kill)
      if (state !== 'dead') throw new Error(`refusing to continue: config lock owner is ${state}`)
      try {
        await unlink(owner.ownerPath)
      } catch (unlinkError) {
        if (unlinkError.code === 'ENOENT') continue
        throw unlinkError
      }
      try {
        await rmdir(lockPath)
      } catch (removeError) {
        if (removeError.code === 'ENOENT') continue
        throw new Error('refusing to continue: dead config lock could not be removed safely')
      }
    }
  }
  throw new Error('refusing to continue: config lock contention')
}

async function withConfigLock(env, operation) {
  const release = await acquireConfigLock(pluginConfigDir(env))
  try {
    return await operation()
  } finally {
    await release()
  }
}

function decodeConfig(bytes) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) throw new Error('refusing configuration with invalid UTF-8 bytes')
  return text
}

export function hasAgentsOwner(config) {
  let table = ''
  for (const line of config.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[')) {
      if (trimmed.includes('\\')) return true
      const match = trimmed.match(/^\[{1,2}\s*([^\]]+?)\s*\]{1,2}(?:\s*#.*)?$/u)
      if (!match) return true
      table = match[1].replace(/[\s'"]/gu, '')
      if (table === 'ui.sidebar.agents' || table.startsWith('ui.sidebar.agents.')) return true
      if (table.includes('ui') && table.includes('sidebar') && table.includes('agents')) return true
      continue
    }

    const assignment = trimmed.match(/^([^=]+?)\s*=\s*(.*)$/u)
    if (!assignment) continue
    if (assignment[1].includes('\\')) return true
    const key = assignment[1].replace(/[\s'"]/gu, '')
    const fullKey = table ? `${table}.${key}` : key
    const compactValue = assignment[2].replace(/\s/gu, '')
    if (fullKey === 'ui.sidebar.agents' || fullKey.startsWith('ui.sidebar.agents.')) return true
    if (fullKey.includes('ui') && fullKey.includes('sidebar') && fullKey.includes('agents')) return true
    if ((fullKey === 'ui' || fullKey === 'ui.sidebar') && compactValue.startsWith('{')) return true
  }
  return false
}

async function inspectConfig(path) {
  let details
  try {
    details = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, mode: 0o600, bytes: Buffer.alloc(0) }
    throw error
  }
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Herdr config must be a regular non-symlink file')
  return { exists: true, mode: details.mode & 0o777, bytes: await readFile(path) }
}

function appliedBytes(original) {
  const text = decodeConfig(original)
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  return Buffer.from(`${text}${separator}${text.length === 0 ? '' : '\n'}${SIDEBAR_BLOCK}`)
}

function parseSnapshot(bytes, expectedPath) {
  let saved
  try {
    saved = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('invalid configuration ownership snapshot')
  }
  if (saved.owner !== OWNER || saved.configPath !== expectedPath || typeof saved.originalExists !== 'boolean' || saved.originalKind !== (saved.originalExists ? 'regular' : 'missing') || saved.appliedKind !== 'regular' || !Number.isInteger(saved.originalMode) || typeof saved.originalBase64 !== 'string' || typeof saved.appliedBase64 !== 'string') {
    throw new Error('invalid or path-mismatched configuration ownership snapshot')
  }
  return {
    ...saved,
    original: Buffer.from(saved.originalBase64, 'base64'),
    applied: Buffer.from(saved.appliedBase64, 'base64')
  }
}

function matchesState(current, exists, mode, bytes) {
  return current.exists === exists && (!exists || current.mode === mode) && current.bytes.equals(bytes)
}

async function configureUnlocked(env) {
  const path = herdrConfigPath(env)
  const statePath = join(pluginConfigDir(env), 'config-snapshots.json')
  const current = await inspectConfig(path)
  const savedBytes = await readOptional(statePath)

  if (savedBytes) {
    const saved = parseSnapshot(savedBytes, path)
    if (matchesState(current, true, saved.originalMode, saved.applied)) return
    if (!matchesState(current, saved.originalExists, saved.originalMode, saved.original)) {
      throw new Error('refusing to configure: Herdr config drifted from both known snapshots')
    }
    await atomicWrite(path, saved.applied, saved.originalMode)
    return
  }

  const text = decodeConfig(current.bytes)
  if (hasAgentsOwner(text)) throw new Error('refusing to configure: ui.sidebar.agents ownership is present or ambiguous')
  const applied = appliedBytes(current.bytes)
  const snapshot = Buffer.from(JSON.stringify({
    owner: OWNER,
    configPath: path,
    originalExists: current.exists,
    originalKind: current.exists ? 'regular' : 'missing',
    appliedKind: 'regular',
    originalMode: current.mode,
    originalBase64: current.bytes.toString('base64'),
    appliedBase64: applied.toString('base64')
  }, null, 2) + '\n')
  await atomicWrite(statePath, snapshot)
  await atomicWrite(path, applied, current.mode)
}

async function restorePreflightUnlocked(env) {
  const path = herdrConfigPath(env)
  const statePath = join(pluginConfigDir(env), 'config-snapshots.json')
  const savedBytes = await readOptional(statePath)
  const current = await inspectConfig(path)
  if (!savedBytes) {
    if (decodeConfig(current.bytes).includes(`${OWNER}:begin`)) throw new Error('ownership markers exist without recovery evidence')
    return { needed: false }
  }
  const saved = parseSnapshot(savedBytes, path)
  const applied = matchesState(current, true, saved.originalMode, saved.applied)
  const original = matchesState(current, saved.originalExists, saved.originalMode, saved.original)
  if (!applied && !original) throw new Error('Herdr config drifted from both known snapshots')
  return { needed: applied, saved, path, statePath }
}

export async function configure(env = process.env) {
  return withConfigLock(env, () => configureUnlocked(env))
}

export async function preflightRestoreConfig(env = process.env) {
  return withConfigLock(env, () => restorePreflightUnlocked(env))
}

export async function restoreConfig(env = process.env) {
  return withConfigLock(env, async () => {
    const plan = await restorePreflightUnlocked(env)
    if (!plan.saved) return false
    if (plan.needed) {
      if (plan.saved.originalExists) await atomicWrite(plan.path, plan.saved.original, plan.saved.originalMode)
      else await rm(plan.path, { force: true })
    }
    const restored = await inspectConfig(plan.path)
    if (!matchesState(restored, plan.saved.originalExists, plan.saved.originalMode, plan.saved.original)) {
      throw new Error('restored config did not match the original snapshot')
    }
    await rm(plan.statePath, { force: true })
    return true
  })
}

export async function captureConfigState(env = process.env) {
  return withConfigLock(env, async () => {
    const path = herdrConfigPath(env)
    const statePath = join(pluginConfigDir(env), 'config-snapshots.json')
    const config = await inspectConfig(path)
    const snapshot = await readOptional(statePath)
    if (snapshot) {
      const saved = parseSnapshot(snapshot, path)
      if (!matchesState(config, true, saved.originalMode, saved.applied) && !matchesState(config, saved.originalExists, saved.originalMode, saved.original)) {
        throw new Error('cannot capture configuration transaction: config drifted from recovery evidence')
      }
    }
    return { path, statePath, config, snapshot }
  })
}

export async function restoreCapturedConfigState(captured, env = process.env) {
  return withConfigLock(env, async () => {
    const path = herdrConfigPath(env)
    const statePath = join(pluginConfigDir(env), 'config-snapshots.json')
    if (!captured || captured.path !== path || captured.statePath !== statePath) {
      throw new Error('cannot roll back path-mismatched configuration transaction')
    }
    const current = await inspectConfig(path)
    const currentSnapshot = await readOptional(statePath)
    if (captured.snapshot) {
      const saved = parseSnapshot(captured.snapshot, path)
      const snapshotUnchanged = currentSnapshot?.equals(captured.snapshot) === true
      const safelyRestored = !currentSnapshot && matchesState(current, saved.originalExists, saved.originalMode, saved.original)
      if (!snapshotUnchanged && !safelyRestored) throw new Error('cannot roll back configuration transaction: recovery evidence drifted')
      if (snapshotUnchanged && !matchesState(current, true, saved.originalMode, saved.applied) && !matchesState(current, saved.originalExists, saved.originalMode, saved.original)) {
        throw new Error('cannot roll back configuration transaction: config drifted')
      }
    } else if (currentSnapshot) {
      const saved = parseSnapshot(currentSnapshot, path)
      if (!matchesState(saved.originalExists ? { exists: true, mode: saved.originalMode, bytes: saved.original } : { exists: false, mode: saved.originalMode, bytes: saved.original }, captured.config.exists, captured.config.mode, captured.config.bytes)) {
        throw new Error('cannot roll back configuration transaction: snapshot does not descend from captured state')
      }
      if (!matchesState(current, true, saved.originalMode, saved.applied) && !matchesState(current, saved.originalExists, saved.originalMode, saved.original)) {
        throw new Error('cannot roll back configuration transaction: config drifted')
      }
    } else if (!matchesState(current, captured.config.exists, captured.config.mode, captured.config.bytes)) {
      throw new Error('cannot roll back configuration transaction without recovery evidence')
    }

    if (captured.snapshot) await atomicWrite(statePath, captured.snapshot)
    if (captured.config.exists) await atomicWrite(path, captured.config.bytes, captured.config.mode)
    else await rm(path, { force: true })
    if (!captured.snapshot) await rm(statePath, { force: true })

    const restored = await inspectConfig(path)
    const restoredSnapshot = await readOptional(statePath)
    if (!matchesState(restored, captured.config.exists, captured.config.mode, captured.config.bytes) || (captured.snapshot ? !restoredSnapshot?.equals(captured.snapshot) : restoredSnapshot !== null)) {
      throw new Error('configuration transaction rollback postcondition failed')
    }
  })
}

export function sanitizeToken(value) {
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return Array.from(clean).slice(0, 80).join('')
}

export async function readUsageCache(path, clock = Date.now) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const details = await handle.stat()
    if (!details.isFile() || details.size > MAX_CACHE_BYTES) return null
    const buffer = Buffer.allocUnsafe(MAX_CACHE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const observedAt = clock()
    if (bytesRead > MAX_CACHE_BYTES) return null
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (!Number.isFinite(parsed.fetched) || parsed.fetched < MIN_TIMESTAMP || parsed.fetched > observedAt) return null
    const freshUntil = parsed.fetched + FRESH_MS - FRESHNESS_MARGIN_MS
    if (observedAt >= freshUntil || parsed.failed === true || !Array.isArray(parsed.windows)) return null
    const windows = parsed.windows.flatMap(window => {
      if (!window || typeof window.label !== 'string') return []
      if (!Number.isFinite(window.remaining) || window.remaining < 0 || window.remaining > 100) return []
      if (!Number.isFinite(window.reset) || window.reset < MIN_TIMESTAMP || window.reset > observedAt + MAX_RESET_AHEAD_MS) return []
      const label = sanitizeToken(window.label)
      if (label !== window.label) return []
      return [{ label, remaining: window.remaining, reset: window.reset }]
    })
    return { fetched: parsed.fetched, freshUntil, windows }
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EMLINK', 'ENXIO', 'EAGAIN'].includes(error.code) || error instanceof SyntaxError) return null
    throw error
  } finally {
    await handle?.close()
  }
}

function severity(remaining) {
  if (remaining < 20) return 'critical'
  if (remaining < 50) return 'warn'
  return 'ok'
}

function percent(value) {
  return `${Math.round(value)}%`
}

function usableWindow(cache, predicate, now) {
  return cache?.windows.find(window => predicate(window) && window.reset > now + RESET_MARGIN_MS + DELIVERY_HEADROOM_MS)
}

function quotaTokens(primary, secondary) {
  const tokens = {}
  const rows = [primary, secondary].filter(Boolean)
  rows.forEach((item, index) => {
    tokens[`mahiro_sidebar_q${index + 1}_${severity(item.remaining)}`] = sanitizeToken(item.text)
  })
  return tokens
}

function expiryFor(cache, windows) {
  if (!cache || windows.length === 0) return 0
  return Math.min(cache.freshUntil, ...windows.map(window => window.reset - RESET_MARGIN_MS))
}

export function agyMetadata(cache, now = Date.now()) {
  if (!cache) return { tokens: {}, expiresAt: 0 }
  const gemini5h = usableWindow(cache, item => item.label === 'Gemini:5h', now)
  const gemini7d = usableWindow(cache, item => item.label === 'Gemini:7d', now)
  const claude5h = usableWindow(cache, item => item.label === 'Claude-GPT:5h', now)
  const claude7d = usableWindow(cache, item => item.label === 'Claude-GPT:7d', now)
  const family = (name, fiveHour, sevenDay) => {
    const items = [fiveHour, sevenDay].filter(Boolean)
    if (items.length === 0) return null
    const value = fiveHour && sevenDay
      ? `5h/7d ${Math.round(fiveHour.remaining)}/${percent(sevenDay.remaining)}`
      : `${fiveHour ? '5h' : '7d'} ${percent((fiveHour || sevenDay).remaining)}`
    return { items, remaining: Math.min(...items.map(item => item.remaining)), text: `${name} ${value}` }
  }
  const primary = family('Gemini', gemini5h, gemini7d)
  const secondary = family('Claude-GPT', claude5h, claude7d)
  const displayed = [primary, secondary].filter(Boolean).flatMap(item => item.items)
  return displayed.length === 0
    ? { tokens: {}, expiresAt: 0 }
    : { tokens: { mahiro_sidebar_agy_scope: 'Agy shared pools', ...quotaTokens(primary, secondary) }, expiresAt: expiryFor(cache, displayed) }
}

export function codexMetadata(cache, now = Date.now()) {
  if (!cache) return { tokens: {}, expiresAt: 0 }
  const fiveHour = usableWindow(cache, item => item.label === 'P:5h', now)
  const sevenDay = usableWindow(cache, item => item.label === 'P:7d', now) || usableWindow(cache, item => item.label === 'S:7d', now)
  const primary = fiveHour && { remaining: fiveHour.remaining, text: `Codex 5h ${percent(fiveHour.remaining)}` }
  const secondary = sevenDay && { remaining: sevenDay.remaining, text: `Codex 7d ${percent(sevenDay.remaining)}` }
  const displayed = [fiveHour, sevenDay].filter(Boolean)
  return displayed.length === 0 ? { tokens: {}, expiresAt: 0 } : { tokens: quotaTokens(primary, secondary), expiresAt: expiryFor(cache, displayed) }
}

export function observeSequence() {
  const value = process.hrtime.bigint()
  if (value < 0n || value > MAX_U64) throw new Error('system monotonic sequence is outside Herdr u64 range')
  return value.toString()
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= MAX_ID_CHARS && !/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/u.test(value)
}

function decodedJsonKeys(raw) {
  const keys = []
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '"') continue
    const start = index
    let escaped = false
    index += 1
    for (; index < raw.length; index += 1) {
      if (raw[index] === '\\') {
        escaped = true
        index += 1
        continue
      }
      if (raw[index] === '"') break
    }
    if (index >= raw.length) return null
    let cursor = index + 1
    while (/\s/u.test(raw[cursor] || '')) cursor += 1
    if (raw[cursor] !== ':') continue
    try {
      keys.push({ name: JSON.parse(raw.slice(start, index + 1)), escaped })
    } catch {
      return null
    }
  }
  return keys
}

export function parsePluginEvent(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_EVENT_BYTES) return null
  const keys = decodedJsonKeys(raw)
  if (!keys) return null
  const routingKeys = new Set(['event', 'data', 'pane_id', 'workspace_id', 'type', 'agent_status'])
  if (keys.some(key => routingKeys.has(key.name) && key.escaped)) return null
  const keyCount = key => keys.filter(candidate => candidate.name === key).length
  if (keyCount('event') !== 1 || keyCount('data') !== 1 || keyCount('pane_id') !== 1 || keyCount('workspace_id') !== 1 || keyCount('type') > 1 || keyCount('agent_status') > 1) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || !EVENT_NAMES.has(parsed.event) || !parsed.data || !validId(parsed.data.pane_id) || !validId(parsed.data.workspace_id)) return null
  if (parsed.event === 'pane_agent_status_changed' && !validId(parsed.data.agent_status)) return null
  if (parsed.data.type !== undefined && parsed.data.type !== parsed.event) return null
  return { event: parsed.event, paneId: parsed.data.pane_id, workspaceId: parsed.data.workspace_id }
}

export function runHerdr(env, args, options = {}) {
  const clock = options.clock || Date.now
  const deadline = options.deadline ?? clock() + INVOCATION_DEADLINE_MS
  const remaining = Math.floor(deadline - clock())
  if (remaining <= 0) throw new Error('invocation deadline exhausted before Herdr command')
  const result = spawnSync(env.HERDR_BIN_PATH || 'herdr', args, {
    encoding: 'utf8',
    env,
    timeout: Math.min(COMMAND_TIMEOUT_MS, remaining),
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT_BYTES
  })
  if (result.error) throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${result.error.code || result.error.message}`)
  if (result.status !== 0) throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${sanitizeToken(result.stderr).slice(0, 200)}`)
  return result.stdout
}

function parseAgents(output) {
  const parsed = JSON.parse(output)
  if (!Array.isArray(parsed?.result?.agents)) throw new Error('unexpected herdr agent list response')
  return parsed.result.agents.filter(agent => agent && validId(agent.pane_id))
}

function liveAgy(agent) {
  const status = String(agent.agent_status || '').toLowerCase()
  return agent.agent === 'agy' && agent.launch_pending !== true && !['launching', 'pending', 'launch-pending'].includes(status) && agent.tokens?.launch_pending !== 'true'
}

function desiredFor(agent, caches, now) {
  if (liveAgy(agent)) return agyMetadata(caches.agy, now)
  if (agent.agent === 'letta' && agent.tokens?.mahiro_sidebar_provider === 'openai-codex') return codexMetadata(caches.codex, now)
  return { tokens: {}, expiresAt: 0 }
}

function metadataArgs(paneId, metadata, sequence, now) {
  let tokens = metadata.tokens
  let ttl = metadata.expiresAt - now - DELIVERY_HEADROOM_MS
  if (Object.keys(tokens).length > 0 && ttl <= 0) {
    tokens = {}
    ttl = 0
  }
  const args = ['pane', 'report-metadata', paneId, '--source', SOURCE]
  for (const name of OWNED_TOKENS) {
    if (Object.hasOwn(tokens, name)) args.push('--token', `${name}=${sanitizeToken(tokens[name])}`)
    else args.push('--clear-token', name)
  }
  const tokenFlags = args.filter(value => value === '--token' || value === '--clear-token')
  if (tokenFlags.length > 16) throw new Error('metadata token argument cap exceeded')
  args.push('--seq', sequence)
  if (ttl > 0) args.push('--ttl-ms', String(Math.floor(ttl)))
  return args
}

function dedupeAgents(agents) {
  const selected = new Map()
  for (const agent of agents) {
    if (!selected.has(agent.pane_id)) selected.set(agent.pane_id, agent)
    if (selected.size > MAX_TARGETS) throw new Error(`agent inventory exceeds the ${MAX_TARGETS}-pane refresh limit`)
  }
  return [...selected.values()]
}

async function reconcile(env, options = {}) {
  const clock = options.clock || Date.now
  const deadline = options.deadline ?? clock() + INVOCATION_DEADLINE_MS
  const sequence = String((options.sequence || observeSequence)())
  const numericSequence = BigInt(sequence)
  if (numericSequence < 0n || numericSequence > MAX_U64) throw new Error('sequence is outside Herdr u64 range')
  const agents = parseAgents(runHerdr(env, ['agent', 'list'], { clock, deadline }))
  const targets = options.targetPaneId
    ? agents.filter(agent => agent.pane_id === options.targetPaneId).slice(0, 1)
    : dedupeAgents(agents)
  if (targets.length === 0) return { reports: 0, sequence }

  const cacheRoot = usageCacheDir(env)
  const needsAgy = !options.clearOnly && targets.some(liveAgy)
  const needsCodex = !options.clearOnly && targets.some(agent => agent.agent === 'letta' && agent.tokens?.mahiro_sidebar_provider === 'openai-codex')
  const caches = {
    agy: needsAgy ? await readUsageCache(join(cacheRoot, 'agy.json'), clock) : null,
    codex: needsCodex ? await readUsageCache(join(cacheRoot, 'codex.json'), clock) : null
  }

  let reports = 0
  for (const agent of targets) {
    const now = clock()
    if (deadline - now <= DELIVERY_HEADROOM_MS) {
      throw new Error(`invocation deadline exhausted after ${reports}/${targets.length} reports`)
    }
    const metadata = options.clearOnly ? { tokens: {}, expiresAt: 0 } : desiredFor(agent, caches, now)
    const args = metadataArgs(agent.pane_id, metadata, sequence, now)
    runHerdr(env, args, { clock, deadline })
    reports += 1
  }
  return { reports, sequence }
}

export async function refresh(env = process.env, options = {}) {
  return reconcile(env, options)
}

export async function eventRefresh(env = process.env, options = {}) {
  const event = parsePluginEvent(options.rawEvent ?? env.HERDR_PLUGIN_EVENT_JSON)
  if (!event) return { reports: 0, invalidEvent: true }
  return reconcile(env, { ...options, targetPaneId: event.paneId })
}

export async function clearOwnedMetadata(env = process.env, options = {}) {
  return reconcile(env, { ...options, clearOnly: true })
}
