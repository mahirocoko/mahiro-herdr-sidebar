#!/usr/bin/env node

import { configure, eventRefresh, refresh, restoreConfig } from '../src/core.mjs'
import { configureLive, installWorkflow, restoreLive, uninstallWorkflow } from '../src/workflows.mjs'

const command = process.argv[2]

try {
  if (command === 'startup' || command === 'refresh') {
    await refresh()
  } else if (command === 'event') {
    await eventRefresh()
  } else if (command === 'configure') {
    await configure()
  } else if (command === 'restore') {
    await restoreConfig()
  } else if (command === 'configure-live') {
    await configureLive()
  } else if (command === 'restore-live') {
    await restoreLive()
  } else if (command === 'install' && process.argv[3]) {
    await installWorkflow(process.argv[3])
  } else if ((command === 'uninstall-live' || command === 'uninstall') && process.argv[3]) {
    await uninstallWorkflow(process.argv[3])
  } else {
    throw new Error('usage: mahiro-herdr-sidebar.mjs <startup|refresh|event|configure|restore|configure-live|restore-live|install ROOT|uninstall-live ROOT>')
  }
} catch (error) {
  console.error(`mahiro-herdr-sidebar: ${error.message}`)
  process.exitCode = 1
}
