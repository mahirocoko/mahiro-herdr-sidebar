import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MAX_TARGETS,
  OWNED_TOKENS,
  acquireConfigLock,
  codexMetadata,
  configure,
  eventRefresh,
  hasAgentsOwner,
  parsePluginEvent,
  readUsageCache,
  refresh,
  restoreConfig
} from '../src/core.mjs'
import { configureLive, installWorkflow, restoreLive, uninstallWorkflow } from '../src/workflows.mjs'

const roots = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mahiro-sidebar-'))
  roots.push(root)
  const home = join(root, 'home')
  const pluginConfig = join(root, 'plugin-config')
  const herdrConfig = join(root, 'herdr', 'config.toml')
  const cache = join(home, '.letta', 'mods', 'mahiro-usage')
  await Promise.all([
    mkdir(pluginConfig, { recursive: true }),
    mkdir(join(root, 'herdr'), { recursive: true }),
    mkdir(cache, { recursive: true })
  ])
  return {
    root,
    home,
    pluginConfig,
    herdrConfig,
    cache,
    env: {
      ...process.env,
      HOME: home,
      HERDR_PLUGIN_CONFIG_DIR: pluginConfig,
      HERDR_CONFIG_PATH: herdrConfig
    }
  }
}

test.after(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

async function writeCache(path, windows, fetched, extra = {}) {
  await writeFile(path, JSON.stringify({ windows, fetched, failed: false, ...extra }))
}

async function stubHerdr(setup, agents = [], plugins = []) {
  const executable = join(setup.root, 'herdr-stub.mjs')
  const log = join(setup.root, 'herdr.log')
  const inventory = join(setup.root, 'inventory.json')
  const registry = join(setup.root, 'registry.json')
  const failures = join(setup.root, 'failures.json')
  await writeFile(inventory, JSON.stringify({ id: 'cli:agent:list', result: { agents } }))
  await writeFile(registry, JSON.stringify({ plugins }))
  await writeFile(failures, JSON.stringify([]))
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args.join(' ')
appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + '\\n')
const failures = JSON.parse(readFileSync(process.env.HERDR_TEST_FAILURES, 'utf8'))
const failure = failures.find(item => item.remaining > 0 && command.includes(item.needle))
if (failure) {
  failure.remaining -= 1
  writeFileSync(process.env.HERDR_TEST_FAILURES, JSON.stringify(failures))
  if (!failure.afterMutation) {
    process.stderr.write('injected failure')
    process.exit(1)
  }
}
if (args[0] === 'agent' && args[1] === 'list') {
  if (process.env.HERDR_TEST_CACHE_PATH && process.env.HERDR_TEST_CACHE_CONTENT) writeFileSync(process.env.HERDR_TEST_CACHE_PATH, process.env.HERDR_TEST_CACHE_CONTENT)
  process.stdout.write(readFileSync(process.env.HERDR_TEST_INVENTORY, 'utf8'))
} else if (args[0] === 'plugin' && args[1] === 'list') {
  process.stdout.write(readFileSync(process.env.HERDR_TEST_REGISTRY, 'utf8'))
} else if (args[0] === 'plugin' && args[1] === 'config-dir') {
  process.stdout.write(process.env.HERDR_TEST_PLUGIN_CONFIG + '\\n')
} else if (args[0] === 'plugin') {
  const state = JSON.parse(readFileSync(process.env.HERDR_TEST_REGISTRY, 'utf8'))
  if (args[1] === 'link') state.plugins.push({ id: 'mahiro-herdr-sidebar', root: args[2], enabled: !args.includes('--disabled') })
  const plugin = state.plugins.find(item => (item.id || item.plugin_id) === 'mahiro-herdr-sidebar')
  if (args[1] === 'enable' && plugin) plugin.enabled = true
  if (args[1] === 'disable' && plugin) plugin.enabled = false
  if (args[1] === 'unlink') {
    state.plugins = state.plugins.filter(item => item.id !== 'mahiro-herdr-sidebar')
    if (failure?.replacementRoot) state.plugins.push({ id: 'mahiro-herdr-sidebar', root: failure.replacementRoot, enabled: true })
  }
  writeFileSync(process.env.HERDR_TEST_REGISTRY, JSON.stringify(state))
}
if (failure?.afterMutation) {
  process.stderr.write('injected post-mutation failure')
  process.exit(1)
}
`)
  await chmod(executable, 0o755)
  return {
    log,
    inventory,
    registry,
    failures,
    env: {
      ...setup.env,
      HERDR_BIN_PATH: executable,
      HERDR_TEST_LOG: log,
      HERDR_TEST_INVENTORY: inventory,
      HERDR_TEST_REGISTRY: registry,
      HERDR_TEST_FAILURES: failures,
      HERDR_TEST_PLUGIN_CONFIG: setup.pluginConfig
    }
  }
}

async function calls(path) {
  try {
    const text = await readFile(path, 'utf8')
    return text.trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function reportCalls(entries) {
  return entries.filter(call => call[0] === 'pane' && call[1] === 'report-metadata')
}

function agent(paneId, type, tokens = {}, extra = {}) {
  return { pane_id: paneId, workspace_id: paneId.split(':')[0], agent: type, tokens, ...extra }
}

function validEvent(event, paneId = 'w1:p1') {
  return JSON.stringify({ event, data: { type: event, pane_id: paneId, workspace_id: 'w1', agent_status: 'working' } })
}

test('invalid and decoded-key-ambiguous events make zero Herdr calls', async () => {
  const setup = await fixture()
  const stub = await stubHerdr(setup, [agent('w1:p1', 'agy')])
  for (const raw of [undefined, '', '{}', validEvent('pane_unknown'), JSON.stringify({ event: 'pane_focused', data: { workspace_id: 'w1' } }), 'x'.repeat(64 * 1024 + 1), '{"event":"pane_focused","event":"pane_agent_detected","data":{"pane_id":"w1:p1","workspace_id":"w1"}}', '{"event":"pane_focused","data":{"pane_id":"wrong","pane\\u005fid":"w1:p1","workspace_id":"w1"}}', '{"event":"pane_focused","data":{"pane\\u005fid":"w1:p1","workspace_id":"w1"}}', JSON.stringify({ event: 'pane_focused', data: { type: 'pane_agent_detected', pane_id: 'w1:p1', workspace_id: 'w1' } }), JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', workspace_id: 'w1' } })]) {
    assert.equal((await eventRefresh(stub.env, { rawEvent: raw })).invalidEvent, true)
  }
  assert.deepEqual(await calls(stub.log), [])
})

test('each exact event reconciles only its explicit inventory-backed pane', async () => {
  const setup = await fixture()
  const now = Date.now()
  const stub = await stubHerdr(setup, [agent('w1:p1', 'other'), agent('w1:p2', 'other')])
  for (const event of ['pane_focused', 'pane_agent_detected', 'pane_agent_status_changed']) {
    await writeFile(stub.log, '')
    await eventRefresh(stub.env, { rawEvent: validEvent(event, 'w1:p2'), clock: () => now, sequence: () => '10' })
    const entries = await calls(stub.log)
    assert.equal(entries.filter(call => call[0] === 'agent').length, 1)
    assert.deepEqual(reportCalls(entries).map(call => call[2]), ['w1:p2'])
  }
  await writeFile(stub.log, '')
  await eventRefresh(stub.env, { rawEvent: validEvent('pane_focused', 'missing'), clock: () => now, sequence: () => '11' })
  assert.equal(reportCalls(await calls(stub.log)).length, 0)
})

test('full refresh is stateless, dedupes panes, and republishes every invocation', async () => {
  const setup = await fixture()
  const now = Date.now()
  const stub = await stubHerdr(setup, [agent('w1:p1', 'other'), agent('w1:p1', 'other'), agent('w1:p2', 'other')])
  await refresh(stub.env, { clock: () => now, sequence: () => '20' })
  await refresh(stub.env, { clock: () => now, sequence: () => '21' })
  const entries = await calls(stub.log)
  assert.equal(entries.filter(call => call[0] === 'agent').length, 2)
  assert.equal(reportCalls(entries).length, 4)
  assert.equal(entries.some(call => call.some(value => String(value).includes('refresh-state'))), false)
})

test('provider loss receives a complete all-clear patch', async () => {
  const setup = await fixture()
  const now = Date.now()
  const codex = agent('w1:p1', 'letta', { mahiro_sidebar_provider: 'openai-codex' })
  const stub = await stubHerdr(setup, [codex])
  await writeCache(join(setup.cache, 'codex.json'), [{ label: 'S:7d', remaining: 30, reset: now + 60_000 }], now)
  await refresh(stub.env, { clock: () => now, sequence: () => '30' })
  await writeFile(stub.inventory, JSON.stringify({ id: 'cli:agent:list', result: { agents: [agent('w1:p1', 'letta', { mahiro_sidebar_provider: 'anthropic' })] } }))
  await refresh(stub.env, { clock: () => now, sequence: () => '31' })
  const report = reportCalls(await calls(stub.log)).at(-1)
  assert.equal(report.filter(value => value === '--clear-token').length, OWNED_TOKENS.length)
  assert.equal(report.includes('--token'), false)
})

test('same token text with a shorter reset republishes a shorter TTL', async () => {
  const setup = await fixture()
  const now = Date.now()
  const stub = await stubHerdr(setup, [agent('w1:p1', 'letta', { mahiro_sidebar_provider: 'openai-codex' })])
  await writeCache(join(setup.cache, 'codex.json'), [{ label: 'S:7d', remaining: 30, reset: now + 90_000 }], now)
  await refresh(stub.env, { clock: () => now, sequence: () => '40' })
  await writeCache(join(setup.cache, 'codex.json'), [{ label: 'S:7d', remaining: 30, reset: now + 60_000 }], now)
  await refresh(stub.env, { clock: () => now, sequence: () => '41' })
  const reports = reportCalls(await calls(stub.log))
  const ttl = report => Number(report[report.indexOf('--ttl-ms') + 1])
  assert.equal(reports.length, 2)
  assert.ok(ttl(reports[1]) < ttl(reports[0]))
  assert.ok(reports[1].includes('--token') && reports[1].some(value => String(value).startsWith('mahiro_sidebar_q1_warn=Codex 7d 30%')), 'a lone exact Codex 7d window must occupy the first visible quota row')
})

test('Codex P seven-day window wins over S regardless of cache order', () => {
  const now = Date.now()
  const cache = {
    freshUntil: now + 120_000,
    windows: [
      { label: 'S:7d', remaining: 10, reset: now + 90_000 },
      { label: 'P:7d', remaining: 80, reset: now + 60_000 }
    ]
  }
  const metadata = codexMetadata(cache, now)
  assert.equal(metadata.tokens.mahiro_sidebar_q1_ok, 'Codex 7d 80%')
  assert.equal(metadata.expiresAt, now + 55_000)
})

test('observation sequences are invocation-wide u64 values and preserve order', async () => {
  const setup = await fixture()
  const now = Date.now()
  const stub = await stubHerdr(setup, [agent('w1:p1', 'other'), agent('w1:p2', 'other')])
  const stale = await refresh(stub.env, { clock: () => now, sequence: () => '100' })
  const newer = await refresh(stub.env, { clock: () => now, sequence: () => '200' })
  assert.ok(BigInt(stale.sequence) < BigInt(newer.sequence))
  const reports = reportCalls(await calls(stub.log))
  assert.deepEqual(reports.slice(0, 2).map(report => report[report.indexOf('--seq') + 1]), ['100', '100'])
  assert.deepEqual(reports.slice(2).map(report => report[report.indexOf('--seq') + 1]), ['200', '200'])
})

test('system monotonic sequences order separate processes', () => {
  const moduleUrl = new URL('../src/core.mjs', import.meta.url).href
  const readSequence = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { observeSequence } from '${moduleUrl}'\nprocess.stdout.write(observeSequence())`], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    return BigInt(result.stdout)
  }
  assert.ok(readSequence() < readSequence())
})

test('cache written during inventory is accepted and only needed family is read', async () => {
  const setup = await fixture()
  const now = Date.now()
  const stub = await stubHerdr(setup, [agent('w1:p1', 'letta', { mahiro_sidebar_provider: 'openai-codex' })])
  const path = join(setup.cache, 'codex.json')
  stub.env.HERDR_TEST_CACHE_PATH = path
  stub.env.HERDR_TEST_CACHE_CONTENT = JSON.stringify({ fetched: now, failed: false, windows: [{ label: 'S:7d', remaining: 44, reset: now + 60_000 }] })
  await refresh(stub.env, { clock: () => now, sequence: () => '300' })
  const report = reportCalls(await calls(stub.log))[0]
  assert.ok(report.some(value => String(value).includes('Codex 7d 44%')))
  await assert.rejects(readFile(join(setup.cache, 'agy.json')), error => error.code === 'ENOENT')
})

test('full refresh rejects oversized inventory and fails explicitly on an exhausted deadline', async () => {
  const setup = await fixture()
  const agents = Array.from({ length: MAX_TARGETS + 10 }, (_, index) => agent(`w${index}:p1`, 'other'))
  const stub = await stubHerdr(setup, agents)
  await assert.rejects(refresh(stub.env, { clock: () => 1000, deadline: 30_000, sequence: () => '400' }), /exceeds the 128-pane/u)
  assert.equal(reportCalls(await calls(stub.log)).length, 0)

  await writeFile(stub.inventory, JSON.stringify({ id: 'cli:agent:list', result: { agents: [agent('w1:p1', 'other')] } }))
  await writeFile(stub.log, '')
  const times = [1000, 29_500]
  await assert.rejects(refresh(stub.env, { clock: () => times.shift() ?? 29_500, deadline: 30_000, sequence: () => '401' }), /deadline exhausted/u)
  assert.equal(reportCalls(await calls(stub.log)).length, 0)
})

test('every report uses exactly one set-or-clear decision per owned token', async () => {
  const setup = await fixture()
  const now = Date.now()
  const stub = await stubHerdr(setup, [agent('w1:p1', 'agy', {}, { agent_status: 'working' })])
  await writeCache(join(setup.cache, 'agy.json'), [
    { label: 'Gemini:5h', remaining: 80, reset: now + 60_000 },
    { label: 'Gemini:7d', remaining: 70, reset: now + 70_000 },
    { label: 'Claude-GPT:5h', remaining: 40, reset: now + 80_000 },
    { label: 'Claude-GPT:7d', remaining: 10, reset: now + 90_000 }
  ], now)
  await refresh(stub.env, { clock: () => now, sequence: () => '500' })
  const report = reportCalls(await calls(stub.log))[0]
  assert.deepEqual(report.slice(0, 5), ['pane', 'report-metadata', 'w1:p1', '--source', 'mahiro-herdr-sidebar.usage'])
  assert.equal(report.filter(value => value === '--token' || value === '--clear-token').length, OWNED_TOKENS.length)
  for (const name of OWNED_TOKENS) {
    const sets = report.filter((value, index) => report[index - 1] === '--token' && String(value).startsWith(`${name}=`)).length
    const clears = report.filter((value, index) => report[index - 1] === '--clear-token' && value === name).length
    assert.equal(sets + clears, 1, name)
  }
})

test('cache reads reject FIFO, symlink, oversize, and timestamps validated after read', async () => {
  const setup = await fixture()
  const now = Date.now()
  const path = join(setup.cache, 'codex.json')
  const target = join(setup.cache, 'target.json')
  await writeCache(target, [], now)
  await symlink(target, path)
  assert.equal(await readUsageCache(path, () => now), null)
  await rm(path)
  await writeFile(path, 'x'.repeat(64 * 1024 + 1))
  assert.equal(await readUsageCache(path, () => now), null)
  await rm(path)
  const fifo = spawnSync('mkfifo', [path])
  assert.equal(fifo.status, 0)
  assert.equal(await readUsageCache(path, () => now), null)
  await rm(path)
  await writeCache(path, [], now + 1)
  assert.equal(await readUsageCache(path, () => now), null)
})

test('cache null and other valid non-object JSON are unavailable', async () => {
  const setup = await fixture()
  const path = join(setup.cache, 'codex.json')
  for (const value of ['null', '[]', 'true', '42', '"text"']) {
    await writeFile(path, value)
    assert.equal(await readUsageCache(path), null)
  }
})

test('cache labels must match the accepted protocol before sanitization', async () => {
  const setup = await fixture()
  const now = Date.now()
  const path = join(setup.cache, 'codex.json')
  await writeCache(path, [
    { label: ' P:7d ', remaining: 10, reset: now + 60_000 },
    { label: 'P:5h', remaining: 75, reset: now + 60_000 }
  ], now)
  const cache = await readUsageCache(path, () => now)
  assert.deepEqual(cache.windows.map(window => window.label), ['P:5h'])
})

test('absolute cache override is normalized and used without reading the default', async () => {
  const setup = await fixture()
  const now = Date.now()
  const override = join(setup.root, 'cache', '..', 'public-cache')
  await mkdir(join(setup.root, 'public-cache'), { recursive: true })
  await writeCache(join(setup.root, 'public-cache', 'codex.json'), [{ label: 'P:5h', remaining: 75, reset: now + 60_000 }], now)
  const stub = await stubHerdr(setup, [agent('w1:p1', 'letta', { mahiro_sidebar_provider: 'openai-codex' })])
  stub.env.MAHIRO_HERDR_USAGE_CACHE_DIR = override
  await refresh(stub.env, { clock: () => now, sequence: () => '450' })
  assert.ok(reportCalls(await calls(stub.log))[0].some(value => String(value).includes('Codex 5h 75%')))
  stub.env.MAHIRO_HERDR_USAGE_CACHE_DIR = 'relative-cache'
  await assert.rejects(refresh(stub.env, { clock: () => now, sequence: () => '451' }), /absolute path/u)
})

test('TOML guard rejects equivalent, descendant, escaped, and ambiguous owner forms', () => {
  for (const header of [
    '[ ui.sidebar.agents ]',
    '[ ui . sidebar . agents ]',
    '["ui"."sidebar"."agents"]',
    "['ui'.'sidebar'.'agents'.'rows_by_agent']",
    '[ui.sidebar.agents.rows_by_agent]',
    '["u\\u0069"."sidebar"."agents"]',
    '[ ui / sidebar / agents ]',
    'ui.sidebar.agents = { rows = [["agent"]] }',
    '[ui.sidebar]\nagents = { rows = [["agent"]] }',
    '[ui]\nsidebar.agents = { rows = [["agent"]] }',
    'ui.sidebar = { agents = { rows = [["agent"]] } }',
    'ui.sidebar = { "agents" = { rows = [["agent"]] } }',
    'ui.sidebar = { "ag\\u0065nts" = { rows = [["agent"]] } }',
    'ui = { sidebar = { agents = { rows = [["agent"]] } } }',
    '[ui]\nsidebar = { anything = true }'
  ]) assert.equal(hasAgentsOwner(`${header}\n`), true, header)
  assert.equal(hasAgentsOwner('[theme]\nname = "nord"\n'), false)
})

test('snapshots bind path and recover interrupted original/applied states', async () => {
  const setup = await fixture()
  const original = Buffer.from('[theme]\nname = "nord"\n')
  await writeFile(setup.herdrConfig, original, { mode: 0o640 })
  await configure(setup.env)
  const applied = await readFile(setup.herdrConfig)
  assert.match(applied.toString('utf8'), /mahiro_sidebar_model", fg = "#A5A8AB", dim = true/u)
  assert.match(applied.toString('utf8'), /mahiro_sidebar_context", fg = "#BEBEEE"/u)
  assert.match(applied.toString('utf8'), /mahiro_sidebar_q1_ok", fg = "#64CF64"/u)
  assert.match(applied.toString('utf8'), /\$summary", fg = "#A5A8AB", dim = true/u)
  const snapshot = await readFile(join(setup.pluginConfig, 'config-snapshots.json'))

  await writeFile(setup.herdrConfig, original, { mode: 0o640 })
  await configure(setup.env)
  assert.deepEqual(await readFile(setup.herdrConfig), applied)
  await writeFile(setup.herdrConfig, original, { mode: 0o640 })
  await restoreConfig(setup.env)
  await assert.rejects(readFile(join(setup.pluginConfig, 'config-snapshots.json')), error => error.code === 'ENOENT')

  const other = await fixture()
  await writeFile(other.herdrConfig, original)
  await writeFile(join(other.pluginConfig, 'config-snapshots.json'), snapshot)
  await assert.rejects(configure(other.env), /path-mismatched/u)
})

test('config lock handles dead owners and fails closed for live, malformed, and ownerless locks', async () => {
  const setup = await fixture()
  const lock = join(setup.pluginConfig, 'config.lock')
  const owner = join(lock, 'owner-dead-owner.json')
  const deadKill = pid => {
    if (pid === 999_999) throw Object.assign(new Error('dead'), { code: 'ESRCH' })
    return process.kill(pid, 0)
  }
  await mkdir(lock)
  await writeFile(owner, JSON.stringify({ pid: 999_999, nonce: 'dead-owner' }))
  const release = await acquireConfigLock(setup.pluginConfig, { kill: deadKill })
  assert.equal(await release(), true)

  await mkdir(lock)
  await writeFile(join(lock, 'owner-live-owner.json'), JSON.stringify({ pid: process.pid, nonce: 'live-owner' }))
  await assert.rejects(acquireConfigLock(setup.pluginConfig), /alive/u)
  await rm(lock, { recursive: true })
  await mkdir(lock)
  await writeFile(join(lock, 'owner-malformed.json'), '{}')
  await assert.rejects(acquireConfigLock(setup.pluginConfig), /malformed/u)
  await rm(lock, { recursive: true })
  await mkdir(lock)
  await assert.rejects(acquireConfigLock(setup.pluginConfig), /ownerless/u)
})

test('simultaneous dead-lock reclaim is single-owner and old release cannot delete successor', async () => {
  const setup = await fixture()
  const lock = join(setup.pluginConfig, 'config.lock')
  await mkdir(lock)
  await writeFile(join(lock, 'owner-dead-owner.json'), JSON.stringify({ pid: 999_999, nonce: 'dead-owner' }))
  const kill = pid => {
    if (pid === 999_999) throw Object.assign(new Error('dead'), { code: 'ESRCH' })
    return process.kill(pid, 0)
  }
  const settled = await Promise.allSettled([
    acquireConfigLock(setup.pluginConfig, { kill, nonce: 'first-owner' }),
    acquireConfigLock(setup.pluginConfig, { kill, nonce: 'second-owner' })
  ])
  const winners = settled.filter(result => result.status === 'fulfilled')
  assert.equal(winners.length, 1)
  await assert.rejects(acquireConfigLock(setup.pluginConfig, { nonce: 'third-owner' }), /alive/u)
  await winners[0].value()

  const releaseOld = await acquireConfigLock(setup.pluginConfig, { nonce: 'old-owner' })
  const moved = join(setup.pluginConfig, 'moved-old-lock')
  await rename(lock, moved)
  const releaseSuccessor = await acquireConfigLock(setup.pluginConfig, { nonce: 'successor-owner' })
  assert.equal(await releaseOld(), false)
  assert.equal((await stat(lock)).isDirectory(), true)
  assert.equal(await releaseSuccessor(), true)
  await rm(moved, { recursive: true })
})

test('configure-live reload failure restores exact no-op pre-invocation state', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n', { mode: 0o640 })
  const stub = await stubHerdr(setup)
  await configure(stub.env)
  const priorConfig = await readFile(setup.herdrConfig)
  const snapshotPath = join(setup.pluginConfig, 'config-snapshots.json')
  const priorSnapshot = await readFile(snapshotPath)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'server reload-config', remaining: 1 }]))

  await assert.rejects(configureLive(stub.env, { clock: () => Date.now(), sequence: () => '575' }), /injected failure/u)
  assert.deepEqual(await readFile(setup.herdrConfig), priorConfig)
  assert.deepEqual(await readFile(snapshotPath), priorSnapshot)
  assert.equal((await stat(setup.herdrConfig)).mode & 0o777, 0o640)
})

test('install failures restore configuration and registry transactionally', async () => {
  for (const failure of ['server reload-config', 'plugin enable']) {
    const setup = await fixture()
    await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
    const stub = await stubHerdr(setup)
    await writeFile(stub.failures, JSON.stringify([{ needle: failure, remaining: 1 }]))
    await assert.rejects(installWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '600' }))
    assert.equal(await readFile(setup.herdrConfig, 'utf8'), '[theme]\nname = "nord"\n')
    assert.deepEqual(JSON.parse(await readFile(stub.registry, 'utf8')).plugins, [])
  }

  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[ui.sidebar.agents]\nrows = [["agent"]]\n')
  const stub = await stubHerdr(setup)
  await assert.rejects(installWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '601' }))
  assert.deepEqual(JSON.parse(await readFile(stub.registry, 'utf8')).plugins, [])
})

test('install refuses the same plugin ID at a different root without mutation', async () => {
  const setup = await fixture()
  const otherRoot = join(setup.root, 'other-root')
  const stub = await stubHerdr(setup, [], [{ id: 'mahiro-herdr-sidebar', root: otherRoot, enabled: true }])
  await assert.rejects(installWorkflow(setup.root, stub.env), /different or ambiguous root/u)
  assert.deepEqual(JSON.parse(await readFile(stub.registry, 'utf8')).plugins, [{ id: 'mahiro-herdr-sidebar', root: otherRoot, enabled: true }])
})

test('post-mutation link failure is accepted only after exact disabled registration evidence', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
  const stub = await stubHerdr(setup, [])
  await writeFile(stub.failures, JSON.stringify([{ needle: 'plugin link', remaining: 1, afterMutation: true }]))

  const result = await installWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '650' })
  assert.equal(result.installed, true)
  assert.deepEqual(JSON.parse(await readFile(stub.registry, 'utf8')).plugins, [{ id: 'mahiro-herdr-sidebar', root: setup.root, enabled: true }])
  assert.match(await readFile(setup.herdrConfig, 'utf8'), /mahiro-herdr-sidebar:begin/u)
})

test('install recognizes the live plugin_root registry field for an existing local link', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
  const stub = await stubHerdr(setup, [], [{ plugin_id: 'mahiro-herdr-sidebar', plugin_root: setup.root, enabled: true }])
  const result = await installWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '650' })
  assert.equal(result.installed, true)
})

test('failed reinstall restores exact prior configured and enabled state', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n', { mode: 0o640 })
  const stub = await stubHerdr(setup, [], [{ id: 'mahiro-herdr-sidebar', root: setup.root, enabled: true }])
  await configure(stub.env)
  const priorConfig = await readFile(setup.herdrConfig)
  const snapshotPath = join(setup.pluginConfig, 'config-snapshots.json')
  const priorSnapshot = await readFile(snapshotPath)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'plugin enable', remaining: 1 }]))

  await assert.rejects(installWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '675' }), /injected failure/u)
  assert.deepEqual(await readFile(setup.herdrConfig), priorConfig)
  assert.deepEqual(await readFile(snapshotPath), priorSnapshot)
  assert.equal((await stat(setup.herdrConfig)).mode & 0o777, 0o640)
  assert.equal(JSON.parse(await readFile(stub.registry, 'utf8')).plugins[0].enabled, true)
})

test('post-mutation enable failure is accepted after exact registry postcondition', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
  const stub = await stubHerdr(setup)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'plugin enable', remaining: 1, afterMutation: true }]))

  const result = await installWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '690' })
  assert.equal(result.installed, true)
  assert.equal(JSON.parse(await readFile(stub.registry, 'utf8')).plugins[0].enabled, true)
  assert.match(await readFile(setup.herdrConfig, 'utf8'), /mahiro-herdr-sidebar:begin/u)
})

test('final install refresh failure leaves the enabled install committed with warning', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
  const stub = await stubHerdr(setup)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'agent list', remaining: 1 }]))
  const warnings = []
  const result = await installWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '700', warn: value => warnings.push(value) })
  assert.equal(result.installed, true)
  assert.equal(warnings.length, 1)
  assert.equal(JSON.parse(await readFile(stub.registry, 'utf8')).plugins[0].enabled, true)
  assert.match(await readFile(setup.herdrConfig, 'utf8'), /mahiro-herdr-sidebar:begin/u)
})

test('uninstall reload failure rolls config and prior enabled state back', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
  const plugin = { id: 'mahiro-herdr-sidebar', root: setup.root, enabled: true }
  const stub = await stubHerdr(setup, [], [plugin])
  await configure(stub.env)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'server reload-config', remaining: 1 }]))
  await assert.rejects(uninstallWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '800' }))
  assert.equal(JSON.parse(await readFile(stub.registry, 'utf8')).plugins[0].enabled, true)
  assert.match(await readFile(setup.herdrConfig, 'utf8'), /mahiro-herdr-sidebar:begin/u)
})

test('post-mutation disable failure is accepted after exact registry postcondition', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
  const stub = await stubHerdr(setup, [], [{ id: 'mahiro-herdr-sidebar', root: setup.root, enabled: true }])
  await configure(stub.env)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'plugin disable', remaining: 1, afterMutation: true }]))

  const result = await uninstallWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '810' })
  assert.equal(result.uninstalled, true)
  assert.deepEqual(JSON.parse(await readFile(stub.registry, 'utf8')).plugins, [])
  assert.equal(await readFile(setup.herdrConfig, 'utf8'), '[theme]\nname = "nord"\n')
})

test('uninstall refuses an old checkout before disable or config mutation', async () => {
  const setup = await fixture()
  const currentRoot = join(setup.root, 'current-checkout')
  const stub = await stubHerdr(setup, [], [{ id: 'mahiro-herdr-sidebar', root: currentRoot, enabled: true }])
  await assert.rejects(uninstallWorkflow(setup.root, stub.env), /different or ambiguous root/u)
  assert.deepEqual(await calls(stub.log), [['plugin', 'list', '--json']])
  assert.deepEqual(JSON.parse(await readFile(stub.registry, 'utf8')).plugins, [{ id: 'mahiro-herdr-sidebar', root: currentRoot, enabled: true }])
})

test('unlink failure with same-root registration restores exact prior state', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n', { mode: 0o640 })
  const stub = await stubHerdr(setup, [], [{ id: 'mahiro-herdr-sidebar', root: setup.root, enabled: true }])
  await configure(stub.env)
  const priorConfig = await readFile(setup.herdrConfig)
  const snapshotPath = join(setup.pluginConfig, 'config-snapshots.json')
  const priorSnapshot = await readFile(snapshotPath)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'plugin unlink', remaining: 1 }]))

  await assert.rejects(uninstallWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '825' }), /injected failure/u)
  assert.deepEqual(await readFile(setup.herdrConfig), priorConfig)
  assert.deepEqual(await readFile(snapshotPath), priorSnapshot)
  assert.equal((await stat(setup.herdrConfig)).mode & 0o777, 0o640)
  assert.equal(JSON.parse(await readFile(stub.registry, 'utf8')).plugins[0].enabled, true)
})

test('unlink reported failure is success when registry postcondition is absent', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
  const stub = await stubHerdr(setup, [], [{ id: 'mahiro-herdr-sidebar', root: setup.root, enabled: true }])
  await configure(stub.env)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'plugin unlink', remaining: 1, afterMutation: true }]))

  const result = await uninstallWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '830' })
  assert.equal(result.uninstalled, true)
  assert.deepEqual(JSON.parse(await readFile(stub.registry, 'utf8')).plugins, [])
  assert.equal(await readFile(setup.herdrConfig, 'utf8'), '[theme]\nname = "nord"\n')
})

test('unlink failure with another-root postcondition makes no recovery mutation', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
  const otherRoot = join(setup.root, 'replacement-checkout')
  const stub = await stubHerdr(setup, [], [{ id: 'mahiro-herdr-sidebar', root: setup.root, enabled: true }])
  await configure(stub.env)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'plugin unlink', remaining: 1, afterMutation: true, replacementRoot: otherRoot }]))

  await assert.rejects(uninstallWorkflow(setup.root, stub.env, { clock: () => Date.now(), sequence: () => '840' }), /recovery refused before mutation/u)
  const entries = await calls(stub.log)
  assert.deepEqual(entries.slice(-3), [['plugin', 'unlink', 'mahiro-herdr-sidebar'], ['plugin', 'list', '--json'], ['plugin', 'list', '--json']])
  assert.deepEqual(JSON.parse(await readFile(stub.registry, 'utf8')).plugins, [{ id: 'mahiro-herdr-sidebar', root: otherRoot, enabled: true }])
  assert.equal(await readFile(setup.herdrConfig, 'utf8'), '[theme]\nname = "nord"\n')
})

test('restore action does not disable or unlink its own running plugin', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n')
  const stub = await stubHerdr(setup, [], [{ id: 'mahiro-herdr-sidebar', root: setup.root, enabled: true }])
  await configure(stub.env)
  const result = await restoreLive(stub.env, { clock: () => Date.now(), sequence: () => '850' })
  assert.equal(result.restored, true)
  const pluginCalls = (await calls(stub.log)).filter(call => call[0] === 'plugin')
  assert.equal(pluginCalls.some(call => ['disable', 'unlink'].includes(call[1])), false)
  assert.equal(JSON.parse(await readFile(stub.registry, 'utf8')).plugins[0].enabled, true)
  assert.equal(await readFile(setup.herdrConfig, 'utf8'), '[theme]\nname = "nord"\n')
})

test('restore action reload failure restores exact applied config and snapshot', async () => {
  const setup = await fixture()
  await writeFile(setup.herdrConfig, '[theme]\nname = "nord"\n', { mode: 0o640 })
  const stub = await stubHerdr(setup)
  await configure(stub.env)
  const priorConfig = await readFile(setup.herdrConfig)
  const snapshotPath = join(setup.pluginConfig, 'config-snapshots.json')
  const priorSnapshot = await readFile(snapshotPath)
  await writeFile(stub.failures, JSON.stringify([{ needle: 'server reload-config', remaining: 1 }]))

  await assert.rejects(restoreLive(stub.env, { clock: () => Date.now(), sequence: () => '875' }), /injected failure/u)
  assert.deepEqual(await readFile(setup.herdrConfig), priorConfig)
  assert.deepEqual(await readFile(snapshotPath), priorSnapshot)
  assert.equal((await stat(setup.herdrConfig)).mode & 0o777, 0o640)
})

test('manifest uses stateless event entrypoint and shell scripts contain no Herdr calls', async () => {
  const root = new URL('..', import.meta.url)
  const manifest = await readFile(new URL('herdr-plugin.toml', root), 'utf8')
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const license = await readFile(new URL('LICENSE', root), 'utf8')
  assert.match(manifest, /startup"\]/u)
  assert.match(manifest, /version = "0\.3\.0"/u)
  assert.equal(packageJson.version, '0.3.0')
  assert.equal(packageJson.license, 'MIT')
  assert.equal(packageJson.private, true)
  assert.match(license, /^MIT License/u)
  assert.equal((manifest.match(/ event"\]/gu) || []).length, 3)
  assert.match(manifest, /configure-live/u)
  assert.match(manifest, /restore-live/u)
  assert.doesNotMatch(manifest, /uninstall-live/u)
  assert.doesNotMatch(manifest, /reload-config|watch|poll|daemon/iu)
  const scripts = await Promise.all(['install.sh', 'uninstall.sh'].map(path => readFile(new URL(path, root), 'utf8')))
  assert.equal(scripts.some(source => /^\s*herdr\b/gmu.test(source)), false)
  const core = await readFile(new URL('src/core.mjs', root), 'utf8')
  assert.doesNotMatch(core, /refresh-state|pane['"],\s*['"](?:read|get)|agent\s+view/iu)
})
