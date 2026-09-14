import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { agyMetadata, readUsageCache } from '../src/core.mjs'
import {
  BUCKET_MAPPINGS,
  DEDUPE_TTL_MS,
  DEFAULT_CACHE_FILENAME,
  isRunningUnderHerdr,
  normalizeAgyQuota,
  publishAgyQuota,
  publishAgyStatusline
} from '../src/agy-statusline-producer.mjs'

const roots = []

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mahiro-producer-')))
  roots.push(root)
  const cacheDir = join(root, 'usage')
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  return {
    root,
    cacheDir,
    cachePath: join(cacheDir, DEFAULT_CACHE_FILENAME),
    env: { HOME: root, MAHIRO_HERDR_USAGE_CACHE_DIR: cacheDir }
  }
}

function managedEnv(setup) {
  return { ...setup.env, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }
}

test.after(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

test('exact mapping and fixed output order', () => {
  const now = 1789300000000
  const payload = {
    quota: {
      '3p-weekly': { remaining_fraction: 0.95, reset_time: '2026-09-20T00:00:00Z' },
      'gemini-weekly': { remaining_fraction: 0.85, reset_time: '2026-09-20T00:00:00Z' },
      '3p-5h': { remaining_fraction: 0.75, reset_time: '2026-09-14T05:00:00Z' },
      'gemini-5h': { remaining_fraction: 0.65, reset_time: '2026-09-14T05:00:00Z' }
    }
  }

  const normalized = normalizeAgyQuota(payload, { clock: () => now })
  assert.ok(normalized)
  assert.equal(normalized.fetched, now)
  assert.equal(normalized.failed, false)
  assert.equal(normalized.windows.length, 4)

  assert.deepEqual(normalized.windows.map(w => w.label), [
    'Gemini:5h',
    'Gemini:7d',
    'Claude-GPT:5h',
    'Claude-GPT:7d'
  ])

  assert.equal(normalized.windows[0].remaining, 65)
  assert.equal(normalized.windows[1].remaining, 85)
  assert.equal(normalized.windows[2].remaining, 75)
  assert.equal(normalized.windows[3].remaining, 95)
})

test('fraction and reset validation with bounded reset_in_seconds fallback', () => {
  const now = 1789300000000

  // Valid fraction variations
  const fractions = normalizeAgyQuota({
    quota: {
      'gemini-5h': { remaining_fraction: 0.735, reset_in_seconds: 3600 },
      'gemini-weekly': { remaining_fraction: 0.0, reset_in_seconds: 3600 },
      '3p-5h': { remaining_fraction: 1.0, reset_in_seconds: 3600 }
    }
  }, { clock: () => now })
  assert.equal(fractions.windows[0].remaining, 73.5)
  assert.equal(fractions.windows[1].remaining, 0)
  assert.equal(fractions.windows[2].remaining, 100)

  // Invalid fraction skipped
  const invalidFraction = normalizeAgyQuota({
    quota: {
      'gemini-5h': { remaining_fraction: -0.1, reset_in_seconds: 3600 },
      'gemini-weekly': { remaining_fraction: 1.05, reset_in_seconds: 3600 },
      '3p-5h': { remaining_fraction: '0.5', reset_in_seconds: 3600 },
      '3p-weekly': { remaining_fraction: NaN, reset_in_seconds: 3600 }
    }
  }, { clock: () => now })
  assert.equal(invalidFraction, null)

  // ISO reset_time parsing
  const isoReset = normalizeAgyQuota({
    quota: {
      'gemini-5h': { remaining_fraction: 0.5, reset_time: '2026-09-14T03:00:00Z' }
    }
  }, { clock: () => now })
  assert.equal(isoReset.windows[0].reset, Date.parse('2026-09-14T03:00:00Z'))

  // Fallback to reset_in_seconds when reset_time is invalid or missing
  const fallbackReset = normalizeAgyQuota({
    quota: {
      'gemini-5h': { remaining_fraction: 0.5, reset_time: 'invalid-date', reset_in_seconds: 1800 },
      'gemini-weekly': { remaining_fraction: 0.5, reset_in_seconds: 7200 }
    }
  }, { clock: () => now })
  assert.equal(fallbackReset.windows[0].reset, now + 1800 * 1000)
  assert.equal(fallbackReset.windows[1].reset, now + 7200 * 1000)

  // Preference of valid reset_time over reset_in_seconds
  const preferTime = normalizeAgyQuota({
    quota: {
      'gemini-5h': { remaining_fraction: 0.5, reset_time: '2026-09-14T03:00:00Z', reset_in_seconds: 999999 }
    }
  }, { clock: () => now })
  assert.equal(preferTime.windows[0].reset, Date.parse('2026-09-14T03:00:00Z'))

  // Both invalid -> bucket ignored
  const bothInvalid = normalizeAgyQuota({
    quota: {
      'gemini-5h': { remaining_fraction: 0.5, reset_time: 'invalid', reset_in_seconds: -100 },
      'gemini-weekly': { remaining_fraction: 0.5, reset_time: null, reset_in_seconds: NaN }
    }
  }, { clock: () => now })
  assert.equal(bothInvalid, null)

  // Unknown buckets ignored
  const unknownIgnored = normalizeAgyQuota({
    quota: {
      'unknown-bucket': { remaining_fraction: 0.5, reset_in_seconds: 3600 },
      'gpt-5': { remaining_fraction: 0.8, reset_in_seconds: 3600 },
      'gemini-5h': { remaining_fraction: 0.5, reset_in_seconds: 3600 }
    }
  }, { clock: () => now })
  assert.equal(unknownIgnored.windows.length, 1)
  assert.equal(unknownIgnored.windows[0].label, 'Gemini:5h')
})

test('identity and raw-field exclusion', async () => {
  const setup = await fixture()
  const now = 1789300000000
  const payload = {
    user: { id: 'usr_secret123', email: 'confidential@example.com' },
    plan: { tier: 'enterprise', billing: 'active' },
    auth: { bearer: 'token-topsecret' },
    credentials: { key: 'sk-12345' },
    raw_response: { headers: { 'x-trace-id': 'xyz' } },
    quota: {
      'gemini-5h': {
        remaining_fraction: 0.8,
        reset_in_seconds: 3600,
        extra_private_field: 'leak-test'
      }
    }
  }

  const normalized = normalizeAgyQuota(payload, { clock: () => now })
  assert.deepEqual(Object.keys(normalized).sort(), ['failed', 'fetched', 'windows'])
  assert.deepEqual(Object.keys(normalized.windows[0]).sort(), ['label', 'remaining', 'reset'])

  const published = await publishAgyQuota(payload, {
    cachePath: setup.cachePath,
    clock: () => now
  })
  assert.equal(published.published, true)

  const rawFile = await readFile(setup.cachePath, 'utf8')
  assert.equal(rawFile.includes('confidential'), false)
  assert.equal(rawFile.includes('usr_secret'), false)
  assert.equal(rawFile.includes('enterprise'), false)
  assert.equal(rawFile.includes('topsecret'), false)
  assert.equal(rawFile.includes('leak-test'), false)

  const parsed = JSON.parse(rawFile)
  assert.deepEqual(Object.keys(parsed).sort(), ['failed', 'fetched', 'windows'])
  assert.deepEqual(Object.keys(parsed.windows[0]).sort(), ['label', 'remaining', 'reset'])
})

test('no-op preservation when quota is absent or invalid', async () => {
  const setup = await fixture()
  const now = 1789300000000
  const initialPayload = {
    quota: {
      'gemini-5h': { remaining_fraction: 0.9, reset_in_seconds: 3600 }
    }
  }

  await publishAgyQuota(initialPayload, {
    cachePath: setup.cachePath,
    clock: () => now
  })

  const baselineContent = await readFile(setup.cachePath, 'utf8')
  const baselineStat = await stat(setup.cachePath)

  for (const badPayload of [
    null,
    undefined,
    '',
    '{}',
    { other: 'field' },
    { quota: null },
    { quota: {} },
    { quota: { 'unknown-bucket': { remaining_fraction: 0.5, reset_in_seconds: 100 } } },
    { quota: { 'gemini-5h': { remaining_fraction: 2.0, reset_in_seconds: 100 } } }
  ]) {
    const result = await publishAgyQuota(badPayload, {
      cachePath: setup.cachePath,
      clock: () => now + 5000
    })
    assert.equal(result.published, false)
    assert.equal(result.unavailable, true)
    assert.equal(result.reason, 'quota_unavailable')
  }

  const currentContent = await readFile(setup.cachePath, 'utf8')
  const currentStat = await stat(setup.cachePath)
  assert.equal(currentContent, baselineContent)
  assert.equal(currentStat.mtimeMs, baselineStat.mtimeMs)
})

test('120-second deduplication skips redundant writes and refreshes', async () => {
  const setup = await fixture()
  const now = 1789300000000
  const payload = {
    quota: {
      'gemini-5h': { remaining_fraction: 0.8, reset_time: '2026-09-14T05:00:00Z', reset_in_seconds: 3600 }
    }
  }

  let refreshCalls = 0
  const spyRefresh = async () => {
    refreshCalls += 1
  }

  // Initial publication at T
  const first = await publishAgyQuota(payload, {
    cachePath: setup.cachePath,
    clock: () => now,
    _refreshHerdrForTest: spyRefresh,
    env: managedEnv(setup)
  })
  assert.equal(first.published, true)
  assert.equal(first.refreshed, true)
  assert.equal(refreshCalls, 1)

  const firstStat = await stat(setup.cachePath)

  // Redundant publication at T + 60s (< 120s)
  const second = await publishAgyQuota(payload, {
    cachePath: setup.cachePath,
    clock: () => now + 60 * 1000,
    _refreshHerdrForTest: spyRefresh,
    env: managedEnv(setup)
  })
  assert.equal(second.published, false)
  assert.equal(second.skipped, true)
  assert.equal(second.reason, 'unchanged_within_dedupe_window')
  assert.equal(second.refreshed, false)
  assert.equal(refreshCalls, 1) // No new refresh call!

  const secondStat = await stat(setup.cachePath)
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs)
})

test('fallback-only reset countdown dedupes semantically within 120 seconds', async () => {
  const setup = await fixture()
  const now = 1789300000000
  const payload = {
    quota: {
      'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 3600 }
    }
  }
  let refreshCalls = 0
  const refreshHerdr = async () => { refreshCalls += 1 }

  await publishAgyQuota(payload, {
    cachePath: setup.cachePath,
    clock: () => now,
    _refreshHerdrForTest: refreshHerdr,
    env: managedEnv(setup)
  })
  const baseline = await readFile(setup.cachePath)

  const second = await publishAgyQuota(payload, {
    cachePath: setup.cachePath,
    clock: () => now + 60_000,
    _refreshHerdrForTest: refreshHerdr,
    env: managedEnv(setup)
  })
  assert.equal(second.skipped, true)
  assert.equal(refreshCalls, 1)
  assert.deepEqual(await readFile(setup.cachePath), baseline)
})

test('changed write and aged write trigger publication and refresh', async () => {
  const setup = await fixture()
  const now = 1789300000000
  const payload1 = {
    quota: {
      'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 3600 }
    }
  }
  const payloadChanged = {
    quota: {
      'gemini-5h': { remaining_fraction: 0.5, reset_in_seconds: 3600 }
    }
  }

  let refreshCalls = 0
  const spyRefresh = async () => {
    refreshCalls += 1
  }

  // Initial write at T
  await publishAgyQuota(payload1, {
    cachePath: setup.cachePath,
    clock: () => now,
    _refreshHerdrForTest: spyRefresh,
    env: managedEnv(setup)
  })
  assert.equal(refreshCalls, 1)

  // Changed write at T + 50s (< 120s, but changed remaining)
  const changed = await publishAgyQuota(payloadChanged, {
    cachePath: setup.cachePath,
    clock: () => now + 50 * 1000,
    _refreshHerdrForTest: spyRefresh,
    env: managedEnv(setup)
  })
  assert.equal(changed.published, true)
  assert.equal(changed.refreshed, true)
  assert.equal(refreshCalls, 2)
  const cacheAfterChange = await readUsageCache(setup.cachePath, () => now + 50 * 1000)
  assert.equal(cacheAfterChange.windows[0].remaining, 50)

  // Aged write at T + 50s + 125s (>= 120s, identical windows to previous write)
  const agedTime = now + 50 * 1000 + 125 * 1000
  const aged = await publishAgyQuota(payloadChanged, {
    cachePath: setup.cachePath,
    clock: () => agedTime,
    _refreshHerdrForTest: spyRefresh,
    env: managedEnv(setup)
  })
  assert.equal(aged.published, true)
  assert.equal(aged.refreshed, true)
  assert.equal(refreshCalls, 3)
  const cacheAfterAged = await readUsageCache(setup.cachePath, () => agedTime)
  assert.equal(cacheAfterAged.fetched, agedTime)
})

test('mode, path, and symlink safety', async () => {
  const setup = await fixture()
  const now = 1789300000000
  const payload = {
    quota: {
      'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 3600 }
    }
  }

  // Permissions check on regular publish
  await publishAgyQuota(payload, {
    cachePath: setup.cachePath,
    clock: () => now
  })
  const fileStat = await stat(setup.cachePath)
  assert.equal(fileStat.mode & 0o777, 0o600)
  const dirStat = await stat(setup.cacheDir)
  assert.equal(dirStat.mode & 0o777, 0o700)

  // Refuse symlink target
  const symlinkPath = join(setup.cacheDir, 'symlink-target.json')
  const dummyFile = join(setup.cacheDir, 'dummy.json')
  await writeFile(dummyFile, '{}')
  await symlink(dummyFile, symlinkPath)
  await assert.rejects(
    publishAgyQuota(payload, { cachePath: symlinkPath, clock: () => now }),
    /refusing symlink or non-regular/
  )

  // Refuse non-regular target (directory target)
  const dirTargetPath = join(setup.cacheDir, 'sub-dir.json')
  await mkdir(dirTargetPath)
  await assert.rejects(
    publishAgyQuota(payload, { cachePath: dirTargetPath, clock: () => now }),
    /refusing symlink or non-regular/
  )

  // Refuse symlink cache directory
  const symlinkDir = join(setup.root, 'symlink-dir')
  await symlink(setup.cacheDir, symlinkDir)
  const fileInsideSymlinkDir = join(symlinkDir, 'agy.json')
  await assert.rejects(
    publishAgyQuota(payload, { cachePath: fileInsideSymlinkDir, clock: () => now }),
    /refusing symlink or non-directory/
  )

  const realAncestor = join(setup.root, 'real-ancestor')
  const linkedAncestor = join(setup.root, 'linked-ancestor')
  await mkdir(realAncestor, { mode: 0o700 })
  await symlink(realAncestor, linkedAncestor)
  await assert.rejects(
    publishAgyQuota(payload, { cachePath: join(linkedAncestor, 'nested', 'agy.json'), clock: () => now }),
    /cache path component/
  )

  // Refuse shared parent directories instead of changing their permissions.
  const sharedDir = join(setup.root, 'shared-dir')
  await mkdir(sharedDir, { mode: 0o755 })
  const sharedMode = (await stat(sharedDir)).mode & 0o777
  await assert.rejects(
    publishAgyQuota(payload, { cachePath: join(sharedDir, 'agy.json'), clock: () => now }),
    /without user-only permissions/
  )
  assert.equal((await stat(sharedDir)).mode & 0o777, sharedMode)

  await assert.rejects(
    publishAgyQuota(payload, { cachePath: 'relative/agy.json', clock: () => now }),
    /absolute path/
  )
})

test('Herdr detection requires the exact managed-pane contract', () => {
  assert.equal(isRunningUnderHerdr({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }), true)
  assert.equal(isRunningUnderHerdr({ HERDR_ENV: '1' }), false)
  assert.equal(isRunningUnderHerdr({ HERDR_PANE_ID: 'w1:p1' }), false)
  assert.equal(isRunningUnderHerdr({ HERDR_PLUGIN_ROOT: '/tmp/plugin' }), false)
})

test('refresh cannot be forced outside the exact managed-pane environment', async () => {
  const setup = await fixture()
  const now = 1789300000000
  let refreshCalls = 0
  const result = await publishAgyQuota({
    quota: { 'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 3600 } }
  }, {
    cachePath: setup.cachePath,
    clock: () => now,
    env: {},
    runningUnderHerdr: true,
    _refreshHerdrForTest: async () => { refreshCalls += 1 }
  })
  assert.equal(result.published, true)
  assert.equal(result.refreshed, false)
  assert.equal(refreshCalls, 0)
})

test('exactly one refresh triggered on valid write', async () => {
  const setup = await fixture()
  const now = 1789300000000
  const payload = {
    quota: {
      'gemini-5h': { remaining_fraction: 0.8, reset_time: '2026-09-14T05:00:00Z', reset_in_seconds: 3600 }
    }
  }

  let calls = 0
  const refresh = async () => {
    calls += 1
  }

  await publishAgyQuota(payload, {
    cachePath: setup.cachePath,
    clock: () => now,
    _refreshHerdrForTest: refresh,
    env: managedEnv(setup)
  })
  assert.equal(calls, 1)

  // Redundant write triggers 0 refreshes
  await publishAgyQuota(payload, {
    cachePath: setup.cachePath,
    clock: () => now + 10_000,
    _refreshHerdrForTest: refresh,
    env: managedEnv(setup)
  })
  assert.equal(calls, 1)
})

test('cache publication success survives Herdr refresh failure', async () => {
  const setup = await fixture()
  const now = 1789300000000
  const payload = {
    quota: {
      'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 3600 }
    }
  }

  const failingRefresh = async () => {
    throw new Error('injected Herdr refresh failure')
  }

  const result = await publishAgyQuota(payload, {
    cachePath: setup.cachePath,
    clock: () => now,
    _refreshHerdrForTest: failingRefresh,
    env: managedEnv(setup)
  })

  assert.equal(result.published, true)
  assert.equal(result.refreshed, false)
  assert.ok(result.refreshError)
  assert.match(result.refreshError.message, /injected Herdr refresh failure/)

  // Cache file is intact despite refresh failure
  const cache = await readUsageCache(setup.cachePath, () => now)
  assert.ok(cache)
  assert.equal(cache.windows[0].remaining, 80)
})

test('concurrent publication validity preserves an atomic winner', async () => {
  const setup = await fixture()
  const now = 1789300000000

  const runs = Array.from({ length: 20 }, (_, index) => {
    const fraction = (index + 1) / 25
    const payload = {
      quota: {
        'gemini-5h': { remaining_fraction: fraction, reset_in_seconds: 3600 },
        'gemini-weekly': { remaining_fraction: 0.9, reset_in_seconds: 7200 }
      }
    }
    return publishAgyQuota(payload, {
      cachePath: setup.cachePath,
      clock: () => now + index
    })
  })

  const results = await Promise.allSettled(runs)
  for (const result of results) {
    assert.equal(result.status, 'fulfilled')
  }

  const fileStat = await lstat(setup.cachePath)
  assert.equal(fileStat.isFile(), true)
  assert.equal(fileStat.isSymbolicLink(), false)
  assert.equal(fileStat.mode & 0o777, 0o600)

  const content = await readFile(setup.cachePath, 'utf8')
  const parsed = JSON.parse(content)
  assert.equal(parsed.failed, false)
  assert.ok(Array.isArray(parsed.windows))
  assert.equal(parsed.windows.length, 2)
  assert.equal(parsed.windows[0].label, 'Gemini:5h')
  assert.equal(parsed.windows[1].label, 'Gemini:7d')
})

test('end-to-end compatibility with readUsageCache and agyMetadata', async () => {
  const setup = await fixture()
  const now = 1789300000000
  const payload = {
    quota: {
      'gemini-5h': { remaining_fraction: 0.72, reset_time: '2026-09-14T05:00:00Z' },
      'gemini-weekly': { remaining_fraction: 0.88, reset_time: '2026-09-20T00:00:00Z' },
      '3p-5h': { remaining_fraction: 0.45, reset_time: '2026-09-14T05:00:00Z' },
      '3p-weekly': { remaining_fraction: 0.92, reset_time: '2026-09-20T00:00:00Z' }
    }
  }

  const publishResult = await publishAgyStatusline(payload, {
    cachePath: setup.cachePath,
    clock: () => now
  })
  assert.equal(publishResult.published, true)

  const cache = await readUsageCache(setup.cachePath, () => now)
  assert.ok(cache)
  assert.equal(cache.windows.length, 4)

  const metadata = agyMetadata(cache, now)
  assert.equal(metadata.tokens.mahiro_sidebar_agy_scope, 'Agy shared pools')
  assert.ok(metadata.tokens.mahiro_sidebar_q1_ok)
  assert.match(metadata.tokens.mahiro_sidebar_q1_ok, /Gemini 5h\/7d 72\/88%/)
  assert.ok(metadata.tokens.mahiro_sidebar_q2_warn)
  assert.match(metadata.tokens.mahiro_sidebar_q2_warn, /Claude-GPT 5h\/7d 45\/92%/)
  assert.ok(metadata.expiresAt > now)
})
