/**
 * CI 冒烟测试：不依赖任何真实会话存档，能在干净机器上跑通。
 *
 * 本地完整测试用 selftest.mjs（需要真实会话）；CI 只需要证明：
 * 模块能加载、注册正确、apply 永不抛异常——那正是会让 App 起不来的失败模式。
 *
 *   node cismoke.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fails = []
const ok = (name, detail = '') => console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`)
const bad = (name, err) => { fails.push(name); console.log(`FAIL  ${name}  ${err && err.message ? err.message : err}`) }
const run = (name, fn) => { try { ok(name, fn()) } catch (e) { bad(name, e) } }
const assert = (c, m) => { if (!c) throw new Error(m) }

// A fixture workspace so the prompt section resolves without any real project.
const dir = mkdtempSync(path.join(tmpdir(), 'dsh-memory-ci-'))
writeFileSync(path.join(dir, '环境笔记.md'), '# CI fixture\n\nhello from CI\n')
process.env.DSH_MEMORY_DIR = dir

try {
  const m = await import('./index.js')

  run('导出 name / inject / apply', () => {
    assert(m.name === 'dsh-session-media', `name=${m.name}`)
    assert(Array.isArray(m.inject), 'inject 不是数组')
    assert(m.inject.includes('systemPrompt') && m.inject.includes('tools'), `inject=${m.inject}`)
    assert(typeof m.apply === 'function', 'apply 不是函数')
    return m.inject.join(' + ')
  })

  run('无第三方依赖', () => {
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(x => x[1])
    const bad2 = specs.filter(s => !s.startsWith('node:') && s !== '@deepseek-ai/dsh-tools')
    assert(bad2.length === 0, `外部依赖: ${bad2.join(', ')}`)
    return `${specs.length} 个 import`
  })

  const mk = () => {
    const sections = [], tools = []
    return {
      sections, tools,
      ctx: {
        effect(fn) { fn() },
        systemPrompt: { section: (o) => { sections.push(o); return () => {} } },
        tools: { register: (d) => { tools.push(d); return () => {} } },
      },
    }
  }

  run('apply 空配置不抛', () => { m.apply(mk().ctx, {}); })
  run('apply 坏 ctx 不抛', () => { m.apply({}, {}); m.apply({ effect() {} }, null) })
  run('apply 幂等', () => { const c = mk().ctx; m.apply(c, {}); m.apply(c, {}) })

  const { ctx, sections, tools } = mk()
  m.apply(ctx, {})

  run('注册 1 个记忆段 + 4 个工具', () => {
    assert(sections.length === 1, `sections=${sections.length}`)
    assert(sections[0].name === 'plugin:memory', `section=${sections[0].name}`)
    const names = tools.map(t => t.name).sort().join(',')
    assert(names === 'memory_doctor,session_media,session_read,session_search', `tools=${names}`)
    return names
  })

  run('记忆段能读到 fixture', () => {
    const t = sections[0].text()
    assert(t.includes('hello from CI'), '没读到 fixture 内容')
    return `${t.length} 字符`
  })

  run('工具定义结构完整', () => {
    for (const t of tools) {
      assert(typeof t.name === 'string' && t.name, '缺 name')
      assert(typeof t.description === 'string' && t.description, `${t.name} 缺 description`)
      assert(t.parameters && typeof t.parameters === 'object', `${t.name} 缺 parameters`)
      assert(typeof t.execute === 'function', `${t.name} 缺 execute`)
    }
    return `${tools.length} 个工具`
  })
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\nCI 冒烟: ${fails.length ? 'FAILED (' + fails.length + ')' : 'OK'}`)
process.exit(fails.length ? 1 : 0)
