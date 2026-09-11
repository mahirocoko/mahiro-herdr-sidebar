import { resolve } from 'node:path'

import {
  clearOwnedMetadata,
  configure,
  preflightRestoreConfig,
  refresh,
  restoreConfig,
  runHerdr
} from './core.mjs'

const PLUGIN_ID = 'mahiro-herdr-sidebar'
const WORKFLOW_DEADLINE_MS = 30 * 1000

function registryPlugins(output) {
  const parsed = JSON.parse(output)
  const plugins = Array.isArray(parsed) ? parsed : parsed.plugins || parsed.result?.plugins
  if (!Array.isArray(plugins)) throw new Error('unexpected Herdr plugin registry response')
  return plugins
}

function pluginIdentity(plugin) {
  return plugin.id || plugin.plugin_id || plugin.manifest?.id
}

function pluginRoot(plugin) {
  return plugin.root || plugin.plugin_root || plugin.path || plugin.link_path || plugin.source?.path || plugin.source?.root
}

function pluginEnabled(plugin) {
  return plugin.enabled === true || plugin.status === 'enabled'
}

function findPlugin(output) {
  return registryPlugins(output).find(plugin => pluginIdentity(plugin) === PLUGIN_ID) || null
}

function actionEnvironment(env, directory) {
  return { ...env, HERDR_PLUGIN_CONFIG_DIR: directory }
}

function workflowRunner(env, clock, deadline) {
  return args => runHerdr(env, args, { clock, deadline })
}

async function restoreAndReload(env, run) {
  await restoreConfig(env)
  run(['server', 'reload-config'])
}

export async function installWorkflow(root, env = process.env, options = {}) {
  const clock = options.clock || Date.now
  const deadline = options.deadline ?? clock() + WORKFLOW_DEADLINE_MS
  const run = workflowRunner(env, clock, deadline)
  const absoluteRoot = resolve(root)
  const existing = findPlugin(run(['plugin', 'list', '--json']))
  const priorEnabled = existing ? pluginEnabled(existing) : false
  if (existing) {
    const registeredRoot = pluginRoot(existing)
    if (!registeredRoot || resolve(registeredRoot) !== absoluteRoot) {
      throw new Error('refusing install: plugin ID is linked to a different or ambiguous root')
    }
  }

  let linkedNew = false
  let configured = false
  if (existing && priorEnabled) run(['plugin', 'disable', PLUGIN_ID])
  if (!existing) {
    run(['plugin', 'link', absoluteRoot, '--disabled'])
    linkedNew = true
  }
  let directory
  try {
    directory = run(['plugin', 'config-dir', PLUGIN_ID]).trim()
    if (!directory) throw new Error('Herdr returned an empty plugin config directory')
  } catch (error) {
    if (linkedNew) run(['plugin', 'unlink', PLUGIN_ID])
    else if (priorEnabled) run(['plugin', 'enable', PLUGIN_ID])
    throw error
  }
  const pluginEnv = actionEnvironment(env, directory)

  try {
    configured = true
    await configure(pluginEnv)
    run(['server', 'reload-config'])
    run(['plugin', 'enable', PLUGIN_ID])
  } catch (error) {
    let rollbackError = null
    if (configured) {
      try {
        await restoreAndReload(pluginEnv, run)
      } catch (failure) {
        rollbackError = failure
      }
    }
    if (!rollbackError) {
      try {
        if (linkedNew) run(['plugin', 'unlink', PLUGIN_ID])
        else if (priorEnabled) run(['plugin', 'enable', PLUGIN_ID])
      } catch (failure) {
        rollbackError = failure
      }
    }
    if (rollbackError) throw new Error(`${error.message}; rollback retained disabled plugin evidence: ${rollbackError.message}`)
    throw error
  }

  let warning = null
  try {
    await refresh(pluginEnv, { clock, deadline, sequence: options.sequence })
  } catch (error) {
    warning = `installed, but initial metadata refresh failed: ${error.message}`
    const warn = options.warn || console.warn
    warn(warning)
  }
  return { installed: true, warning }
}

export async function configureLive(env = process.env, options = {}) {
  const clock = options.clock || Date.now
  const deadline = options.deadline ?? clock() + WORKFLOW_DEADLINE_MS
  const run = workflowRunner(env, clock, deadline)
  await configure(env)
  try {
    run(['server', 'reload-config'])
  } catch (error) {
    await restoreConfig(env)
    run(['server', 'reload-config'])
    throw error
  }
  try {
    await refresh(env, { clock, deadline, sequence: options.sequence })
  } catch (error) {
    const warn = options.warn || console.warn
    warn(`configured, but metadata refresh failed: ${error.message}`)
  }
}

export async function restoreLive(env = process.env, options = {}) {
  const clock = options.clock || Date.now
  const deadline = options.deadline ?? clock() + WORKFLOW_DEADLINE_MS
  const run = workflowRunner(env, clock, deadline)
  await preflightRestoreConfig(env)
  let restored = false
  try {
    restored = await restoreConfig(env)
    run(['server', 'reload-config'])
  } catch (error) {
    if (restored) {
      try {
        await configure(env)
        run(['server', 'reload-config'])
      } catch (rollbackError) {
        throw new Error(`${error.message}; restore action rollback failed: ${rollbackError.message}`)
      }
    }
    throw error
  }
  try {
    await clearOwnedMetadata(env, { clock, deadline, sequence: options.sequence })
  } catch {
    // TTL remains the fallback when a live pane cannot be cleared.
  }
  return { restored }
}

export async function uninstallWorkflow(env = process.env, options = {}) {
  const clock = options.clock || Date.now
  const deadline = options.deadline ?? clock() + WORKFLOW_DEADLINE_MS
  const run = workflowRunner(env, clock, deadline)
  const existing = findPlugin(run(['plugin', 'list', '--json']))
  if (!existing) return { uninstalled: false }
  const priorEnabled = pluginEnabled(existing)
  const directory = run(['plugin', 'config-dir', PLUGIN_ID]).trim()
  if (!directory) throw new Error('Herdr returned an empty plugin config directory')
  const pluginEnv = actionEnvironment(env, directory)
  await preflightRestoreConfig(pluginEnv)
  if (priorEnabled) run(['plugin', 'disable', PLUGIN_ID])

  let restored = false
  let safelyRestored = false
  try {
    await restoreConfig(pluginEnv)
    restored = true
    run(['server', 'reload-config'])
    safelyRestored = true
    try {
      await clearOwnedMetadata(pluginEnv, { clock, deadline, sequence: options.sequence })
    } catch {
      // TTL remains the fallback when a live pane cannot be cleared.
    }
    run(['plugin', 'unlink', PLUGIN_ID])
    return { uninstalled: true }
  } catch (error) {
    if (!safelyRestored) {
      let rollbackError = null
      try {
        if (restored) {
          await configure(pluginEnv)
          run(['server', 'reload-config'])
        }
        if (priorEnabled) run(['plugin', 'enable', PLUGIN_ID])
      } catch (failure) {
        rollbackError = failure
      }
      if (rollbackError) throw new Error(`${error.message}; uninstall rollback failed: ${rollbackError.message}`)
    }
    throw error
  }
}
