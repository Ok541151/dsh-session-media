/**
 * dsh-session-media 自检：逐项断言，PASS/FAIL 表格输出，退出码非 0 即失败。
 *
 * 用法：node selftest.mjs [--no-evict]
 *   --no-evict  跳过"反相关淘汰"一项（会临时改写索引，约 15 秒）
 *
 * 可以原样当作发布时的冒烟测试：不依赖测试框架。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, 'index.js')
const IDX = path.join(process.env.APPDATA || '', 'dsh-desktop', 'harness', 'dsh-session-media', 'session-index.json')
const SKIP_EVICT = process.argv.includes('--no-evict')

const results = []
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
  } catch (e) {
    results.push({ name, ok: false, detail: e.message })
  }
}

function mkCtx() {
  const sections = [], tools = []
  const ctx = {
    effect(fn) { fn() },
    systemPrompt: { section: (o) => { sections.push(o); return () => {} } },
    tools: { register: (d) => { tools.push(d); return () => {} } },
  }
  return { ctx, sections, tools }
}

const m = await import('./index.js')

// ---------------------------------------------------------------------------
await check('导出 name / inject / apply', () => {
  assert(m.name === 'dsh-session-media', `name=${m.name}`)
  assert(Array.isArray(m.inject), 'inject 不是数组')
  assert(m.inject.includes('systemPrompt') && m.inject.includes('tools'), `inject=${m.inject.join(',')}`)
  assert(typeof m.apply === 'function', 'apply 不是函数')
  return m.inject.join(' + ')
})

await check('无第三方依赖', () => {
  const src = readFileSync(SRC, 'utf8')
  const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(x => x[1])
    .concat([...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(x => x[1]))
  const bad = specs.filter(s => !s.startsWith('node:') && s !== '@deepseek-ai/dsh-tools')
  assert(bad.length === 0, `发现外部依赖: ${bad.join(', ')}`)
  return `${specs.length} 个 import，均为内置或可选宿主 SDK`
})

await check('apply 空配置不抛', () => {
  const { ctx } = mkCtx()
  m.apply(ctx, {})
  return 'ok'
})

await check('apply 坏 ctx 不抛', () => {
  m.apply({}, {})
  m.apply({ effect() {} }, null)
  return 'ok（apply 绝不能炸启动）'
})

await check('apply 幂等（重复调用不抛）', () => {
  const { ctx } = mkCtx()
  m.apply(ctx, {})
  m.apply(ctx, {})
  return 'ok'
})

// ---------------------------------------------------------------------------
const { ctx, sections, tools } = mkCtx()
m.apply(ctx, { saveIntervalMs: 0 })
const T = (n) => tools.find(t => t.name === n)

await check('注册 1 个记忆段', () => {
  assert(sections.length === 1, `注册了 ${sections.length} 个`)
  assert(sections[0].name === 'plugin:memory', `name=${sections[0].name}`)
  return `order=${sections[0].order}`
})

await check('注册 4 个工具', () => {
  const names = tools.map(t => t.name).sort().join(', ')
  const want = 'memory_doctor, session_media, session_read, session_search'
  assert(names === want, `实际=${names}`)
  return names
})

await check('记忆段有内容（工作区自动探测）', () => {
  const t = sections[0].text()
  assert(t.length > 200, `只有 ${t.length} 字符`)
  assert(t.includes('长期记忆'), '缺标题')
  return `${t.length} 字符`
})

// ---------------------------------------------------------------------------
await check('memory_doctor 无告警', async () => {
  const r = await T('memory_doctor').execute({ top: 3 })
  assert(r.ok, 'ok=false')
  assert(Array.isArray(r.warnings), 'warnings 不是数组')
  // The staleness nudge is by design, so only that one is acceptable here.
  const unexpected = r.warnings.filter((w) => !w.includes('记忆文件已'))
  assert(unexpected.length === 0, `非预期告警: ${unexpected.join(' | ')}`)
  return `v${r.index.version}, ${r.index.entries} 条, ${r.index.sizeMB} MB`
})

await check('索引存在且版本为 5（含 counters）', () => {
  assert(existsSync(IDX), '索引不存在')
  const j = JSON.parse(readFileSync(IDX, 'utf8'))
  assert(j.version === 5, `version=${j.version}`)
  assert(j.entries && typeof j.entries === 'object', '缺 entries')
  assert(j.counters && typeof j.counters === 'object', '缺 counters')
  return `${Object.keys(j.entries).length} 条 / ${Object.keys(j.counters).length} 计数器`
})

await check('session_search 跨会话命中', async () => {
  const r = await T('session_search').execute({ keyword: 'AGENT-TOOLS', limit: 2 })
  assert(r.ok, 'ok=false')
  assert(r.hits.length > 0, '零命中')
  return `${r.hits.length} 个会话, 扫了 ${r.scanned} 个`
})

await check('按工作区过滤生效', async () => {
  const all = await T('session_search').execute({ keyword: 'BUCK', limit: 3 })
  assert(all.hits.length > 0, '不限定工作区时零命中')
  const ws = String(all.hits[0].workspace || '')
  assert(ws.length > 0, '命中里没有 workspace 字段')
  const part = ws.includes('deepseek') ? 'deepseek' : ws.slice(-12)

  const hit = await T('session_search').execute({ keyword: 'BUCK', limit: 3, workspace: part })
  assert(hit.hits.length > 0, `限定 ${part} 后零命中`)
  assert(hit.hits.every(h => String(h.workspace || '').includes(part)), '返回了不属于该工作区的会话')

  const none = await T('session_search').execute({ keyword: 'BUCK', limit: 3, workspace: 'zzz-not-a-workspace' })
  assert(none.hits.length === 0, '不存在的过滤条件居然有命中')
  assert(none.scanned === 0, `过滤后仍扫了 ${none.scanned} 个（应提前跳过）`)
  return `${hit.hits.length} 命中 / 过滤掉全部时扫 0 个`
})

await check('memory_doctor 列出工作区', async () => {
  const r = await T('memory_doctor').execute({ top: 1 })
  assert(Array.isArray(r.archives.workspaces), '缺 workspaces')
  assert(r.archives.workspaces.length > 0, '工作区清单为空')
  return r.archives.workspaces.map(w => `${w.sessions}个`).join(' + ')
})

await check('能命中 assistant 的话', async () => {
  const r = await T('session_search').execute({ keyword: 'evictOverflow', limit: 2 })
  const roles = r.hits.flatMap(h => h.snippets.map(s => s.role))
  assert(roles.includes('assistant'), `角色=${[...new Set(roles)].join(',')}`)
  return 'assistant 角色命中'
})

await check('附件标签已进索引且可搜', async () => {
  const r = await T('session_search').execute({ keyword: '[图片', limit: 2 })
  assert(r.hits.length > 0, '搜 [图片 零命中')
  const sn = r.hits[0].snippets.find(s => s.text.startsWith('[图片'))
  assert(sn, '片段里没有附件标签')
  return sn.text.slice(0, 42)
})

await check('session_media 路径可访问', async () => {
  const r = await T('session_media').execute({ sessionId: '69fd8e77', limit: 3 })
  assert(r.ok, 'ok=false')
  assert(r.count > 0, '零附件')
  assert(r.items.every(i => i.exists), '有附件路径不存在')
  return `${r.count} 个（去重后）, 首条 ${(r.items[0].bytes / 1024).toFixed(0)}KB`
})

await check('session_read 能读出消息', async () => {
  const r = await T('session_read').execute({ sessionId: 'be717fe6', maxChars: 500 })
  assert(r.ok, 'ok=false')
  assert(r.messages.length > 0, '零消息')
  return `${r.messages.length} 条, 标题「${r.title}」`
})

await check('命中累加 uses 并落盘', async () => {
  const sum = (o) => Object.values(o.counters || {}).reduce((a, c) => a + (c.uses || 0), 0)
  const b = sum(JSON.parse(readFileSync(IDX, 'utf8')))
  await T('session_search').execute({ keyword: '反相关', limit: 2 })
  const a = sum(JSON.parse(readFileSync(IDX, 'utf8')))
  assert(a > b, `uses 未增加: ${b} → ${a}`)
  return `${b} → ${a}`
})

// ---------------------------------------------------------------------------
// --- capabilities added in 0.3.3: each one gets a guard, because all six shipped
// --- without a regression test and five of them were only checked by hand.

await check('匹配计数 matches 存在', async () => {
  const r = await T('session_search').execute({ keyword: 'BUCK', limit: 1 })
  assert(r.hits.length > 0, '零命中')
  assert(typeof r.hits[0].matches === 'number' && r.hits[0].matches > 0, `matches=${r.hits[0].matches}`)
  return `matches=${r.hits[0].matches}`
})

await check('片段以命中处为中心', async () => {
  let total = 0, withKw = 0
  for (const kw of ['BUCK', '纹波', '会话']) {
    const r = await T('session_search').execute({ keyword: kw, limit: 3 })
    for (const h of r.hits) {
      for (const sn of h.snippets) {
        total++
        if (sn.text.toLowerCase().includes(kw.toLowerCase())) withKw++
      }
    }
  }
  assert(total > 0, '没有任何片段')
  assert(withKw === total, `${total - withKw}/${total} 个片段不含关键词`)
  return `${withKw}/${total} 片段含关键词`
})

await check('工具调用已被索引', async () => {
  const j = JSON.parse(readFileSync(IDX, 'utf8'))
  const sample = Object.values(j.entries)
    .flatMap((e) => e.atexts || [])
    .find((t) => t.startsWith('[工具 '))
  assert(sample, '索引里没有任何工具标签')
  const toolName = sample.slice(4).split(' ')[0]
  const r = await T('session_search').execute({ keyword: toolName, limit: 2 })
  assert(r.hits.length > 0, `按工具名 ${toolName} 搜不到`)
  return `工具名 ${toolName} 可搜到`
})

await check('索引里没有泄露凭据', () => {
  const raw = readFileSync(IDX, 'utf8')
  const patterns = {
    'sk-': /sk-[A-Za-z0-9]{16,}/,
    ghp_: /ghp_[A-Za-z0-9]{20,}/,
    'npm_': /npm_[A-Za-z0-9]{20,}/,
    AKIA: /AKIA[0-9A-Z]{16}/,
  }
  for (const [name, re] of Object.entries(patterns)) {
    const m = raw.match(re)
    assert(!m, `${name} 泄露: ${m && m[0].slice(0, 16)}...`)
  }
  return '4 类前缀均未命中'
})

await check('session_read 支持分页', async () => {
  const p1 = await T('session_read').execute({ sessionId: '69fd8e77', limit: 3 })
  assert(typeof p1.total === 'number' && p1.total > 3, `total=${p1.total}`)
  assert(p1.count <= 3, `count=${p1.count}`)
  assert(p1.hasMore === true, 'hasMore 应为 true')
  assert(p1.nextOffset === 3, `nextOffset=${p1.nextOffset}`)
  const p2 = await T('session_read').execute({ sessionId: '69fd8e77', offset: p1.nextOffset, limit: 3 })
  assert(p2.offset === 3, `第二页 offset=${p2.offset}`)
  assert(JSON.stringify(p1.messages) !== JSON.stringify(p2.messages), '第二页与第一页内容相同')
  return `total=${p1.total}，两页内容不同`
})

await check('重复搜索结果一致（haystack 缓存安全）', async () => {
  const a = await T('session_search').execute({ keyword: 'BUCK', limit: 3 })
  const b = await T('session_search').execute({ keyword: 'BUCK', limit: 3 })
  const ka = a.hits.map((h) => h.id + ':' + h.matches).join(',')
  const kb = b.hits.map((h) => h.id + ':' + h.matches).join(',')
  assert(ka === kb, '两次搜索命中不一致')
  return `${a.hits.length} 个会话，结果稳定`
})

if (!SKIP_EVICT) {
  await check('反相关数据下拒绝淘汰', async () => {
    const backup = IDX + '.selftest-bak'
    copyFileSync(IDX, backup)
    try {
      const j = JSON.parse(readFileSync(IDX, 'utf8'))
      const keys = Object.keys(j.entries).slice(0, 10)
      const now = Date.now(), DAY = 86400000
      const out = {}
      keys.forEach((k, i) => {
        const e = { ...j.entries[k] }
        if (i < 5) { e.mtime = now - 200 * DAY; e.uses = 50 } else { e.mtime = now - 1 * DAY; e.uses = 0 }
        e.lastUsed = e.mtime
        out[k] = e
      })
      writeFileSync(IDX, JSON.stringify({ version: 5, entries: out, counters: {} }))

      // Module state is process-wide, so the crafted index is only seen after a reset.
      m.__testReset()
      const { ctx: c2, tools: t2 } = mkCtx()
      m.apply(c2, { cacheMaxEntries: 5, cacheMaxChars: 1e9, saveIntervalMs: 0 })
      await t2.find(t => t.name === 'session_search').execute({ keyword: '的', limit: 1 })

      const after = JSON.parse(readFileSync(IDX, 'utf8'))
      const rows = Object.values(after.entries)
      const hot = rows.filter(e => (e.uses || 0) === 50).length
      // A search必然把首个扫描到的会话读进缓存，条数可能略多于 10。
      // 真正要断言的是：没有被裁到上限 5，且 5 条高频一条不少。
      assert(rows.length >= 10, `被裁到 ${rows.length} 条（不应低于 10）`)
      assert(hot === 5, `高频条目只剩 ${hot}/5`)
      return `${rows.length} 条保留，高频 5/5 全在`
    } finally {
      // 同步恢复：放在 finally 里而不是定时器里，否则 process.exit 会跳过它
      copyFileSync(backup, IDX)
      unlinkSync(backup)
      m.__testReset()
    }
  })
}
const width = (s) => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))

console.log('\n========== dsh-session-media 自检 ==========')
console.log('='.repeat(72))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.name, 32)} ${r.detail}`)
}
const fail = results.filter(r => !r.ok).length
console.log('='.repeat(72))
console.log(`结果: ${results.length - fail} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
