# Mahiro Herdr Sidebar

MIT-licensed open adapter that projects normalized external usage snapshots into Herdr's Agent sidebar. It uses Node.js built-ins only, has no package dependencies, and does not collect provider data.

The package remains `private: true` to prevent accidental npm publication. Distribution uses Herdr's GitHub plugin installer or a local Git clone; this project is not distributed through npm.

## Prerequisites and support boundary

- [Herdr](https://herdr.dev) 0.9.0 or newer
- Node.js 22 or newer
- macOS or Linux
- An external cache producer that implements the open adapter protocol
- For Codex rows, an external pane-token producer that identifies eligible panes

The source and isolated test suite support macOS and Linux. Mahiro has verified installation, configuration, events, refresh, and metadata behavior with Herdr 0.9.0 on macOS. GitHub Actions runs isolated Node 22 tests on `macos-latest` and `ubuntu-latest`; that Linux check does not claim live Herdr runtime integration.

## Install

For a released public version:

```sh
herdr plugin install mahirocoko/mahiro-herdr-sidebar --ref v0.2.0
herdr plugin action invoke configure --plugin mahiro-herdr-sidebar
```

To remove that installation, use Herdr's owning uninstall flow. Its manifest action restores the saved sidebar configuration before Herdr removes the plugin:

```sh
herdr plugin uninstall mahiro-herdr-sidebar
```

For local development or an unreleased checkout:

```sh
git clone https://github.com/mahirocoko/mahiro-herdr-sidebar.git
cd mahiro-herdr-sidebar
npm run check
./install.sh
```

The installer checks the JSON plugin registry, refuses the same plugin ID at another or ambiguous root, links a new checkout disabled, configures and reloads Herdr, then enables the plugin. Re-running it from the registered checkout is supported. Reinstall failure restores the exact captured pre-operation config and enabled state when ownership evidence remains safe.

The plugin's Herdr uninstall action is intentionally restore-only because a running plugin must not unlink itself. To fully uninstall a locally linked development checkout, run:

```sh
./uninstall.sh
```

The uninstall script passes its invoking checkout root to the workflow. Before disabling or changing configuration, the workflow verifies that Herdr's single same-ID registration resolves exactly to that root. This prevents an old clone from uninstalling a newer registration.

## Open adapter inputs

By default, the adapter reads:

- `~/.letta/mods/mahiro-usage/codex.json`
- `~/.letta/mods/mahiro-usage/agy.json`

The default preserves compatibility with [Mahiro Mods v0.9.4+](https://github.com/mahirocoko/mods/releases/tag/v0.9.4), the reference producer for model/context/provider metadata and normalized Codex/Agy caches. To use another producer, set `MAHIRO_HERDR_USAGE_CACHE_DIR` to a non-empty absolute directory path in the environment that launches the Herdr server; plugin actions and events inherit it. Relative or empty overrides fail closed.

The external producer owns cache collection and normalization. The adapter only reads bounded normalized JSON and never reads credentials or raw provider payloads. Codex publication additionally requires the pane inventory token `mahiro_sidebar_provider=openai-codex`; that token must be produced and owned externally. Agy values are labeled `Agy shared pools` because they are account-level shared pools, not active-session attribution.

See [Open adapter integration protocol](docs/integration.md) for the exact JSON schema, milliseconds/percentage units, accepted labels, freshness and reset margins, pane-token contract, and fail-closed rules.

## Runtime behavior

Startup and manual refresh are stateless one-shot reconciliations. They read the agent inventory once, reject inventories above 128 deduplicated panes, and send one complete owned-token patch to every selected pane. Repeated refreshes intentionally republish. Exact Herdr events reconcile only their explicit inventory-backed pane; invalid events make no Herdr calls.

Each invocation captures one system-monotonic sequence before inventory and uses it for every report. Mahiro's live Herdr 0.9.0 macOS verification confirmed that lower and equal sequences are silently ignored and metadata TTL expires from accepted publication time.

The configured rows retain Herdr's native state/location and agent rows, then add externally owned model and context tokens, an explicit Agy shared-pool label, two family-grouped severity-colored quota rows, and Herdr's summary token. Every adapter-owned token is set or cleared exactly once per patch. The adapter never clears `mahiro_sidebar_model`, `mahiro_sidebar_context`, or `mahiro_sidebar_provider`.

An invocation is a short-lived Node process with a 30-second deadline. Each Herdr subprocess is limited to five seconds and 256 KiB of output. There is no retry, watcher, poller, daemon, pane-content read, transcript/session read, credential read, notification, sorting, network request, or settings UI.

## Configuration safety and recovery

Configuration snapshots bind the exact absolute config path and preserve original bytes, existence, regular-file/non-symlink status, and mode. Configure and restore accept only known original/applied states. Drift, path mismatch, equivalent or descendant agent-sidebar tables, escaped keys, and ambiguous ownership fail closed.

Config changes are serialized by PID-plus-nonce lock directories. A lock is reclaimed only after an operating-system `ESRCH` liveness proof; malformed, ownerless, live, permission-denied, reused, or otherwise ambiguous ownership is never forced.

If uninstall's unlink command reports failure, the workflow reads the registry again:

- If the same-ID entry is absent, uninstall succeeded and returns success.
- If the same-ID entry still resolves to the invoking root, the workflow restores the exact captured config and enabled state where safe, then reports the unlink failure.
- If registration is another-root or ambiguous, it performs no recovery mutation and fails with evidence preserved.

On a failed install or uninstall, read the complete error before retrying. Do not delete the plugin config directory or snapshot evidence. Resolve registry-root conflicts by running the script from the checkout shown by `herdr plugin list --json`. Resolve config drift manually before retrying; the adapter will not overwrite an unknown sidebar owner. A metadata-clear failure is non-destructive because Herdr TTL remains the fallback.

## Privacy and security model

The trust boundary is local and narrow: Herdr inventory, two normalized cache files, plugin-owned recovery evidence, and Herdr's CLI. Cache files are opened nonblocking without following final-component symlinks and are bounded to 64 KiB. Values and identifiers are validated and output is sanitized and bounded. No secrets are required by CI or by this adapter.

Producers are outside this repository's trust and lifecycle boundary. Keep cache directories user-readable only, publish snapshots atomically, and never place credentials or raw provider responses in the normalized files.

## Development

```sh
npm test
npm run check
bash -n install.sh uninstall.sh
git diff --check
```

Tests isolate HOME, cache, Herdr configuration, and a stub Herdr executable. They do not mutate a live Herdr installation.

## Non-goals

This repository does not collect provider data, inspect panes, attribute shared Agy quota to a session, manage Mahiro Mods, add collectors, manage credentials, install upstream plugins, expose settings, emit alerts, reorder agents, or perform live installation and visual acceptance as part of source development.

The design was informed by `levi-qiao/herdr-agent-quota` at reviewed commit `0540feb1d51bb7618f94f02aa804493614b1ba0d`; no claim is made that its source was copied.
