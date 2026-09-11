# Open adapter integration protocol

Mahiro Herdr Sidebar is a read-only adapter. An external producer writes normalized quota snapshots; a separate pane-token producer identifies eligible Codex panes. This repository provides neither producer and never contacts a provider.

## Cache location

The default directory is `~/.letta/mods/mahiro-usage` for [Mahiro Mods v0.9.4+](https://github.com/mahirocoko/mods/releases/tag/v0.9.4) compatibility. Set `MAHIRO_HERDR_USAGE_CACHE_DIR` to a non-empty absolute path in the environment that launches the Herdr server to use another directory. Plugin actions and events inherit that value. The adapter normalizes the path before appending `codex.json` or `agy.json`; relative and empty overrides fail closed.

A producer should create the directory with user-only permissions and publish each file atomically by writing a sibling temporary regular file and renaming it into place. The adapter opens the final file read-only and nonblocking, refuses symlinks and non-regular files, and reads at most 64 KiB.

## Normalized JSON

Both files use this schema. All time values are Unix epoch milliseconds and `remaining` is percentage points, not a fraction.

```json
{
  "fetched": 1789110000000,
  "failed": false,
  "windows": [
    {
      "label": "P:5h",
      "remaining": 73.5,
      "reset": 1789113600000
    }
  ]
}
```

Required fields:

- `fetched`: finite number from 2020-01-01 onward and no later than the post-read clock.
- `failed`: write `false` for an available snapshot. `true` makes the complete file unavailable. Omission is currently treated like `false`, but producers should emit it explicitly.
- `windows`: array of objects.
- `windows[].label`: string. Only the exact labels below are displayed.
- `windows[].remaining`: finite number in the inclusive range 0 through 100.
- `windows[].reset`: finite epoch-millisecond number from 2020-01-01 through 370 days after the post-read clock.

The top-level value must be a non-null JSON object. Unknown top-level fields are ignored. Invalid windows are discarded independently; malformed JSON, a failed snapshot, or an invalid top-level freshness shape makes the whole family unavailable.

Accepted labels are exact and case-sensitive:

- `codex.json`: `P:5h`, `P:7d`, `S:7d`. `P:7d` is preferred when both seven-day labels exist. Model-prefixed labels are ignored.
- `agy.json`: `Gemini:5h`, `Gemini:7d`, `Claude-GPT:5h`, `Claude-GPT:7d`.

A cache is usable only before `fetched + 300000 ms - 5000 ms`. A window is displayable only when its reset is more than `5000 ms` reset margin plus `1000 ms` delivery headroom ahead. Herdr metadata expiry is bounded by both cache freshness and the earliest displayed reset; another `1000 ms` is removed when computing the report TTL. Expired or unusable data produces token clears, never stale quota.

## Pane-token producer contract

Codex quota is eligible only for an inventory entry where:

- `agent` is exactly `letta`, and
- `tokens.mahiro_sidebar_provider` is exactly `openai-codex`.

An external integration such as Mahiro Mods must publish and own that pane token. This adapter reads it only from Herdr's agent inventory and never sets or clears it. It likewise never sets or clears `mahiro_sidebar_model` or `mahiro_sidebar_context`.

Agy quota is eligible only for an inventory entry whose `agent` is exactly `agy` and which is not launch-pending. Agy values are account-level shared pools, not active-session attribution.

## Fail-closed behavior

Missing, stale, oversized, malformed, symlinked, non-regular, future-dated, or explicitly failed caches are unavailable. Unknown providers and labels are not inferred. The adapter sends a complete set-or-clear decision for every token it owns, so unavailable input clears its quota presentation. Errors never trigger credential reads, raw payload reads, pane-content inspection, collection, or network fallback.
