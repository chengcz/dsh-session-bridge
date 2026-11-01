// lib/routes.js — 设置页 / 侧栏用的 HTTP 路由（与工具、命令共用同一套 core 编排）
//
// 所有路由都是 POST + JSON，路径前缀 /api-session-bridge/。浏览器拿不到本地文件路径，
// 所以「选择文件…」先 upload 把字节暂存到宿主，再按普通路径导入；导入管道只有一条。
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { bridgeHome, formatBytes, listDirSafe, safeFileName, writeFileAtomic } from './util.js'

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

function jsonRoute(path, handle) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      let status
      let payload
      try {
        const body = await readBody(req)
        const out = await handle(body)
        status = out[0]
        payload = out[1]
      } catch (error) {
        status = 500
        payload = { ok: false, error: String((error && error.message) || error) }
      }
      res.writeHead(status, JSON_HEADERS)
      res.end(JSON.stringify(payload))
    },
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_UPLOAD_BYTES * 1.4) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const fail = (status, error) => [status, { ok: false, error }]

export function registerRoutes(webServer, core) {
  webServer.register(jsonRoute('/api-session-bridge/list', async () => {
    const sessions = await core.listSessions()
    const history = await core.history()
    return [200, {
      ok: true,
      sessions,
      imports: history.imports,
      exports: history.exports.slice(0, 20),
      exportDir: core.config.exportDir || '',
    }]
  }))

  webServer.register(jsonRoute('/api-session-bridge/export', async (body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (!sessionId) return fail(400, '缺少 sessionId')
    const out = await core.exportSession({
      sessionId,
      format: body.format,
      path: typeof body.path === 'string' ? body.path : undefined,
    })
    return [200, out]
  }))

  webServer.register(jsonRoute('/api-session-bridge/export-all', async (body) => {
    const out = await core.exportAll({
      dir: typeof body.dir === 'string' ? body.dir : undefined,
      format: body.format,
      sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds : undefined,
    })
    return [200, out]
  }))

  webServer.register(jsonRoute('/api-session-bridge/import', async (body) => {
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (!path) return fail(400, '缺少文件路径')
    const out = await core.importFile({
      path,
      force: body.force === true,
      title: typeof body.title === 'string' ? body.title : undefined,
      cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
      preserveCreatedAt: body.preserveCreatedAt === true,
    })
    return [200, out]
  }))

  webServer.register(jsonRoute('/api-session-bridge/upload', async (body) => {
    const name = safeFileName(body.name, 'uploaded-session.json')
    const data = typeof body.data === 'string' ? body.data : ''
    if (!data) return fail(400, '上传内容为空')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0) return fail(400, '上传内容为空')
    if (bytes.length > MAX_UPLOAD_BYTES) return fail(413, '文件过大（' + formatBytes(bytes.length) + '），上限 ' + formatBytes(MAX_UPLOAD_BYTES))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(bridgeHome(), 'uploads', stamp + '-' + name)
    await writeFileAtomic(target, bytes)
    return [200, { ok: true, path: target, name, bytes: bytes.length, size: formatBytes(bytes.length) }]
  }))

  webServer.register(jsonRoute('/api-session-bridge/history', async () => {
    return [200, { ok: true, ...(await core.history()) }]
  }))

  webServer.register(jsonRoute('/api-session-bridge/audit', async (body) => {
    const out = await core.audit({ limit: Number(body.limit) })
    return [200, out]
  }))

  // 上传暂存列表（设置页「清理暂存」用；只列本插件自己的暂存目录）
  webServer.register(jsonRoute('/api-session-bridge/uploads', async () => {
    const dir = join(bridgeHome(), 'uploads')
    const entries = await listDirSafe(dir)
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      files.push({ name: entry.name, path: join(dir, entry.name) })
    }
    return [200, { ok: true, dir, files: files.slice(-50) }]
  }))

  // ── 管理界面用的增补路由 ──────────────────────────────────────────────────

  /** 会话预览：消息数、工具调用、前若干条内容（不导出文件）。 */
  webServer.register(jsonRoute('/api-session-bridge/preview-session', async (body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (!sessionId) return fail(400, '缺少 sessionId')
    return [200, await core.previewSession({ sessionId, limit: Number(body.limit) })]
  }))

  /** 批量从文件导入：逐条导入，逐条返回结果。 */
  webServer.register(jsonRoute('/api-session-bridge/import-batch', async (body) => {
    const paths = Array.isArray(body.paths) ? body.paths.filter((path) => typeof path === 'string' && path.trim()) : []
    if (paths.length === 0) return fail(400, '没有指定要导入的文件')
    return [200, await core.importFiles({
      paths,
      force: body.force === true,
      title: typeof body.title === 'string' ? body.title : undefined,
      cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
    })]
  }))

  /** 批量处理重复：按策略每组留一条，其余移入回收站（dryRun 只算不动）。 */
  webServer.register(jsonRoute('/api-session-bridge/audit/resolve', async (body) => {
    return [200, await core.resolveDuplicates({
      strategy: typeof body.strategy === 'string' ? body.strategy : undefined,
      dryRun: body.dryRun === true,
      limit: Number(body.limit),
    })]
  }))

  /** 导入前预览：会导入多少条、是否与已有会话重复。 */
  webServer.register(jsonRoute('/api-session-bridge/preview-import', async (body) => {
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (!path) return fail(400, '缺少文件路径')
    return [200, await core.previewImport({ path, title: typeof body.title === 'string' ? body.title : undefined })]
  }))

  /** 导出目录里的文件清单。 */
  webServer.register(jsonRoute('/api-session-bridge/exports', async (body) => {
    return [200, await core.listExportFiles({ dir: typeof body.dir === 'string' ? body.dir : undefined })]
  }))

  /** 批量导出：body.sessionIds 为空时导出全部已导入会话。 */
  webServer.register(jsonRoute('/api-session-bridge/export-batch', async (body) => {
    const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds.filter((id) => typeof id === 'string' && id) : undefined
    return [200, await core.exportAll({
      format: body.format,
      dir: typeof body.dir === 'string' ? body.dir : undefined,
      sessionIds: sessionIds && sessionIds.length > 0 ? sessionIds : undefined,
    })]
  }))

  /** 移入回收站（可恢复）。 */
  webServer.register(jsonRoute('/api-session-bridge/trash', async (body) => {
    const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds : []
    if (sessionIds.length === 0) return fail(400, '没有指定要删除的会话')
    return [200, await core.trash({ sessionIds })]
  }))

  webServer.register(jsonRoute('/api-session-bridge/trash/list', async () => {
    return [200, await core.listTrash()]
  }))

  webServer.register(jsonRoute('/api-session-bridge/trash/restore', async (body) => {
    const batch = typeof body.batch === 'string' ? body.batch : ''
    if (!batch) return fail(400, '缺少批次 id')
    return [200, await core.restoreTrash({
      batch,
      sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds : undefined,
    })]
  }))

  webServer.register(jsonRoute('/api-session-bridge/trash/empty', async (body) => {
    return [200, await core.emptyTrash({ days: Number(body.days) })]
  }))

  /** 清理暂存的待导入文件。 */
  webServer.register(jsonRoute('/api-session-bridge/cleanup/uploads', async (body) => {
    const keepMs = Number(body.keepMs)
    return [200, await core.cleanUploads({ keepMs: Number.isFinite(keepMs) ? keepMs : 0 })]
  }))

  /** 把会话移动到另一个 project。 */
  webServer.register(jsonRoute('/api-session-bridge/session/move', async (body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
    if (!sessionId) return fail(400, '缺少 sessionId')
    if (!cwd) return fail(400, '缺少目标路径 cwd')
    return [200, await core.moveSession({ sessionId, cwd })]
  }))

  /** 现有 project 列表（移动目标候选）。 */
  webServer.register(jsonRoute('/api-session-bridge/projects', async () => {
    return [200, await core.listProjects()]
  }))

  /** 扫描其他 Coding Agent 的会话目录（只读）。 */
  webServer.register(jsonRoute('/api-session-bridge/sources', async (body) => {
    return [200, await core.listSources({ limit: Number(body.limit) })]
  }))

  /** 批量从其他 Agent 导入：items = [{kind, path}]。 */
  webServer.register(jsonRoute('/api-session-bridge/import-source-batch', async (body) => {
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) return fail(400, '没有选中任何来源会话')
    return [200, await core.importAgentSessions({ items, force: body.force === true })]
  }))

  /** 从其他 Agent 的会话导入（preview: true 时只解析不落盘）。 */
  webServer.register(jsonRoute('/api-session-bridge/import-source', async (body) => {
    const kind = typeof body.kind === 'string' ? body.kind : ''
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (!kind) return fail(400, '缺少来源类型')
    if (!path) return fail(400, '缺少来源文件路径')
    return [200, await core.importAgentSession({
      kind,
      path,
      force: body.force === true,
      preview: body.preview === true,
      title: typeof body.title === 'string' ? body.title : undefined,
    })]
  }))
}
