import { resolve } from 'node:path'

import {
  captureConfigState,
  clearOwnedMetadata,
  configure,
  preflightRestoreConfig,
  refresh,
  restoreCapturedConfigState,
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
  const matches = registryPlugins(output).filter(plugin => pluginIdentity(plugin) === PLUGIN_ID)
  if (matches.length > 1) throw new Error('refusing operation: plugin registry has ambiguous duplicate IDs')
  return matches[0] || null
}

function requireSameRoot(plugin, absoluteRoot, operation) {
  const registeredRoot = pluginRoot(plugin)
  if (typeof registeredRoot !== 'string' || resolve(registeredRoot) !== absoluteRoot) {
    throw new Error(`refusing ${operation}: plugin ID is linked to a different or ambiguous root`)
  }
}

function registeredAtRoot(run, absoluteRoot, operation) {
  const plugin = findPlugin(run(['plugin', 'list', '--json']))
  if (!plugin) throw new Error(`refusing ${operation}: plugin registration is missing`)
  requireSameRoot(plugin, absoluteRoot, operation)
  return plugin
}

function setPluginEnabled(run, absoluteRoot, enabled, operation) {
  const before = registeredAtRoot(run, absoluteRoot, operation)
  if (pluginEnabled(before) === enabled) return
  let commandError = null
  try {
    run(['plugin', enabled ? 'enable' : 'disable', PLUGIN_ID])
  } catch (error) {
    commandError = error
  }
  let after
  try {
    after = registeredAtRoot(run, absoluteRoot, `${operation} postcondition`)
  } catch (inspectionError) {
    throw new Error(`${commandError?.message || `${operation} command returned without the requested state`}; ${inspectionError.message}`)
  }
  if (pluginEnabled(after) === enabled) return
  throw commandError || new Error(`${operation} command did not reach the requested enabled state`)
}

function unlinkPlugin(run, absoluteRoot, operation) {
  registeredAtRoot(run, absoluteRoot, operation)
  let commandError = null
  try {
    run(['plugin', 'unlink', PLUGIN_ID])
  } catch (error) {
    commandError = error
  }
  let after
  try {
    after = findPlugin(run(['plugin', 'list', '--json']))
  } catch (inspectionError) {
    throw new Error(`${commandError?.message || `${operation} command returned`}; registry postcondition is ambiguous or unavailable: ${inspectionError.message}`)
  }
  if (!after) return
  try {
    requireSameRoot(after, absoluteRoot, `${operation} postcondition`)
  } catch (inspectionError) {
    throw new Error(`${commandError?.message || `${operation} command returned`}; ${inspectionError.message}`)
  }
  throw commandError || new Error(`${operation} command did not remove the registration`)
}

function linkPlugin(run, absoluteRoot, operation) {
  let commandError = null
  try {
    run(['plugin', 'link', absoluteRoot, '--disabled'])
  } catch (error) {
    commandError = error
  }
  let linked
  try {
    linked = registeredAtRoot(run, absoluteRoot, `${operation} postcondition`)
  } catch (inspectionError) {
    throw new Error(`${commandError?.message || `${operation} command returned without a registration`}; ${inspectionError.message}`)
  }
  if (pluginEnabled(linked)) setPluginEnabled(run, absoluteRoot, false, `${operation} disable postcondition`)
}

function actionEnvironment(env, directory) {
  return { ...env, HERDR_PLUGIN_CONFIG_DIR: directory }
}

function workflowRunner(env, clock, deadline) {
  return args => runHerdr(env, args, { clock, deadline })
}

export async function installWorkflow(root, env = process.env, options = {}) {
  const clock = options.clock || Date.now
  const deadline = options.deadline ?? clock() + WORKFLOW_DEADLINE_MS
  const run = workflowRunner(env, clock, deadline)
  const absoluteRoot = resolve(root)
  const existing = findPlugin(run(['plugin', 'list', '--json']))
  const priorEnabled = existing ? pluginEnabled(existing) : false
  if (existing) requireSameRoot(existing, absoluteRoot, 'install')

  let linkedNew = false
  if (!existing) {
    linkPlugin(run, absoluteRoot, 'install link')
    linkedNew = true
  }
  let directory
  try {
    directory = run(['plugin', 'config-dir', PLUGIN_ID]).trim()
    if (!directory) throw new Error('Herdr returned an empty plugin config directory')
  } catch (error) {
    if (linkedNew) unlinkPlugin(run, absoluteRoot, 'install cleanup unlink')
    throw error
  }
  const pluginEnv = actionEnvironment(env, directory)
  let captured
  try {
    captured = await captureConfigState(pluginEnv)
  } catch (error) {
    if (linkedNew) unlinkPlugin(run, absoluteRoot, 'install cleanup unlink')
    throw error
  }

  try {
    if (existing) setPluginEnabled(run, absoluteRoot, false, 'install disable')
    await configure(pluginEnv)
    run(['server', 'reload-config'])
    setPluginEnabled(run, absoluteRoot, true, 'install enable')
  } catch (error) {
    try {
      registeredAtRoot(run, absoluteRoot, 'install rollback')
    } catch (inspectionError) {
      throw new Error(`${error.message}; install recovery refused before mutation: ${inspectionError.message}`)
    }
    let rollbackError = null
    try {
      await restoreCapturedConfigState(captured, pluginEnv)
      run(['server', 'reload-config'])
      if (linkedNew) unlinkPlugin(run, absoluteRoot, 'install rollback unlink')
      else setPluginEnabled(run, absoluteRoot, priorEnabled, 'install rollback enabled state')
    } catch (failure) {
      rollbackError = failure
    }
    if (rollbackError) throw new Error(`${error.message}; install rollback failed with recovery evidence retained: ${rollbackError.message}`)
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
  const captured = await captureConfigState(env)
  try {
    await configure(env)
    run(['server', 'reload-config'])
  } catch (error) {
    try {
      await restoreCapturedConfigState(captured, env)
      run(['server', 'reload-config'])
    } catch (rollbackError) {
      throw new Error(`${error.message}; configure action rollback failed: ${rollbackError.message}`)
    }
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
  const captured = await captureConfigState(env)
  let restored = false
  try {
    restored = await restoreConfig(env)
    run(['server', 'reload-config'])
  } catch (error) {
    try {
      await restoreCapturedConfigState(captured, env)
      run(['server', 'reload-config'])
    } catch (rollbackError) {
      throw new Error(`${error.message}; restore action rollback failed: ${rollbackError.message}`)
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

export async function uninstallWorkflow(root, env = process.env, options = {}) {
  const clock = options.clock || Date.now
  const deadline = options.deadline ?? clock() + WORKFLOW_DEADLINE_MS
  const run = workflowRunner(env, clock, deadline)
  const absoluteRoot = resolve(root)
  const existing = findPlugin(run(['plugin', 'list', '--json']))
  if (!existing) return { uninstalled: false }
  requireSameRoot(existing, absoluteRoot, 'uninstall')
  const priorEnabled = pluginEnabled(existing)
  const directory = run(['plugin', 'config-dir', PLUGIN_ID]).trim()
  if (!directory) throw new Error('Herdr returned an empty plugin config directory')
  const pluginEnv = actionEnvironment(env, directory)
  await preflightRestoreConfig(pluginEnv)
  const captured = await captureConfigState(pluginEnv)

  try {
    setPluginEnabled(run, absoluteRoot, false, 'uninstall disable')
    await restoreConfig(pluginEnv)
    run(['server', 'reload-config'])
    try {
      await clearOwnedMetadata(pluginEnv, { clock, deadline, sequence: options.sequence })
    } catch {
      // TTL remains the fallback when a live pane cannot be cleared.
    }
    unlinkPlugin(run, absoluteRoot, 'uninstall unlink')
    return { uninstalled: true }
  } catch (error) {
    try {
      registeredAtRoot(run, absoluteRoot, 'uninstall rollback')
    } catch (inspectionError) {
      throw new Error(`${error.message}; uninstall recovery refused before mutation: ${inspectionError.message}`)
    }
    let rollbackError = null
    try {
      await restoreCapturedConfigState(captured, pluginEnv)
      run(['server', 'reload-config'])
      setPluginEnabled(run, absoluteRoot, priorEnabled, 'uninstall rollback enabled state')
    } catch (failure) {
      rollbackError = failure
    }
    if (rollbackError) throw new Error(`${error.message}; uninstall rollback failed with recovery evidence retained: ${rollbackError.message}`)
    throw error
  }
}
