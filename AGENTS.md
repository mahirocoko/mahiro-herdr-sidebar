# Repository contract

This is an MIT-licensed, dependency-free open adapter that projects normalized external usage data into Herdr.

- Use Node 22+ built-ins only and keep modules small.
- Use single quotes and omit semicolons in JavaScript.
- Never read pane contents, transcripts, sessions, credentials, or raw provider payloads.
- The only usage inputs are normalized `codex.json` and `agy.json` cache files under the absolute `MAHIRO_HERDR_USAGE_CACHE_DIR` override or the default `~/.letta/mods/mahiro-usage`.
- Never clear `mahiro_sidebar_model`, `mahiro_sidebar_context`, or `mahiro_sidebar_provider`; Mahiro Mods owns them.
- Refresh is stateless: one inventory observation, complete per-pane owned-token patches, no refresh state, suppression, heartbeat, or refresh lock.
- Keep configuration changes exact, reversible, atomic, serialized by PID-plus-nonce lock directories, and fail closed on ownership ambiguity, lock contention, or drift.
- Reclaim config locks only after an `ESRCH` liveness proof; never reclaim by age or force an ambiguous owner.
- Bound cache reads, reset/freshness expiry, invocation time, and every Herdr subprocess.
- Do not add watchers, pollers, daemons, notifications, settings panes, sorting, dependencies, or network access.
- Tests must isolate HOME and Herdr configuration and use a stub Herdr executable.
