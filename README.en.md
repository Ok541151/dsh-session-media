# dsh-session-media

> A **session-archive layer** for DeepSeek Harness: after any new session starts, the model knows what already happened in this project — including the images and documents those past sessions carried.

## What it does

| Capability | Notes |
|---|---|
| **Auto memory** | One Markdown file per workspace, injected into the system prompt every turn. Edit the file, it takes effect next turn — no restart |
| **History search** | Keyword search across every past session over user text, assistant text, the **session title** and **tool-call arguments** (commands, paths, URLs); space-separated keywords are AND; optional time window and workspace filter. Snippets are centred on the match |
| **Attachment recovery** | List images/files carried by a session, return the original local path, copy them out in bulk |

## Relationship to existing plugins

**Complementary, not a competitor.**

- `dsh-memory` — durable facts in SQLite FTS5. Not our job.
- `dsh-session-recall` — session search through the official `ctx.sessionQuery` seam with FTS5, millisecond queries. We do **not** try to beat it.
- **This plugin** — attachment retrieval plus automatic memory injection.

Search here is a linear keyword scan (cold start ≈ 12 s). For fast retrieval use `dsh-session-recall`; for getting the screenshots back out, use this.

## Tools

`session_search` (AND keywords, time window, workspace filter, `matches` count, attachment list) · `session_read` (paginated: `offset`/`limit`, returns `total`/`hasMore`/`nextOffset`; or `around` + `span` to jump straight to a hit reported by `at`) · `session_media` (list, filter, bulk copy out) · `memory_doctor` (health, `fix`, staleness nudge), plus one prompt section `plugin:memory`.

## Install

Manual (same path as other local plugins):

1. Put the package anywhere, e.g. `C:\AgentTools\plugins\dsh-session-media`
2. Add to `profiles/web/package.json` → `dependencies`: `"dsh-session-media": "file:C:/AgentTools/plugins/dsh-session-media"`
3. Append the same name to `dsh.profile.bundles`
4. `pnpm install` inside `profiles/web`
5. Restart DSH Desktop

`file:` dependencies are **copied**, not symlinked, and HMR does not swap already-loaded modules — restart after editing.

## Limits

- Keyword search only, over user text, assistant text, the session title and tool-call arguments; no semantic retrieval.
- Depends on the archive format (`session.v3/v4.jsonl.zstd`, multi-frame zstd). Unknown versions are skipped with a warning, not adapted.
- Images are returned as paths; nothing is OCR'd.
- Credentials are masked before indexing (sk-/ghp_/npm_/AKIA prefixes and token=/password: forms). Best effort only — it is not a substitute for keeping secrets out of the workspace.

## Testing

```bash
node cismoke.mjs              # CI smoke, no real sessions needed
node selftest.mjs             # full local suite (17 checks)
node selftest.mjs --no-evict  # skip the eviction case that rewrites the index
```

## License

MIT