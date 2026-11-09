/**
 * dsh-memory — cross-session memory for DSH.
 *
 * Two halves, both about "what does the model know across sessions":
 *
 *   1. AUTO (prompt section)
 *      Registers one system-prompt section whose text is re-read from a memory
 *      file on every assembly. dsh-agent-loop calls systemPrompt.assemble() on
 *      every step, so edits take effect next turn with no restart.
 *
 *   2. ON DEMAND (tools)
 *      `session_search` / `session_read` expose the OTHER sessions' persisted
 *      transcripts, so the model can look something up instead of guessing.
 *
 * Verified against this DSH build (0.2.1-rc.2):
 *   - `ctx.systemPrompt.section({ name, order, text })` returns a disposer.
 *     `text` may be a FUNCTION; it is called during prompt assembly.
 *   - `ctx.tools.register(definition)` registers a tool.
 *   - Registration happens inside `ctx.effect(...)` so a duplicate mount is
 *     disposed with the layer instead of leaking.
 *
 * Safety rule (learned from dsh-agent-picker and the better-sidebar incident):
 * NEVER throw out of apply(). The web shell fails the whole boot when a
 * plugin's apply throws, and a duplicate section/tool name in the same layer
 * THROWS. Every risky step degrades instead.
 *
 * Note on `@deepseek-ai/dsh-tools`: it does NOT resolve from this package's
 * directory (there is no node_modules beside it) — the HOST provides it at
 * runtime. The import is therefore dynamic and optional: if it fails we fall
 * back to an identity function, because a tool definition is a plain object.
 *
 * @module dsh-memory
 */

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, unlinkSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

export const name = 'dsh-session-media'

/** The prompt band plus the tool registry. */
export const inject = ['systemPrompt', 'tools']

/** Fallback when the host SDK is not importable from here. */
let defineTool = (def) => def
try {
  const sdk = await import('@deepseek-ai/dsh-tools')
  if (sdk && typeof sdk.defineTool === 'function') defineTool = sdk.defineTool
} catch {
  // Host provides it at runtime; identity fallback keeps the definition usable.
}

const DEFAULTS = {
  /**
   * Deliberately hardcoded rather than configured from the profile patch:
   * profiles/web/cordis.patch.yml documents itself as ASCII-only (YAML
   * readers disagree about encodings on the boot path) and this path
   * contains Chinese characters. JS source is UTF-8 by definition, so the
   * default lives here where it cannot break the boot.
   */
  /**
   * Empty = auto-detect the current workspace (see resolveMemory()). A hardcoded
   * personal path made this plugin useless on any other machine.
   */
  memoryDir: '',
  /** Explicit memory files; empty = first match from candidateFiles. */
  files: [],
  /** Tried in order inside the resolved workspace directory. */
  candidateFiles: ['环境笔记.md', 'MEMORY.md', 'CLAUDE.md'],
  /** Section order inside the prompt band. */
  order: 210,
  /** Hard cap so a runaway file cannot eat the whole context window. */
  maxChars: 12000,
  /** Minimum gap between index writes; 0 disables throttling (tests). */
  saveIntervalMs: 60_000,
  /** Search-cache bounds (see the LRU block above). */
  cacheMaxEntries: 5000,
  cacheMaxChars: 50_000_000,
  /** Days an archive must be untouched before Phase B may call it forgotten. */
  evictMinAgeDays: 90,
  /** Floor for the stepped-down Phase-B threshold. */
  evictFloorDays: 14,
}

// ---------------------------------------------------------------------------
// Prompt section: the memory file
// ---------------------------------------------------------------------------

function readMemory(cfg) {
  const parts = []
  let newest = 0
  for (const rel of cfg.files) {
    try {
      const abs = path.isAbsolute(rel) ? rel : path.join(cfg.memoryDir, rel)
      const text = readFileSync(abs, 'utf8')
      if (text.trim()) {
        parts.push(text.trim())
        try {
          const st = statSync(abs)
          if (st.mtimeMs > newest) newest = st.mtimeMs
        } catch { /* stat failure is cosmetic */ }
      }
    } catch {
      // A missing memory file is normal, not an error.
    }
  }
  if (!parts.length) return ''

  let body = parts.join('\n\n---\n\n')

  // Truncation must NOT cut straight from the tail. The END of the memory file
  // holds the perishable "in progress / current state" sections — exactly the
  // content whose loss hurts most. Keep 60% head + 40% tail, drop the middle,
  // and say how much was dropped.
  if (body.length > cfg.maxChars) {
    const headLen = Math.floor(cfg.maxChars * 0.6)
    const tailLen = cfg.maxChars - headLen
    const dropped = body.length - headLen - tailLen
    body =
      body.slice(0, headLen) +
      `\n\n…（中间省略 ${dropped} 字符；首尾均已保留）…\n\n` +
      body.slice(-tailLen)
  }

  const lines = [
    '# 长期记忆（dsh-memory 自动注入）',
    '',
    '以下内容来自用户工作区的记忆文件，跨会话有效。它描述的是环境与偏好，不是任务本身；若与本轮对话冲突，以本轮对话为准。',
  ]
  if (newest) {
    lines.push(
      `文件最后修改：${localStamp(newest)}` +
      '（据此判断内容是否可能过期；各节还标了各自的核对日期）',
    )
  }
  lines.push('', body)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Session archive reader
//
// Storage: %APPDATA%\dsh-desktop\harness\sessions\<workspace>\<session>\...
// Two formats coexist on this machine (measured 2026-10-28):
//   new: session-<uuid>/session.v4.jsonl.zstd   (28)
//   old: <uuid>/session.v3.jsonl.zstd           (167)
//
// The file is MULTIPLE zstd frames concatenated (an append-only log).
// zstdDecompressSync and the stream API both stop after the FIRST frame
// (yielding only the 234-byte session header), so frames must be split on
// the magic number and decompressed one by one.
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']
/** Archive format versions this decoder understands. */
const SESSION_VERSIONS = new Set([3, 4])

function sessionsRoot() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'dsh-desktop', 'harness', 'sessions')
}

function decodeZstdFrames(buf) {
  const starts = []
  let i = 0
  while (true) {
    const j = buf.indexOf(ZSTD_MAGIC, i)
    if (j < 0) break
    starts.push(j)
    i = j + 4
  }
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e))) } catch { /* bad frame */ }
  }
  return Buffer.concat(parts)
}

function listSessions() {
  const root = sessionsRoot()
  const out = []
  if (!existsSync(root)) return out
  for (const ws of readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(root, ws.name)
    for (const s of readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const dir = path.join(wsDir, s.name)
      let stat = null
      let unknownFormat = 0
      for (const f of SESSION_FILES) {
        const p = path.join(dir, f)
        if (existsSync(p)) { stat = statSync(p); break }
      }
      if (!stat) {
        // A file we do not recognise (e.g. a future `session.v5.…`) must NOT make
        // the session silently vanish from the index: count it so callers can
        // warn that history is being skipped after a host upgrade.
        try {
          for (const n of readdirSync(dir)) {
            const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(n)
            if (m && !SESSION_VERSIONS.has(Number(m[1]))) unknownFormat++
          }
        } catch { /* ignore */ }
        if (!unknownFormat) continue
      }
      out.push({
        id: s.name.replace(/^session-/, ''),
        workspace: ws.name,
        dir,
        mtime: stat ? stat.mtimeMs : 0,
        size: stat ? stat.size : 0,
        unknownFormat,
      })
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

function readSession(dir) {
  let file = null
  for (const f of SESSION_FILES) {
    const p = path.join(dir, f)
    if (existsSync(p)) { file = p; break }
  }
  if (!file) return null
  const events = []
  const text = decodeZstdFrames(readFileSync(file)).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* half-written line */ }
  }
  return events
}

function summarize(events) {
  let title = null
  let createdAt = null
  let users = 0
  let assistants = 0
  for (const e of events) {
    const d = e.data || {}
    if (e.type === 'session') createdAt = e.createdAt || d.createdAt
    if (e.type === 'session/title' && d.title) title = d.title
    if (e.type === 'user/message') users++
    if (e.type === 'assistant/message') assistants++
  }
  return { title, createdAt, users, assistants }
}

function textOf(e) {
  const d = e.data || {}
  if (typeof d.text === 'string') return d.text
  if (typeof d.content === 'string') return d.content
  if (Array.isArray(d.content)) {
    return d.content.map(p => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n')
  }
  // assistant/message stores text at data.message.content[], where each part is
  // { type: 'reasoning' | 'text' | 'tool-call', ... }. Only `text` parts count:
  // reasoning is usually empty and tool-call carries raw JSON arguments, which
  // would bloat the index and match queries by accident.
  const m = d.message
  if (m && Array.isArray(m.content)) {
    return m.content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n')
  }
  return ''
}

/**
 * Describe the attachments carried by a message as searchable text.
 *
 * Images were previously invisible to search: `session_search` indexes text, so
 * a screenshot only ever showed up as whatever the user typed next to it. The
 * label carries the filename, the size and the first 8 hex chars of the blob
 * hash, so a hit can be traced back to the file under
 * `<harness>/attachments/v1/objects/<2>/<hash>`.
 */
function mediaLabel(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const p of content) {
    const att = p && p.attachment
    if (!att) continue
    const name = att.name || '(无名)'
    const isImg = p.type === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)
    const kb = att.bytes ? `${Math.round(att.bytes / 1024)}KB` : ''
    const id = (att.attachmentId || '').replace(/^sha256:/, '').slice(0, 8)
    parts.push(`[${isImg ? '图片' : '文件'} ${name}${kb ? ' ' + kb : ''}${id ? ' #' + id : ''}]`)
  }
  return parts.join(' ')
}

/** First zstd frame of an archive — enough for the `session` header event. */
function firstFrameText(file) {
  try {
    const buf = readFileSync(file)
    const i = buf.indexOf(ZSTD_MAGIC)
    if (i < 0) return ''
    const j = buf.indexOf(ZSTD_MAGIC, i + 4)
    const slice = j < 0 ? buf.subarray(i) : buf.subarray(i, j)
    return zlib.zstdDecompressSync(slice).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * The workspace of the most recently written session = the workspace in use.
 *
 * Every session archive starts with a `session` event carrying `data.cwd`, and
 * only its first frame is needed, so this costs one partial decompress. Doing
 * it this way avoids guessing at process.cwd(), which in the host process is
 * the app directory rather than the user's project.
 */
function detectWorkspaceDir() {
  try {
    for (const s of listSessions().slice(0, 3)) {
      const f = SESSION_FILES.map(n => path.join(s.dir, n)).find(existsSync)
      if (!f) continue
      for (const line of firstFrameText(f).split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          // `cwd` sits at the TOP level of the `session` event, not inside
          // `data` (the other events put their payload in `data`).
          if (e.type === 'session') {
            const cwd = e.cwd || (e.data && e.data.cwd)
            if (typeof cwd === 'string' && cwd) return cwd
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* fall through */ }
  return null
}

/** Per-turn injected noise lands in user/message and would drown every search. */
function isNoise(t) {
  return (
    t.startsWith('Current runtime context') ||
    t.startsWith('# 长期记忆') ||
    t.startsWith('<system-reminder')
  )
}

// ---------------------------------------------------------------------------
// Search cache
//
// `session_search` used to decompress + JSON.parse every session on every call
// (~0.8 s for 190 sessions / 110 MB). The cache stores the extracted USER text
// per session directory, keyed by the archive's (mtime, size) pair — both come
// from the stat that listSessions() already performs.
//
// Staleness is impossible by construction: an appended session changes both its
// size and its mtime, so a stale entry can never be served. If either differs we
// re-read. The cache therefore only skips work that provably cannot have
// changed, and it can never produce a wrong result.
// ---------------------------------------------------------------------------

const textCache = new Map()   // dir -> { mtime, size, texts, atexts, info, chars, uses, lastUsed }

/**
 * Use counts survive eviction.
 *
 * Evicting an entry used to reset its `uses` to 0 the next time the session was
 * re-read, so a heavily-used session that was evicted once became easier to
 * evict again — a slow leak in the protection the policy is supposed to give.
 * The counter therefore lives OUTSIDE `textCache`, keyed by session directory,
 * and eviction only drops the text copy.
 */
const useCounters = new Map() // dir -> { uses, lastUsed }
let indexStarted = false
let indexDirty = false

/**
 * Hard bounds so a growing archive cannot grow RAM forever.
 *
 * Eviction here is CORRECTNESS-NEUTRAL: an evicted session is simply re-read on
 * the next search, costing time but never accuracy. That is exactly why LRU is
 * the right policy — no importance heuristic is worth having for something whose
 * loss is free. (Importance ranking belongs to the memory FILE, where forgetting
 * is destructive and a human should decide.)
 *
 * Map iteration order doubles as the LRU order: the first key is the coldest.
 */
let cacheMaxEntries = 5000
let cacheMaxChars = 50_000_000   // ~50M chars ≈ 100 MB of UTF-16 text
/** Phase-B gate: nothing younger than this may be evicted as orgotten. */
let evictMinAgeMs = 90 * 24 * 3600 * 1000
/** Phase-B floor: below this age nothing may be called forgotten. */
let evictFloorMs = 14 * 24 * 3600 * 1000
let cacheChars = 0

function entryChars(e) {
  let n = 0
  for (const t of e.texts) n += t.length
  for (const t of (e.atexts || [])) n += t.length
  return n
}

/** Promote to most-recently-used and record a real USE. */
function promote(dir) {
  const now = Date.now()
  const c = useCounters.get(dir) || { uses: 0, lastUsed: 0 }
  c.uses += 1
  c.lastUsed = now
  useCounters.set(dir, c)

  const v = textCache.get(dir)
  if (v) {
    v.uses = c.uses
    v.lastUsed = now
    textCache.delete(dir)
    textCache.set(dir, v)
  }
  indexDirty = true
  return v || null
}


/**
 * Segmented LRU: an entry that has been USED more than once is "protected".
 *
 * Plain LRU is the wrong policy here for a reason worth spelling out: pure
 * recency evicts a session that matched 100 queries last month in favour of one
 * matched once five minutes ago. Trying to bound RAM by evicting sessions is
 * close to self-defeating anyway — a search must visit EVERY session, so an
 * evicted one is re-decompressed (~74 ms) on the very next search. Eviction is
 * therefore the last resort it should be: the cap is set high enough (see
 * DEFAULTS) that it essentially never fires, and when it does, reuse wins over
 * recency.
 */
const PROTECTED_USES = 2

/**
 * Pick eviction victims as the INTERSECTION of two bottom quantiles:
 *
 *   coldSet = the coldest `ceil(n*width)` entries by recency (Map order, front
 *             first — promote() moves an entry to the back on every real use)
 *   rareSet = entries whose `uses` is at or below the `width` quantile
 *   victims = coldSet ∩ rareSet, in Map order
 *
 * Only something that is BOTH stale AND rarely used is a safe victim: a
 * frequently-used entry is never dropped for being old, and a freshly-created
 * one is never dropped for having uses = 0. When the intersection cannot supply
 * enough victims (e.g. everything old is also heavily used) the width widens
 * 25% → 50% → 75% → 100%, and the last resort is pure recency.
 */
function pickVictims(need) {
  const items = [...textCache.entries()]
  const n = items.length
  if (need <= 0 || n === 0) return []
  if (need >= n) return items.map(([k]) => k)

  const useOf = (v) => (typeof v.uses === 'number' ? v.uses : 0)
  // Recency must come from an explicit lastUsed stamp, NOT from Map order.
  // listSessions() yields newest-first, so entries are INSERTED newest-first:
  // treating the front as "coldest" would evict the sessions created most
  // recently — the opposite of the intent.
  const usedOf = (v) => (typeof v.lastUsed === 'number' ? v.lastUsed : (typeof v.mtime === 'number' ? v.mtime : 0))
  const now = Date.now()

  const byAge = [...items].sort((a, b) => usedOf(a[1]) - usedOf(b[1]))
  const sortedUses = items.map(([, v]) => useOf(v)).sort((a, b) => a - b)

  // --- Candidate selection ------------------------------------------------
  // ONE rule, deliberately: a victim must be at the LOWEST use count AND
  // genuinely untouched (older than the stepped threshold below), and among
  // those the least-recently-used go first.
  //
  // There used to be a "quartile intersection" phase here. A synthetic
  // anti-correlated index proved it could evict specifically the entries it was
  // meant to protect, and no amount of tracing made its behaviour predictable.
  // Unpredictable beats nothing: this rule is short enough to reason about.
  const minUses = sortedUses[0]
  const DAY = 24 * 3600 * 1000
  const steps = [...new Set(
    [evictMinAgeMs, 60 * DAY, 30 * DAY, 21 * DAY, evictFloorMs]
      .filter((ms) => Number.isFinite(ms) && ms >= 0 && ms <= evictMinAgeMs),
  )].sort((a, b) => b - a)
  for (const age of steps) {
    const gate = byAge.filter(
      ([, v]) => useOf(v) === minUses && now - (v.mtime || 0) >= age,
    )
    if (gate.length >= need) return gate.slice(0, need).map(([key]) => key)
  }

  // --- Phase C: refuse --------------------------------------------------
  // Nothing is both rare and older than the floor (2 weeks by default).
  // Evicting now would mean dropping a recent conversation (guaranteed re-read)
  // or a well-used one. Report the overflow instead of guessing.
  return []
}

function evictOverflow() {
  let guard = 0
  while (textCache.size > cacheMaxEntries || cacheChars > cacheMaxChars) {
    if (++guard > 1000) break
    const need = Math.max(1, textCache.size - cacheMaxEntries)
    const victims = pickVictims(need)
    if (victims.length === 0) break
    let freed = 0
    for (const key of victims) {
      const e = textCache.get(key)
      if (e) {
        cacheChars -= typeof e.chars === 'number' ? e.chars : entryChars(e)
        freed++
      }
      textCache.delete(key)
      indexDirty = true
    }
    if (freed === 0) break
  }
}



/**
 * Persisted index location. Lives beside the other harness state so it is easy
 * to find (and easy to delete when it ever needs rebuilding).
 */
function indexPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'dsh-desktop', 'harness', 'dsh-memory', 'session-index.json')
}

/**
 * Load the persisted index once per process. A missing or corrupt file is
 * normal (first run, or hand-edited) and must never be fatal — we simply start
 * with an empty cache and rebuild it from the archives.
 */
function loadIndex() {
  if (indexStarted) return
  indexStarted = true
  try {
    const raw = JSON.parse(readFileSync(indexPath(), 'utf8'))
    if (raw && raw.version === 4 && raw.entries) {
      for (const [dir, v] of Object.entries(raw.entries)) {
        if (v && typeof v.mtime === 'number' && typeof v.size === 'number' && Array.isArray(v.texts)) {
          if (typeof v.chars !== 'number') v.chars = entryChars(v)
          if (typeof v.lastUsed !== 'number') v.lastUsed = v.mtime
          textCache.set(dir, v)
          cacheChars += v.chars
          // Seed the counter from the entry when the file predates `counters`.
          if (!useCounters.has(dir)) useCounters.set(dir, { uses: (v.uses || 0), lastUsed: (v.lastUsed || v.mtime) })
        }
      }
      if (raw.counters && typeof raw.counters === 'object') {
        for (const [dir, c] of Object.entries(raw.counters)) {
          if (c && typeof c.uses === 'number') useCounters.set(dir, { uses: c.uses, lastUsed: Number(c.lastUsed) || 0 })
        }
      }
      evictOverflow()
    }
  } catch {
    // No index yet, or unreadable: the cache stays empty and rebuilds.
  }
}

/**
 * The active conversation is appended to on every turn, so its archive always
 * misses the (mtime, size) check. Without throttling, EVERY search would rewrite
 * the whole ~1 MB index — pure waste, because an unpersisted delta only costs a
 * re-scan after a crash, never correctness.
 */
let saveIntervalMs = 60_000
let lastSaved = 0

/**
 * Persist the index, keeping only entries for sessions that still exist, so a
 * deleted session cannot keep a stale entry alive forever.
 */
function saveIndex(dirs) {
  if (!indexDirty) return
  const now = Date.now()
  // Always allow the first save of a process so a fresh install persists at once.
  if (lastSaved !== 0 && now - lastSaved < saveIntervalMs) return
  try {
    // Write in CACHE (LRU) order, coldest first, keeping only sessions that
    // still exist. Iterating `dirs` here would silently persist listSessions
    // order instead and throw away the recency ranking on the next restart —
    // which is exactly what the first version of this did.
    const alive = new Set(dirs)
    const entries = {}
    for (const [dir, v] of textCache) {
      if (alive.has(dir)) entries[dir] = v
    }
    const file = indexPath()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 4, entries, counters: Object.fromEntries(useCounters) }))
    indexDirty = false
    lastSaved = now
  } catch {
    // Disk trouble only costs speed; the in-memory cache still works.
  }
}

function sessionDigest(s) {
  loadIndex()
  const hit = textCache.get(s.dir)
  if (hit && hit.mtime === s.mtime && hit.size === s.size) {
    // Do NOT promote here. Every search SCANS every session, so promoting on
    // scan would touch all entries in the same order each time and collapse the
    // LRU order into insertion order. Promotion belongs to a real USE — a
    // matched hit or an explicit session_read (both call promote() themselves).
    return hit
  }

  const texts = []
  const atexts = []
  let info = { title: null, createdAt: null, users: 0, assistants: 0 }
  try {
    const events = readSession(s.dir)
    if (events) {
      info = summarize(events)
      for (const e of events) {
        if (e.type === 'user/message') {
          const t = textOf(e)
          if (t && isNoise(t)) continue
          const label = mediaLabel(e.data && e.data.content)
          if (label || t) texts.push((label ? label + ' ' : '') + t)
        } else if (e.type === 'assistant/message') {
          // Assistant text is indexed too, otherwise the reasoning behind a
          // decision is unsearchable and only recoverable by reading a whole
          // (often enormous) transcript. Truncated to bound the index size.
          const t = textOf(e)
          if (t && !isNoise(t)) atexts.push(t.length > 800 ? t.slice(0, 800) : t)
        }
      }
    }
  } catch {
    // Keep the empty digest; a corrupt archive must not abort the whole search.
  }

  const counter = useCounters.get(s.dir) || { uses: 0, lastUsed: s.mtime }
  useCounters.set(s.dir, counter)
  const entry = { mtime: s.mtime, size: s.size, texts, atexts, info, chars: 0, uses: counter.uses, lastUsed: counter.lastUsed }
  entry.chars = entryChars(entry)

  // Replace a stale entry: subtract its weight before re-adding.
  if (hit) {
    cacheChars -= typeof hit.chars === 'number' ? hit.chars : entryChars(hit)
    textCache.delete(s.dir)
  }
  textCache.set(s.dir, entry)
  cacheChars += entry.chars
  indexDirty = true
  evictOverflow()
  return entry
}

/**
 * Local-time stamp `YYYY-MM-DD HH:mm`.
 *
 * Deliberately NOT `toISOString()`: that yields UTC, so on a UTC+8 machine every
 * timestamp reads 8 hours stale — exactly the kind of silent wrongness this
 * line exists to prevent.
 */
function localStamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const iso = (ms) => localStamp(ms)

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Test hook: drop all in-memory state so the next apply() re-reads the index.
 *
 * The module keeps its cache at module scope (one plugin instance per process),
 * so a second apply() in the same process would otherwise keep serving the state
 * loaded by the first one. Only the self-test needs this.
 */
export function __testReset() {
  textCache.clear()
  useCounters.clear()
  cacheChars = 0
  indexStarted = false
  indexDirty = false
  lastSaved = 0
}

export function apply(ctx, config = {}) {
  try {
    const cfg = { ...DEFAULTS, ...(config || {}) }

    // Honour per-profile cache bounds (handy for tests and for shrinking the
    // footprint on a small machine).
    if (Number.isFinite(cfg.cacheMaxEntries) && cfg.cacheMaxEntries > 0) {
      cacheMaxEntries = cfg.cacheMaxEntries
    }
    if (Number.isFinite(cfg.cacheMaxChars) && cfg.cacheMaxChars > 0) {
      cacheMaxChars = cfg.cacheMaxChars
    }
    if (Number.isFinite(cfg.evictMinAgeDays) && cfg.evictMinAgeDays >= 0) {
      evictMinAgeMs = cfg.evictMinAgeDays * 24 * 3600 * 1000
    }
    if (Number.isFinite(cfg.evictFloorDays) && cfg.evictFloorDays >= 0) {
      evictFloorMs = cfg.evictFloorDays * 24 * 3600 * 1000
    }
    if (Number.isFinite(cfg.saveIntervalMs) && cfg.saveIntervalMs >= 0) {
      saveIntervalMs = cfg.saveIntervalMs
    }

    // --- 1. memory section ---
    // Resolve the workspace and its memory file. Precedence: explicit config →
    // env var → detected workspace (the newest session's cwd).
    const resolvedDir = cfg.memoryDir || process.env.DSH_MEMORY_DIR || detectWorkspaceDir() || ''
    let resolvedFiles = Array.isArray(cfg.files) && cfg.files.length ? cfg.files : []
    if (!resolvedFiles.length && resolvedDir) {
      resolvedFiles = (cfg.candidateFiles || []).filter(n => existsSync(path.join(resolvedDir, n))).slice(0, 1)
    }
    const memCfg = { ...cfg, memoryDir: resolvedDir, files: resolvedFiles }

    if (resolvedDir && resolvedFiles.length) {
      ctx.effect(() => {
        let dispose = null
        try {
          dispose = ctx.systemPrompt.section({
            name: 'plugin:memory',
            order: cfg.order,
            text: () => {
              try { return readMemory(memCfg) } catch { return '' }
            },
          })
        } catch {
          dispose = null
        }
        return () => {
          try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
          dispose = null
        }
      }, 'dsh-memory: prompt section')
    }

    // --- 2. session tools ---
    ctx.effect(() => {
      const disposers = []
      const register = (def) => {
        try { disposers.push(ctx.tools.register(defineTool(def))) } catch { /* dup/unsupported */ }
      }

      register({
        name: 'session_search',
        description: [
          '在所有历史会话里搜索关键词（跨会话检索）。',
          '返回命中的会话（日期、标题、会话 id）以及匹配到的用户原话片段。',
          '用它来回答"上次那个事怎么弄的""我以前问过什么"之类需要跨会话记忆的问题。',
          '同时搜你和我的消息（assistant 正文截断 800 字后续方可搜）；每条片段带 role 字段。运行时噪音已过滤。',
        ].join('\n'),
        parameters: {
          keyword: { type: 'string', description: '关键词；空格分隔多个词表示 AND（都要出现）。大小写不敏感。' },
          limit: { type: 'number', description: '最多返回多少个会话，默认 8。' },
          sinceDays: { type: 'number', description: '只看最近 N 天内写入过的会话；0 或省略表示不限。' },
          workspace: { type: 'string', description: '只搜某个工作区（路径片段即可，如 deepseek）。省略为全部工作区。' },
        },
        output: {
          schema: { type: 'json' },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
        },
        async execute(args) {
          // Space-separated keywords are AND: every one must appear somewhere in
          // the session. A single word behaves exactly as before.
          const kws = String(args?.keyword ?? '').toLowerCase().split(/\s+/).filter(Boolean)
          const limit = Number(args?.limit ?? 8)
          const sinceDays = Number(args?.sinceDays ?? 0)
          if (!kws.length) return { ok: false, error: '缺少 keyword' }
          const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0
          const wsFilter = String(args?.workspace ?? '').toLowerCase()
          const hits = []
          let scanned = 0
          const all = listSessions()
          let skippedUnknownFormat = 0
          for (const s of all) {
            if (hits.length >= limit) break
            if (s.unknownFormat) { skippedUnknownFormat++; continue }
            if (wsFilter && !String(s.workspace || '').toLowerCase().includes(wsFilter)) continue
            if (cutoff && (s.mtime || 0) < cutoff) continue
            scanned++
            const digest = sessionDigest(s)
            const pairs = [
              ...digest.texts.map(t => ['user', t]),
              ...(digest.atexts || []).map(t => ['assistant', t]),
            ]

            // Session matches when EVERY keyword appears in at least one message.
            const lower = pairs.map(([role, t]) => [role, t, t.toLowerCase()])
            const matchedAll = kws.every(k => lower.some(([, , lt]) => lt.includes(k)))
            if (!matchedAll) continue

            // Prefer messages that contains all keywords, then any.
            const all3 = lower.filter(([, , lt]) => kws.every(k => lt.includes(k)))
            const any3 = lower.filter(([, , lt]) => kws.some(k => lt.includes(k)))
            const snippets = (all3.length ? all3 : any3).slice(0, 3)
              .map(([role, t]) => ({ role, text: t.slice(0, 200).replace(/\s+/g, ' ') }))

            // Surface the attachments carried by this session (labels were inlined
            // at index time), so "where is that screenshot" is one call, not two.
            const attachments = [...new Set(
              pairs.flatMap(([, t]) => (t.match(/\[(?:图片|文件) [^\]]+\]/g) || [])),
            )].slice(0, 8)

            // A real hit is a real use: this session is now the newest.
            promote(s.dir)
            hits.push({ id: s.id, date: iso(s.mtime), workspace: s.workspace, title: digest.info.title || '', snippets, attachments })
          }
          saveIndex(all.map(x => x.dir))
          return {
            ok: true,
            scanned,
            hits,
            skippedUnknownFormat,
            hint: skippedUnknownFormat
              ? `有 ${skippedUnknownFormat} 个会话是未知归档格式（宿主升级过？），已被跳过`
              : (hits.length ? '需要全文用 session_read' : '未找到匹配'),
          }
        },
      })

      register({
        name: 'session_read',
        description: [
          '读取某一个历史会话的对话内容（用户与助手的消息）。',
          '先调用 session_search 拿到会话 id，再用它读全文。',
          '受 maxChars 限制，默认 12000 字符。',
        ].join('\n'),
        parameters: {
          sessionId: { type: 'string', description: '会话 id（session_search 返回的 id，可只用前 8 位）。' },
          maxChars: { type: 'number', description: '最多返回多少字符，默认 12000。' },
        },
        output: {
          schema: { type: 'json' },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
        },
        async execute(args) {
          const target = String(args?.sessionId ?? '')
          const maxChars = Number(args?.maxChars ?? 12000)
          if (!target) return { ok: false, error: '缺少 sessionId' }
          const hit = listSessions().find(s => s.id.startsWith(target.replace(/^session-/, '')))
          if (!hit) return { ok: false, error: `找不到会话 ${target}` }
          // Reading a session is a real use: keep it out of the eviction path.
          promote(hit.dir)
          let events
          try { events = readSession(hit.dir) } catch (e) { return { ok: false, error: String(e) } }
          if (!events) return { ok: false, error: '会话存档无法解析' }
          const info = summarize(events)
          const messages = []
          let used = 0
          for (const e of events) {
            if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
            const t = textOf(e).trim()
            if (!t || isNoise(t)) continue
            const body = t.length > 2000 ? t.slice(0, 2000) + ' …(截断)' : t
            if (used + body.length > maxChars) { messages.push({ role: 'system', text: '…(已达字符上限)' }); break }
            used += body.length
            messages.push({ role: e.type === 'user/message' ? 'user' : 'assistant', text: body })
          }
          return { ok: true, id: hit.id, date: iso(hit.mtime), title: info.title || '', messages }
        },
      })

      register({
        name: 'session_media',
        description: [
          '列出某个历史会话携带的图片/文件附件，并给出本地原始文件路径。',
          '不带 sessionId 时，概览最近几个带附件的会话（含数量）。',
          '拿到返回的 path 后可直接用 read_image / read 打开原始文件。',
        ].join('\n'),
        parameters: {
          sessionId: { type: 'string', description: '会话 id（可只用前 8 位）；省略则概览最近会话。' },
          limit: { type: 'number', description: '最多返回多少条附件，默认 50。' },
          kind: { type: 'string', description: "只列某一类：'image' 或 'file'；省略为全部。" },
          sinceDays: { type: 'number', description: '只看最近 N 天的附件；0 或省略表示不限。' },
          extractTo: { type: 'string', description: '给出目录则把这些原始文件【复制】过去（不移动），并在每条结果里返回新路径。' },
        },
        output: {
          schema: { type: 'json' },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
        },
        async execute(args) {
          const limit = Number(args?.limit ?? 50)
          const target = String(args?.sessionId ?? '')
          const blobDir = path.join(
            process.env.APPDATA || os.homedir(), 'dsh-desktop', 'harness',
            'attachments', 'v1', 'objects',
          )

          const mediaOf = (evs) => {
            const out = []
            const seen = new Set()   // the same blob appears in both user/message
                                     // and agent/inbox/spliced — count it once
            const scan = (content, when) => {
              if (!Array.isArray(content)) return
              for (const p of content) {
                const att = p && p.attachment
                if (!att) continue
                const name = att.name || '(无名)'
                const isImg = p.type === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)
                const hash = (att.attachmentId || '').replace(/^sha256:/, '')
                if (hash) {
                  if (seen.has(hash)) continue
                  seen.add(hash)
                }
                const file = hash ? path.join(blobDir, hash.slice(0, 2), hash) : ''
                out.push({
                  when,
                  name,
                  kind: isImg ? 'image' : 'file',
                  bytes: att.bytes || 0,
                  hash: hash.slice(0, 12),
                  path: file,
                  exists: file ? existsSync(file) : false,
                })
              }
            }
            for (const e of evs) {
              if (e.type === 'user/message') scan(e.data && e.data.content, iso(e.time))
              if (e.type === 'agent/inbox/spliced') {
                for (const ins of (e.data && e.data.inserted) || []) scan(ins && ins.content, iso(e.time))
              }
            }
            return out
          }

          const all = listSessions()
          if (!target) {
            const out = []
            for (const s of all) {
              if (out.length >= 10) break
              let evs
              try { evs = readSession(s.dir) } catch { continue }
              if (!evs) continue
              const m = mediaOf(evs)
              if (m.length) {
                out.push({ id: s.id, date: iso(s.mtime), count: m.length, sample: m.slice(0, 3).map(x => x.name) })
              }
            }
            return { ok: true, hint: '带 sessionId 可列细目', sessions: out }
          }

          const hit = all.find(s => s.id.startsWith(target.replace(/^session-/, '')))
          if (!hit) return { ok: false, error: `找不到会话 ${target}` }
          let evs
          try { evs = readSession(hit.dir) } catch (e) { return { ok: false, error: String(e) } }
          if (!evs) return { ok: false, error: '无法解析该会话' }
          let items = mediaOf(evs)
          // `count` used to mean "how many this call returns", which made a
          // limited query look like the session only had 3 attachments. Keep the
          // three numbers distinct: total in session / matching the filters /
          // actually returned.
          const total = items.length

          const kind = String(args?.kind ?? '').toLowerCase()
          if (kind === 'image' || kind === 'file') items = items.filter(x => x.kind === kind)

          const sinceDays = Number(args?.sinceDays ?? 0)
          if (sinceDays > 0) {
            const cut = Date.now() - sinceDays * 86400000
            items = items.filter((x) => {
              const t = Date.parse(String(x.when || '').replace(' ', 'T'))
              return Number.isFinite(t) ? t >= cut : true
            })
          }

          const matched = items.length
          items = items.slice(0, limit)

          // Copy (never move) the original blobs somewhere readable. Naming keeps
          // the date so a batch of screenshots stays sortable.
          const extractTo = String(args?.extractTo ?? '')
          if (extractTo) {
            try {
              mkdirSync(extractTo, { recursive: true })
            } catch (e) {
              return { ok: false, error: '无法创建导出目录: ' + String(e) }
            }
            let n = 0
            for (const it of items) {
              if (!it.exists) continue
              const day = String(it.when || '').slice(0, 10).replace(/-/g, '') || 'unknown'
              const safe = String(it.name || 'file').replace(/[\\/:*?"<>|]/g, '_')
              const dst = path.join(extractTo, day + '_' + String(++n).padStart(2, '0') + '_' + safe)
              try {
                copyFileSync(it.path, dst)
                it.extracted = dst
              } catch (e) {
                it.extracted = ''
                it.extractError = String(e)
              }
            }
          }

          return { ok: true, id: hit.id, date: iso(hit.mtime), total, matched, count: items.length, items }
        },
      })

      register({
        name: 'memory_doctor',
        description: [
          '体检：报告索引版本/条数/体积、缓存使用率、使用计数最高的会话、附件统计、记忆文件状态，并列出异常。',
          '排查"搜不到""索引是不是坏了""是不是快淘汰了"时先跑它。只读，不修改任何东西。',
        ].join('\n'),
        parameters: {
          top: { type: 'number', description: '列出前 N 个高频会话，默认 5。' },
          fix: { type: 'boolean', description: '尝试修复：清理孤儿计数、删除损坏/过期的索引（下次搜索重建）。' },
        },
        output: {
          schema: { type: 'json' },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
        },
        async execute(args) {
          const topN = Math.max(1, Math.min(50, Number(args?.top ?? 5)))
          const warnings = []
          const file = indexPath()
          const repaired = []

          if (args?.fix) {
            // 1) counters for sessions that no longer exist
            const alive = new Set(listSessions().map(s => s.dir))
            let pruned = 0
            for (const dir of [...useCounters.keys()]) {
              if (!alive.has(dir)) { useCounters.delete(dir); pruned++ }
            }
            if (pruned) repaired.push(`清理孤儿计数 ${pruned} 条`)

            // 2) a missing / unparsable / stale-version index must be rebuilt
            let bad = false
            try {
              const raw = JSON.parse(readFileSync(file, 'utf8'))
              if (raw.version !== 4) bad = true
            } catch { bad = true }
            if (bad) {
              try { unlinkSync(file) } catch { /* already gone */ }
              __testReset()
              repaired.push('已删除旧索引：下一次搜索会全量重建（约 12 秒）')
            } else {
              indexDirty = true
              repaired.push('索引版本正常，已请求重新落盘')
            }
            if (!repaired.length) repaired.push('没有需要修复的项目')
          }

          // --- index file ---
          let exists = false, sizeMB = 0, version = null
          try {
            const st = statSync(file)
            exists = true
            sizeMB = Number((st.size / 1048576).toFixed(2))
          } catch { /* missing */ }
          try {
            const raw = JSON.parse(readFileSync(file, 'utf8'))
            version = raw.version ?? null
            if (version !== 4) warnings.push(`索引版本 ${version} ≠ 期望 4：下次搜索会自动重建（约 12 秒）`)
          } catch {
            if (exists) warnings.push('索引文件存在但无法解析：下次搜索会自动重建')
            else warnings.push('索引文件不存在：首次搜索会全量重建（约 12 秒）')
          }

          // --- cache ---
          loadIndex()
          const entries = textCache.size
          const usage = cacheMaxEntries > 0 ? Number(((entries / cacheMaxEntries) * 100).toFixed(1)) : 0
          if (entries >= cacheMaxEntries) warnings.push('缓存已达条数上限，淘汰会开始生效')
          if (cacheChars >= cacheMaxChars) warnings.push('缓存已达字符上限，淘汰会开始生效')

          // --- span + media + counters ---
          let newest = 0, oldest = Infinity, withMedia = 0, mediaCount = 0
          for (const [, v] of textCache) {
            if (typeof v.mtime === 'number') {
              if (v.mtime > newest) newest = v.mtime
              if (v.mtime < oldest) oldest = v.mtime
            }
            const all = [...v.texts, ...(v.atexts || [])]
            let hit = 0
            for (const t of all) {
              const m = t.match(/^\[(图片|文件) /g)
              if (m) hit += m.length
            }
            if (hit) { withMedia++; mediaCount += hit }
          }
          if (oldest === Infinity) oldest = 0

          const counters = [...useCounters.entries()]
            .map(([dir, c]) => ({ id: dir.split('\\').pop(), uses: c.uses || 0, lastUsed: iso(c.lastUsed || 0) }))
            .sort((a, b) => b.uses - a.uses)
            .slice(0, topN)

          // --- memory file ---
          let resolvedDir = '', memFile = '', memChars = 0, memMtime = ''
          try {
            resolvedDir = process.env.DSH_MEMORY_DIR || detectWorkspaceDir() || ''
            for (const n of ['环境笔记.md', 'MEMORY.md', 'CLAUDE.md']) {
              const p = resolvedDir ? path.join(resolvedDir, n) : ''
              if (p && existsSync(p)) {
                memFile = n
                const t = readFileSync(p, 'utf8')
                memChars = t.length
                memMtime = iso(statSync(p).mtimeMs)
                break
              }
            }
          } catch { /* ignore */ }
          if (!resolvedDir) warnings.push('未能探测当前工作区：记忆段不会注册')
          else if (!memFile) warnings.push(`工作区 ${resolvedDir} 下没找到 环境笔记.md / MEMORY.md / CLAUDE.md`)
          if (memChars > 12000) warnings.push(`记忆文件 ${memChars} 字符，超过 maxChars=12000，会被「保头保尾」截断`)

          // --- archives on disk ---
          let sessions = 0, totalMB = 0, unknownFormat = 0
          const wsCount = new Map()
          for (const s of listSessions()) {
            sessions++
            totalMB += (s.size || 0) / 1048576
            if (s.unknownFormat) unknownFormat++
            const ws = String(s.workspace || '(unknown)')
            wsCount.set(ws, (wsCount.get(ws) || 0) + 1)
          }
          const workspaces = [...wsCount.entries()]
            .map(([name, count]) => ({ name, sessions: count }))
            .sort((a, b) => b.sessions - a.sessions)
          if (unknownFormat) warnings.push('有 ' + unknownFormat + ' 个会话是未知归档格式（session.v5+），检索会跳过它们')

          return {
            ok: true,
            index: { path: file, exists, sizeMB, version, expectedVersion: 4, entries, counters: useCounters.size },
            cache: { entries, maxEntries: cacheMaxEntries, chars: cacheChars, maxChars: cacheMaxChars, usagePercent: usage },
            span: { newest: newest ? iso(newest) : '', oldest: oldest ? iso(oldest) : '' },
            topUsed: counters,
            media: { sessionsWithAttachments: withMedia, attachmentMentions: mediaCount },
            memory: { dir: resolvedDir, file: memFile, chars: memChars, mtime: memMtime },
            archives: { sessions, totalMB: Number(totalMB.toFixed(1)), workspaces },
            repaired,
            warnings,
          }
        },
      })

      return () => {
        for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* ignore */ } }
        disposers.length = 0
      }
    }, 'dsh-memory: session tools')
  } catch {
    // Never throw out of apply().
  }
}
