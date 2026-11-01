// scripts/manage-sim.mjs — 管理界面的后端集成测试（假宿主 + 临时 DSH_HOME）
//
// 覆盖界面新增的每条能力：会话预览、导入前预览（含判重结论）、导出文件清单、
// 批量导出、移入回收站/恢复、暂存件清理、其他 Agent 来源的解析与导入。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsb-manage-'))
process.env.DSH_HOME = home

const { SessionBridgeCore } = await import('../lib/core.js')

const demoJsonl = await readFile(new URL('../test/fixtures/demo.jsonl', import.meta.url), 'utf8')
const interchangePath = new URL('../test/fixtures/interchange-demo.json', import.meta.url).pathname
const claudeFixture = new URL('../test/fixtures/claude-sample.jsonl', import.meta.url).pathname

const DEMO_ID = 'bridge-interchange-demo'

// 真实宿主的会话列表来自磁盘：回收站移走文件后，会话就不该再出现在列表里。
// 假宿主照做，否则「去重后还有重复」这类结论会被内存假象掩盖。
const sessionsRoot = join(home, 'sessions', '--tmp-demo--')
const onDisk = (id) => existsSync(join(sessionsRoot, id))

function makeHost() {
  const store = new Map()
  const lines = demoJsonl.trim().split('\n').map((line) => JSON.parse(line))
  store.set(lines[0].id, { header: lines[0], events: lines.slice(1) })
  const persistence = {
    async list() {
      return [...store.values()]
        .filter((entry) => onDisk(entry.header.id))
        .map((entry) => ({ header: entry.header, sizeBytes: JSON.stringify(entry.events).length }))
    },
    async open(id) {
      const entry = store.get(id)
      if (!entry) throw new Error('ENOENT')
      return { header: entry.header, async read() { return { events: entry.events } }, async close() {} }
    },
    async create(header) {
      const entry = { header, events: [] }
      store.set(header.id, entry)
      // 真实宿主会在 create 时落盘；假宿主照做，否则「会话在磁盘上」的判定全错
      await mkdir(join(sessionsRoot, header.id), { recursive: true })
      await writeFile(join(sessionsRoot, header.id, 'session.v4.jsonl.zstd'), 'fake-' + header.id)
      return {
        async append(events) { entry.events = [...entry.events, ...events] },
        async flush() {},
        async close() {},
      }
    },
  }
  const services = {
    sessionPersistence: persistence,
    sessions: { get: () => undefined, flush: async () => false },
  }
  return { get(name) { return services[name] } }
}

await mkdir(join(sessionsRoot, DEMO_ID), { recursive: true })
await writeFile(join(sessionsRoot, DEMO_ID, 'session.v4.jsonl.zstd'), 'fake-demo')

const ctx = makeHost()
const core = new SessionBridgeCore(ctx)

// ── 1. 会话预览：不导出文件就能看到消息与工具调用 ──────────────────────────
const preview = await core.previewSession({ sessionId: DEMO_ID })
assert.equal(preview.ok, true)
assert.equal(preview.session.id, DEMO_ID)
assert.ok(preview.session.messages > 0, JSON.stringify(preview.session))
assert.equal(preview.messages.length, preview.total)
assert.ok(preview.messages.some((message) => message.role === 'user' && message.text.includes('README')))

// ── 2. 导入前预览：必须给出「会导入多少条 / 是否重复」 ────────────────────
const importPreview = await core.previewImport({ path: interchangePath })
assert.equal(importPreview.preview, true)
assert.ok(importPreview.messages > 0)
assert.ok(importPreview.duplicate, 'preview must report the duplicate verdict')
assert.equal(importPreview.duplicate.reason, 'source-session')

// ── 3. 导出 + 导出文件清单 ────────────────────────────────────────────────
const exportDir = join(home, 'exports')
const exported = await core.exportSession({ sessionId: DEMO_ID, path: exportDir })
assert.equal(exported.status, 'exported')
const files = await core.listExportFiles({ dir: exportDir })
assert.ok(files.files.some((file) => file.name === exported.path.split('/').pop()))
const bundleEntry = files.files.find((file) => file.name === exported.path.split('/').pop())
assert.equal(bundleEntry.format, 'bundle')
assert.equal(bundleEntry.importable, true)
assert.equal(bundleEntry.sessionId, DEMO_ID)

// ── 4. 批量导出（界面「导出选中」） ───────────────────────────────────────
const batch = await core.exportAll({ sessionIds: [DEMO_ID], format: 'markdown' })
assert.equal(batch.exported, 1, JSON.stringify(batch.errors))
assert.ok(batch.results[0].path.endsWith('.md'))

// ── 5. 回收站：移入 → 列表可见 → 恢复回原位 ───────────────────────────────
const sessionDir = join(sessionsRoot, DEMO_ID)
const sessionFile = join(sessionDir, 'session.v4.jsonl.zstd')
await writeFile(sessionFile, 'fake-zstd-bytes')

const trashed = await core.trash({ sessionIds: [DEMO_ID] })
assert.equal(trashed.trashed, 1, JSON.stringify(trashed.skipped))
assert.equal(existsSync(sessionFile), false, 'session file must be moved away')

const trashList = await core.listTrash()
assert.equal(trashList.batches.length, 1)
assert.equal(trashList.batches[0].sessions[0].sessionId, DEMO_ID)

const restored = await core.restoreTrash({ batch: trashList.batches[0].id })
assert.deepEqual(restored.restored, [DEMO_ID])
assert.equal(existsSync(sessionFile), true, 'restore must put the file back')
assert.equal((await core.listTrash()).batches.length, 0)

// 恢复后再删一次，验证清空回收站
const trashedAgain = await core.trash({ sessionIds: [DEMO_ID] })
assert.equal(trashedAgain.trashed, 1)
const emptied = await core.emptyTrash({})
assert.equal(emptied.removed, 1)
assert.equal((await core.listTrash()).batches.length, 0)

// ── 6. 暂存上传件清理 ─────────────────────────────────────────────────────
const uploadsDir = join(home, 'dsh-session-bridge', 'uploads')
await mkdir(uploadsDir, { recursive: true })
await writeFile(join(uploadsDir, 'staged-.dshbundle.json'), '{}')
const cleaned = await core.cleanUploads({})
assert.equal(cleaned.removed, 1)
assert.equal(existsSync(join(uploadsDir, 'staged-.dshbundle.json')), false)

// ── 7. 其他 Agent：解析 Claude Code 会话并导入 ────────────────────────────
const agentPreview = await core.importAgentSession({ kind: 'claude-code', path: claudeFixture, preview: true })
assert.equal(agentPreview.preview, true)
assert.equal(agentPreview.turns, 2, JSON.stringify(agentPreview))

const agentImport = await core.importAgentSession({ kind: 'claude-code', path: claudeFixture })
assert.equal(agentImport.status, 'imported', JSON.stringify(agentImport))
assert.ok(agentImport.sessionId.startsWith('bridge-'))
assert.ok(agentImport.messages >= 4, 'user+assistant turns must survive: ' + agentImport.messages)
assert.ok(agentImport.toolCalls >= 1, 'tool call must survive: ' + agentImport.toolCalls)

// 同一份日志再导一次 → 指纹拦下（他源导入同样受保护）
const agentAgain = await core.importAgentSession({ kind: 'claude-code', path: claudeFixture })
assert.equal(agentAgain.status, 'duplicate')
assert.equal(agentAgain.duplicateOf, agentImport.sessionId)

// 导入结果能被预览：工具调用与结果都在
const importedPreview = await core.previewSession({ sessionId: agentImport.sessionId })
assert.ok(importedPreview.messages.some((message) => Array.isArray(message.tools) && message.tools.includes('Read')))

// ── 8. 批量导入：多个文件一次导入，逐条返回结果 ──────────────────────────
const alphaPath = new URL('../test/fixtures/interchange-alpha.json', import.meta.url).pathname
const betaPath = new URL('../test/fixtures/interchange-beta.json', import.meta.url).pathname

const batchImport = await core.importFiles({ paths: [alphaPath, betaPath] })
assert.equal(batchImport.total, 2)
assert.equal(batchImport.imported, 2, JSON.stringify(batchImport.results))
assert.equal(batchImport.duplicate, 0)
assert.equal(batchImport.failed, 0)
assert.ok(batchImport.results.every((result) => result.status === 'imported' && result.sessionId))
assert.ok(batchImport.results.every((result) => typeof result.path === 'string'))

// 再批量导一次 → 逐条判重，一个都不新建
const batchAgain = await core.importFiles({ paths: [alphaPath, betaPath] })
assert.equal(batchAgain.imported, 0)
assert.equal(batchAgain.duplicate, 2)

// 批量导入容忍坏文件：单条失败不影响其余
const brokenPath = join(tmpdir(), 'broken-' + process.pid + '.json')
await writeFile(brokenPath, '{ not a session }')
const withBroken = await core.importFiles({ paths: [alphaPath, brokenPath] })
assert.equal(withBroken.failed, 1)
assert.equal(withBroken.duplicate, 1)
assert.ok(withBroken.results.find((result) => result.status === 'failed').error.includes('无法识别'))

// ── 9. 批量从其他 Agent 导入 ─────────────────────────────────────────────
const claudeText = await readFile(claudeFixture, 'utf8')
const secondFixture = join(tmpdir(), 'claude-sample-2-' + process.pid + '.jsonl')
await writeFile(secondFixture, claudeText
  .replaceAll('claude-sample-1', 'claude-sample-2')
  .replaceAll('帮我看看 README 的第一行', '帮我把 LICENSE 也读一下')
  .replaceAll('/tmp/demo-project', '/tmp/demo-project-2'))

const batchAgent = await core.importAgentSessions({
  items: [
    { kind: 'claude-code', path: claudeFixture },
    { kind: 'claude-code', path: secondFixture },
  ],
})
assert.equal(batchAgent.total, 2)
assert.equal(batchAgent.duplicate, 1, JSON.stringify(batchAgent.results.map((r) => r.status)))
assert.equal(batchAgent.imported, 1)

// ── 10. 批量去重：先 dryRun 摊开计划，再一键处理 ─────────────────────────
// 造一组重复：把 alpha 再 force 导入一份副本
const copy = await core.importFiles({ paths: [alphaPath], force: true })
assert.equal(copy.imported, 1)

// 去重会移动磁盘上的会话文件，这里给当前所有会话都建出文件
const allSessions = await core.listSessions()
for (const session of allSessions) {
  const dir = join(sessionsRoot, session.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'fake-' + session.id)
}

const planPreview = await core.resolveDuplicates({ strategy: 'keep-original', dryRun: true })
assert.equal(planPreview.dryRun, true)
assert.ok(planPreview.groups >= 1, 'there must be at least one duplicate group: ' + JSON.stringify(planPreview))
assert.ok(planPreview.wouldTrash >= 1)
assert.ok(planPreview.plan.every((entry) => entry.keep && entry.drop.length > 0))
assert.equal((await core.listTrash()).batches.length, 0, 'dryRun must not touch anything')

const resolved = await core.resolveDuplicates({ strategy: 'keep-original' })
assert.equal(resolved.status, 'resolved')
assert.ok(resolved.trashed >= 1, JSON.stringify(resolved.skipped))
const afterResolve = await core.audit({ limit: 120 })
assert.equal(afterResolve.duplicateGroups, 0, 'no duplicate group should survive: ' + JSON.stringify(afterResolve.duplicates))

// ── 11. 工具面也支持批量：paths 一次导入多个文件 ────────────────────────
const { registerTools } = await import('../lib/tools.js')
const toolCtx = {
  get: (name) => ctx.get(name),
  tools: {
    defs: new Map(),
    register(definition) { toolCtx.tools.defs.set(definition.name, definition) },
  },
}
registerTools(toolCtx, core)
const importTool = toolCtx.tools.defs.get('session_history_import')
const toolBatch = await importTool.execute({ paths: [alphaPath, betaPath] }, {})
assert.equal(toolBatch.status, 'batch')
assert.equal(toolBatch.total, 2)
assert.equal(toolBatch.duplicate, 2, JSON.stringify(toolBatch.results.map((item) => item.status)))
assert.deepEqual(JSON.parse(JSON.stringify(toolBatch)), toolBatch, 'tool value must round-trip through JSON')

// ── 12. SQLite 来源（zcode 一族）：解析 → 导入 → 判重 ────────────────────
// 造一个最小 zcode 库（session/message/part 三表），验证读取器与导入链路；
// 真实库结构见本机 ~/.zcode/cli/db/db.sqlite（同一套 schema）。
const { DatabaseSync } = await import('node:sqlite')
const zcodeDb = join(tmpdir(), 'zcode-fixture-' + process.pid + '.db')
{
  const db = new DatabaseSync(zcodeDb)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)')
  const now = Date.now()
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('sess_fixture', 'zcode 测试会话', '/tmp/zcode-demo', null, now, now)
  const put = (id, data, seq) => db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, 'sess_fixture', now, JSON.stringify(data), seq)
  const part = (id, messageId, data, seq) => db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(id, messageId, 'sess_fixture', now, JSON.stringify(data), seq)
  put('m1', { role: 'user' }, 1)
  part('p1', 'm1', { type: 'text', text: '帮我看一下 zcode 的数据库' }, 1)
  put('m2', { role: 'assistant', modelID: 'GLM-5', providerID: 'zai' }, 2)
  part('p2', 'm2', { type: 'reasoning', text: '先读库结构' }, 2)
  part('p3', 'm2', { type: 'text', text: '库里有 session/message/part 三张表。' }, 3)
  part('p4', 'm2', { type: 'tool', callID: 'call_1', tool: 'Read', state: { status: 'completed', input: { file: 'db.sqlite' }, output: 'ok' } }, 4)
  db.close()
}

const zcodeRef = zcodeDb + '#sess_fixture'
const zcodePreview = await core.importAgentSession({ kind: 'zcode', path: zcodeRef, preview: true })
assert.equal(zcodePreview.preview, true)
assert.equal(zcodePreview.turns, 1, JSON.stringify(zcodePreview))

const zcodeImport = await core.importAgentSession({ kind: 'zcode', path: zcodeRef })
assert.equal(zcodeImport.status, 'imported', JSON.stringify(zcodeImport))
assert.ok(zcodeImport.messages >= 2, 'messages: ' + zcodeImport.messages)
assert.ok(zcodeImport.toolCalls >= 1, 'toolCalls: ' + zcodeImport.toolCalls)

const zcodeAgain = await core.importAgentSession({ kind: 'zcode', path: zcodeRef })
assert.equal(zcodeAgain.status, 'duplicate')
assert.equal(zcodeAgain.duplicateOf, zcodeImport.sessionId)

// 导入要落到源项目：会话 header 的 cwd 必须来自 zcode 库里的 directory
const zcodeSessions = await core.listSessions()
const zcodeEntry = zcodeSessions.find((session) => session.id === zcodeImport.sessionId)
assert.equal(zcodeEntry.cwd, '/tmp/zcode-demo', JSON.stringify(zcodeEntry))

// 批量入口也吃 zcode 这种「库#会话」路径
const zcodeBatch = await core.importAgentSessions({ items: [{ kind: 'zcode', path: zcodeRef }] })
assert.equal(zcodeBatch.duplicate, 1, JSON.stringify(zcodeBatch.results.map((item) => item.status)))

// 导入结果里工具的输入与结果都在，且结果不能是空的
const zcodeSessionPreview = await core.previewSession({ sessionId: zcodeImport.sessionId })
assert.ok(zcodeSessionPreview.messages.some((message) => Array.isArray(message.tools) && message.tools.includes('Read')))
const toolMessage = zcodeSessionPreview.messages.find((message) => message.role === 'tool')
assert.ok(toolMessage, 'a tool message must exist')
assert.ok((toolMessage.text || '').length > 0, 'tool result must carry content, got: ' + JSON.stringify(toolMessage))

// ── 13. 会话换 project：目录搬迁 + header.cwd + 投影缓存 ─────────────────
const { slugForCwd } = await import('../lib/session-move.js')
const { zstdCompressSync, zstdDecompressSync } = await import('node:zlib')

const moveId = 'bridge-move-target'
const oldCwd = '/tmp/old-project'
const newCwd = '/tmp/new-project'
const oldDir = join(home, 'sessions', slugForCwd(oldCwd), moveId)
await mkdir(oldDir, { recursive: true })
const moveHeader = { type: 'session', version: 4, id: moveId, createdAt: Date.now(), cwd: oldCwd, isSeeded: false, delegationDepth: 0 }
const moveEvents = [
  { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '移动我' }], source: { kind: 'user' } } },
]
// 真实会话是多帧 zstd 拼接（每批事件一帧）：这里刻意写成两帧，验证移动不会只留第一帧
const moveFrames = Buffer.concat([
  zstdCompressSync(Buffer.from(JSON.stringify(moveHeader) + '\n', 'utf8')),
  zstdCompressSync(Buffer.from(moveEvents.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')),
])
await writeFile(join(oldDir, 'session.v4.jsonl.zstd'), moveFrames)

const projDir = join(home, 'storages', 'session_projcache', 'sessions')
await mkdir(projDir, { recursive: true })
await writeFile(join(projDir, moveId + '.json'), JSON.stringify({
  version: 1,
  record: { rows: { workingDirectory: { ver: 1, seq: 3, val: oldCwd }, title: { ver: 1, seq: 1, val: '移动测试' } } },
}))

const moved = await core.moveSession({ sessionId: moveId, cwd: newCwd })
assert.equal(moved.status, 'moved', JSON.stringify(moved))
assert.equal(moved.from, oldCwd)
const newDir = join(home, 'sessions', slugForCwd(newCwd), moveId)
assert.equal(existsSync(oldDir), false, 'old group directory must be gone')
assert.equal(existsSync(newDir), true, 'session must land in the new group directory')

function readAllFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let index = 0
  while ((index = buffer.indexOf(magic, index)) !== -1) { offsets.push(index); index += 4 }
  if (offsets.length <= 1) return zstdDecompressSync(buffer).toString('utf8')
  let text = ''
  for (let k = 0; k < offsets.length; k += 1) {
    const to = k + 1 < offsets.length ? offsets[k + 1] : buffer.length
    text += zstdDecompressSync(buffer.subarray(offsets[k], to)).toString('utf8')
  }
  return text
}

const movedText = readAllFrames(await readFile(join(newDir, 'session.v4.jsonl.zstd')))
const movedHeader = JSON.parse(movedText.split('\n')[0])
assert.equal(movedHeader.cwd, newCwd, 'header.cwd must be rewritten')
assert.equal(movedText.split('\n').filter(Boolean).length, 3, 'events must survive untouched')

const projection = JSON.parse(await readFile(join(projDir, moveId + '.json'), 'utf8'))
assert.equal(projection.record.rows.workingDirectory.val, newCwd, 'projection cache must follow')
assert.equal(projection.record.rows.workingDirectory.seq, 4)

const projects = await core.listProjects()
assert.ok(projects.projects.some((project) => project.cwd === newCwd), JSON.stringify(projects.projects))

// 移动失败要回滚：目标位置已有同名会话
const conflictCwd = '/tmp/conflict-project'
const conflictDir = join(home, 'sessions', slugForCwd(conflictCwd), moveId)
await mkdir(conflictDir, { recursive: true })
let rollbackError = null
try {
  await core.moveSession({ sessionId: moveId, cwd: conflictCwd })
} catch (error) {
  rollbackError = String(error.message || error)
}
assert.ok(rollbackError && rollbackError.includes('已经有同名会话'), String(rollbackError))
assert.equal(existsSync(join(home, 'sessions', slugForCwd(newCwd), moveId)), true, 'session must stay put after a refused move')

console.log('manage-sim ok:', {
  previewMessages: preview.session.messages,
  exportFiles: files.total,
  trashRestored: true,
  agentTurns: agentImport.turns,
  agentMessages: agentImport.messages,
  agentToolCalls: agentImport.toolCalls,
  dedupe: agentAgain.status,
  batchImport: batchImport.imported + '/' + batchImport.duplicate,
  batchAgent: batchAgent.imported + '/' + batchAgent.duplicate,
  dedupeGroups: planPreview.groups,
  dedupeTrashed: resolved.trashed,
  toolBatch: toolBatch.status + ':' + toolBatch.duplicate,
  zcode: zcodeImport.status + ' ' + zcodeImport.messages + 'msgs/' + zcodeImport.toolCalls + 'calls',
  moved: moved.status + ' → ' + moved.cwd,
  projects: projects.projects.length,
})
