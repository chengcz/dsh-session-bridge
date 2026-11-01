// scripts/host-sim.mjs — 用假宿主跑通「工具面 + core + 持久化适配」的集成测试
//
// 不连真实 Harness：sessionPersistence / sessions 用内存实现，DSH_HOME 指向临时目录。
// 覆盖：判重（指纹）→ force 副本 → 导出落点 → 工具返回值必须是无损 JSON → 审计跳过空会话。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsb-sim-'))
process.env.DSH_HOME = home

const { SessionBridgeCore } = await import('../lib/core.js')
const { registerTools } = await import('../lib/tools.js')

const demoJsonl = await readFile(new URL('../test/fixtures/demo.jsonl', import.meta.url), 'utf8')
const interchangePath = new URL('../test/fixtures/interchange-demo.json', import.meta.url).pathname
const interchangeText = await readFile(interchangePath, 'utf8')

function makeHost() {
  const store = new Map()
  if (demoJsonl) {
    const lines = demoJsonl.trim().split('\n').map((line) => JSON.parse(line))
    store.set(lines[0].id, { header: lines[0], events: lines.slice(1) })
  }
  const persistence = {
    async list() {
      return [...store.values()].map((entry) => ({ header: entry.header, sizeBytes: JSON.stringify(entry.events).length }))
    },
    async open(id) {
      const entry = store.get(id)
      if (!entry) throw new Error('ENOENT')
      let closed = false
      return {
        header: entry.header,
        async read() { return { events: entry.events } },
        async close() { closed = true },
      }
    },
    async create(header) {
      const entry = { header, events: [] }
      store.set(header.id, entry)
      return {
        async append(events) { entry.events = [...entry.events, ...events] },
        async flush() {},
        async close() {},
      }
    },
    async append(id, events) {
      const entry = store.get(id)
      entry.events = [...entry.events, ...events]
    },
  }
  const services = {
    sessionPersistence: persistence,
    sessions: { get: () => undefined, flush: async () => false },
  }
  const ctx = {
    get(name) { return services[name] },
    tools: { register(definition) { ctx.tools.defs.set(definition.name, definition) }, defs: new Map() },
  }
  return ctx
}

const ctx = makeHost()
const core = new SessionBridgeCore(ctx)
registerTools(ctx, core)
assert.deepEqual([...ctx.tools.defs.keys()].sort(), ['session_history_audit', 'session_history_export', 'session_history_import'])

const importer = ctx.tools.defs.get('session_history_import')
const exporter = ctx.tools.defs.get('session_history_export')
const auditor = ctx.tools.defs.get('session_history_audit')

// 1) 同一段对话（demo.jsonl 里的会话）→ 判重命中源会话
const first = await importer.execute({ path: interchangePath }, {})
assert.equal(first.status, 'duplicate', JSON.stringify(first))
assert.equal(first.duplicateOf, 'bridge-interchange-demo')
assert.equal(first.duplicateReason, 'source-session')

// 2) force → 真的导入一份副本；返回值必须是无损 JSON（无 undefined 键）
const forced = await importer.execute({ path: interchangePath, force: true }, {})
assert.equal(forced.status, 'imported')
assert.ok(forced.sessionId.startsWith('bridge-'))
assert.deepEqual(JSON.parse(JSON.stringify(forced)), forced, 'tool value must round-trip through JSON')

// 3) 再导一次 → 命中新副本（索引层）
const again = await importer.execute({ path: interchangePath }, {})
assert.equal(again.status, 'duplicate')
assert.equal(again.duplicateOf, forced.sessionId)

// 4) 导出刚导入的会话：落点必须是文件而不是目录，且能被解析回来
const exportDir = join(home, 'exports')
const exported = await exporter.execute({ sessionId: forced.sessionId, path: exportDir }, {})
assert.equal(exported.status, 'exported')
assert.ok(exported.path.endsWith('.dshbundle.json'), exported.path)
const bundle = JSON.parse(await readFile(exported.path, 'utf8'))
assert.equal(bundle.fingerprint, exported.fingerprint)
assert.ok(bundle.log.length > 0)

// 5) 审计：force 副本与源会话被分到同一组（同一段对话），空会话不参与分组
const audit = await auditor.execute({ limit: 50 }, {})
assert.equal(audit.ok, true)
assert.equal(audit.duplicateGroups, 1, JSON.stringify(audit.duplicates))
assert.equal(audit.redundantSessions, 1)
assert.equal(audit.duplicates[0].sessions.length, 2)

// 6) 另一实例（重载前后 / 第二个窗口）必须立刻看见刚写入的账本
const otherCore = new SessionBridgeCore(ctx)
const seenByOther = await otherCore.store.findImport(forced.fingerprint)
assert.ok(seenByOther, 'second instance must see the index entry written by the first')
assert.equal(seenByOther.sessionId, forced.sessionId)

// 7) 索引落在临时 DSH_HOME 下，且只记录指纹与计数
const index = JSON.parse(await readFile(join(home, 'dsh-session-bridge', 'index.json'), 'utf8'))
assert.equal(Object.keys(index.imports).length, 1)
assert.ok(index.imports[forced.fingerprint])
assert.ok(!JSON.stringify(index.imports).includes('帮我看一下'), 'index must not store conversation text')

console.log('host-sim ok:', {
  duplicate: first.duplicateReason,
  forcedId: forced.sessionId,
  exported: exported.path.split('/').pop(),
  imports: Object.keys(index.imports).length,
})
