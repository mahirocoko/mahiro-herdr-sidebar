# Repository contract

This is an MIT-licensed, dependency-free repository providing a read-only Herdr adapter (`src/core.mjs`) and an optional Agy-native statusline quota producer (`src/agy-statusline-producer.mjs`).

- Use Node 22+ built-ins only and keep modules small.
- Use single quotes and omit semicolons in JavaScript.
- Distinguish the core read-only adapter from the optional statusline-payload producer:
  - `src/core.mjs` is strictly a read-only cache adapter for Herdr. It projects normalized cache files and never produces or collects provider usage.
  - `src/agy-statusline-producer.mjs` is an optional consumer of already-delivered Agy CLI statusline payloads (`quota` map).
- Never read pane contents, transcripts, sessions, credentials, email, plan tier, or raw provider payloads, never invoke `agy -p`, and make no network requests.
- The only usage inputs to the adapter are normalized `codex.json` and `agy.json` cache files under the absolute `MAHIRO_HERDR_USAGE_CACHE_DIR` override or the default `~/.letta/mods/mahiro-usage`.
- Never clear `mahiro_sidebar_model`, `mahiro_sidebar_context`, or `mahiro_sidebar_provider`; Mahiro Mods owns them.
- Refresh is stateless: one inventory observation, complete per-pane owned-token patches, no refresh state, suppression, heartbeat, or refresh lock.
- Keep configuration changes exact, reversible, atomic, serialized by PID-plus-nonce lock directories, and fail closed on ownership ambiguity, lock contention, or drift.
- Reclaim config locks only after an `ESRCH` liveness proof; never reclaim by age or force an ambiguous owner.
- Bound cache reads, reset/freshness expiry, invocation time, and every Herdr subprocess.
- Do not add watchers, pollers, daemons, notifications, settings panes, sorting, dependencies, or network access.
- The Agy producer normalizes only four exact bucket IDs (`gemini-5h`, `gemini-weekly`, `3p-5h`, `3p-weekly`) to `Gemini:5h`, `Gemini:7d`, `Claude-GPT:5h`, `Claude-GPT:7d` in fixed order.
- The producer returns unavailable without touching existing cache when quota is absent or invalid; publishes only `{fetched, failed: false, windows}` atomically to `agy.json` with user-only permissions (`0o600` file, `0o700` dir); refuses symlinks in every path component and non-regular targets/directories; semantically dedupes stable windows within 120 seconds; and survives failure of the default deadline-bounded Herdr refresh path.
- Refresh is eligible only when the runtime environment has both `HERDR_ENV=1` and a non-empty `HERDR_PANE_ID`; caller options must not promote an outside process into Herdr evidence.
- Statusline producer integration is library import-call to preserve custom rendered statusline stdout.
- Tests must isolate HOME and Herdr configuration and use a stub Herdr executable.
