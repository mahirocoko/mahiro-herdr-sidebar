# Mahiro Herdr Sidebar

MIT-licensed open adapter that projects normalized external usage snapshots into Herdr's Agent sidebar, with an optional native Agy statusline quota producer module. It uses Node.js built-ins only, has no package dependencies, and does not contact providers.

The package remains `private: true` to prevent accidental npm publication. Distribution uses Herdr's GitHub plugin installer or a local Git clone; this project is not distributed through npm.

## Prerequisites and support boundary

- [Herdr](https://herdr.dev) 0.9.0 or newer
- Node.js 22 or newer
- macOS or Linux
- An external cache producer that implements the open adapter protocol, or the optional native Agy statusline producer module
- For Codex rows, an external pane-token producer that identifies eligible panes

The source and isolated test suite support macOS and Linux. Mahiro has verified installation, configuration, events, refresh, and metadata behavior with Herdr 0.9.0 on macOS. GitHub Actions runs isolated Node 22 tests on `macos-latest` and `ubuntu-latest`; that Linux check does not claim live Herdr runtime integration.

## Install

For a released public version:

```sh
herdr plugin install mahirocoko/mahiro-herdr-sidebar --ref v0.3.0
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

## Architecture and boundary separation

This repository provides two distinct components:

1. **Read-only Herdr Adapter (`src/core.mjs`)**: The core plugin runtime. It reads normalized `codex.json` and `agy.json` cache files and projects them into Herdr agent sidebar rows. It never writes to cache files, never collects provider data, and makes no network requests.
2. **Optional Agy Statusline Quota Producer (`src/agy-statusline-producer.mjs`)**: An opt-in helper module for Agy CLI users. It consumes already-delivered statusline payloads, normalizes the quota map, and publishes snapshots atomically to `agy.json`. It never reads credentials, email, plan tier, transcripts, sessions, or raw provider payloads, never invokes `agy -p`, and makes no network requests.

## Open adapter inputs

By default, the adapter reads:

- `~/.letta/mods/mahiro-usage/codex.json`
- `~/.letta/mods/mahiro-usage/agy.json`

The default preserves compatibility with [Mahiro Mods v0.10.0+](https://github.com/mahirocoko/mods/releases/tag/v0.10.0), the reference producer for model/context/provider metadata and the normalized Codex cache. Agy quota now comes from the optional Agy statusline producer below or another external producer. To use another cache root, set `MAHIRO_HERDR_USAGE_CACHE_DIR` to a non-empty absolute directory path in the environments that launch both the producer and Herdr server; plugin actions and events inherit it. Relative or empty overrides fail closed.

External producers own their collection and normalization. The optional Agy helper owns only normalization and publication of the already-delivered statusline `quota` map. The adapter only reads bounded normalized JSON and never reads credentials or raw provider payloads. Codex publication additionally requires the pane inventory token `mahiro_sidebar_provider=openai-codex`; that token must be produced and owned externally. Agy values are labeled `Agy shared pools` because they are account-level shared pools, not active-session attribution.

See [Open adapter integration protocol](docs/integration.md) for the exact JSON schema, milliseconds/percentage units, accepted labels, freshness and reset margins, pane-token contract, and fail-closed rules.

## Optional Agy statusline quota producer (v0.3.0+)

The module `src/agy-statusline-producer.mjs` exports pure normalization and atomic publication for Agy CLI 1.2.2+ environments:

- **Input ground truth**: In Agy CLI 1.2.2, custom statusline commands receive a top-level `quota` map with bucket IDs `gemini-5h`, `gemini-weekly`, `3p-5h`, and `3p-weekly`.
- **Pure normalization (`normalizeAgyQuota`)**: Maps the four exact IDs to `Gemini:5h`, `Gemini:7d`, `Claude-GPT:5h`, and `Claude-GPT:7d` in strict fixed order. Converts `remaining_fraction` to percentage points [0, 100], parses ISO 8601 `reset_time` with bounded `reset_in_seconds` fallback, and ignores unknown buckets and non-quota fields. If quota is absent or invalid, it returns `null` without touching the cache.
- **Atomic publication (`publishAgyQuota` / `publishAgyStatusline`)**: Writes `{ fetched, failed: false, windows }` atomically to `agy.json` using unique temporary files and atomic rename. Enforces user-only permissions (`0o600` file, `0o700` dir) and refuses symlinks in every path component or non-regular targets/directories.
- **120-second deduplication**: If the existing cache is valid and younger than 120 seconds, labels and remaining percentages match, and reset targets differ by no more than the same 120-second window, disk write and Herdr refresh are skipped. The reset tolerance prevents `reset_in_seconds` countdown payloads from becoming false changes.
- **Changed or aged write**: If semantic windows change or the existing snapshot is 120+ seconds old, the producer writes the updated snapshot and triggers at most one Herdr refresh only when the runtime has both `HERDR_ENV=1` and a non-empty `HERDR_PANE_ID`. The default runtime refresh path has a five-second deadline; cache success survives its failure.
- **Concurrency**: Multiple one-shot statusline processes race safely via unique temporary files and atomic rename without locks or destructive state.
- **Canonical integration seam**: Because Agy statusline commands render stdout directly to the terminal, a silent standalone binary would erase the user's custom statusline. The canonical integration is an import-call inside the user's custom statusline script:

```javascript
import { publishAgyStatusline } from '/absolute/path/to/mahiro-herdr-sidebar/src/agy-statusline-producer.mjs'

// Receive payload from Agy CLI via stdin:
const payload = JSON.parse(stdinText)

// Finish publication before a one-shot statusline process exits.
// Failure stays isolated from the rendered statusline.
await publishAgyStatusline(payload).catch(() => null)

// Render custom statusline text to stdout:
process.stdout.write(renderStatusLine(payload))
```

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

External producers remain outside this repository's trust and lifecycle boundary. The optional Agy helper is inside the repository boundary but accepts only the documented statusline `quota` map and publishes only its normalized allowlist. Keep cache directories user-readable only, publish snapshots atomically, and never place credentials or raw provider responses in the normalized files.

## Development

```sh
npm test
npm run check
bash -n install.sh uninstall.sh
git diff --check
```

Tests isolate HOME, cache, Herdr configuration, and a stub Herdr executable. They do not mutate a live Herdr installation.

## Non-goals

This repository does not contact providers, poll Agy, invoke `agy -p`, inspect panes, attribute shared Agy quota to a session, manage Mahiro Mods, manage credentials, install upstream plugins, expose settings, emit alerts, reorder agents, or perform live installation and visual acceptance as part of source development.

The design was informed by `levi-qiao/herdr-agent-quota` at reviewed commit `0540feb1d51bb7618f94f02aa804493614b1ba0d`; no claim is made that its source was copied.
