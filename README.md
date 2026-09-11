# Mahiro Herdr Sidebar

Private, unlicensed Herdr 0.9.0+ plugin that projects Mahiro's existing normalized usage cache into the Agent sidebar. It uses Node 22+ built-ins and has no package dependencies.

## Current Reality

Startup and manual refresh are stateless one-shot reconciliations. They read the agent inventory once, reject inventories above 128 deduplicated panes, and send one complete owned-token patch to every selected pane. Repeated refreshes intentionally republish. Plugin events accept only Herdr's exact `pane_focused`, `pane_agent_detected`, and `pane_agent_status_changed` event payloads and reconcile only the explicit inventory-backed pane. Invalid events make no Herdr calls.

Each invocation captures one system-monotonic sequence before inventory and uses it for every report. This gives Herdr an observation order across overlapping local processes. Live Herdr 0.9.0 verification confirmed that lower and equal sequences are silently ignored and that metadata TTL expires from accepted publication time.

The configured rows retain Herdr's native state/location row and agent row, then add Mahiro Mods' model and context tokens, an explicit Agy shared-pool label, two family-grouped severity-colored quota rows, and the existing summary token. Every owned token is either set or cleared exactly once per patch. The plugin never clears Mahiro Mods' model, context, or provider tokens.

## Data and provenance limits

The only usage inputs are `~/.letta/mods/mahiro-usage/codex.json` and `~/.letta/mods/mahiro-usage/agy.json`. Only families needed by selected panes are read. Files are opened nonblocking without following symlinks and read once with a strict 64 KiB-plus-one bound. Cache freshness is validated against time observed after the bytes are read.

Quota windows that are expired or inside delivery/reset headroom are omitted. Metadata TTL is recomputed immediately before each report and cannot outlive cache freshness or the earliest displayed reset. Exhausted TTL produces an all-clear patch rather than a nominal 1 ms publication. Values are sanitized and length-bounded.

Agy values are labeled `Agy shared pools`. Gemini and Claude-GPT 5h/7d values are account-level shared pools, not active-session attribution. Codex quota is published to a Letta pane only when inventory explicitly reports `mahiro_sidebar_provider=openai-codex`; only exact account labels `P:5h`, `P:7d`, and `S:7d` are eligible, never model-prefixed labels.

The design was informed by `levi-qiao/herdr-agent-quota` at reviewed commit `0540feb1d51bb7618f94f02aa804493614b1ba0d`; no claim is made that its source was copied.

## Resource model

An invocation is a short-lived Node process with a 30-second deadline. Each Herdr subprocess is limited to five seconds and 256 KiB of output. A full invocation performs at most one inventory call plus one report per deduplicated target. An event performs at most one inventory call and one report. There is no retry, watcher, poller, daemon, pane-content read, transcript/session read, credential read, notification, sorting, network request, or settings UI.

## Configuration ownership

Configuration snapshots bind the exact absolute config path and preserve original bytes, existence, regular-file/non-symlink status, and mode. Configure and restore recognize interrupted states when the current config equals either known snapshot, while retaining recovery evidence until success. Any drift, path mismatch, equivalent or descendant agent-sidebar table, escaped table key, or ambiguous ownership form fails closed.

Config transactions use a lock directory with a PID and nonce owner record. A lock is reclaimed only when the operating system proves the PID no longer exists. Live, permission-denied, malformed, ownerless, reused, or otherwise ambiguous ownership fails closed. Release removes only the matching owner record and then attempts a non-recursive directory removal.

## Install

Run `./install.sh`. The Node workflow inspects the JSON plugin registry, refuses the same ID at another root, links new installs disabled, configures and reloads, then enables hooks. Failures roll configuration back before unlinking; failed rollback retains the disabled plugin and evidence. Initial metadata publication is post-commit, so its failure reports a warning without pretending the install rolled back.

## Uninstall

Run `./uninstall.sh`. The Node workflow preflights restoration, disables hooks, restores and reloads configuration, best-effort clears owned metadata, then unlinks only this plugin. An abort before safe unlink restores the prior enabled state and reapplies configuration when necessary.

## Development

- `npm test` runs isolated tests with temporary HOME/cache/config and a stub Herdr executable.
- `npm run check` syntax-checks all executable modules and runs the tests.

## Non-goals

This repository does not collect provider data, inspect panes, attribute shared Agy quota to a session, manage Mahiro Mods, migrate preview configuration, install upstream plugins, expose settings, emit alerts, reorder agents, or perform live installation and visual acceptance as part of source development.
