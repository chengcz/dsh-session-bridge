// lib/core.js — 导出 / 导入编排（唯一的业务入口，工具 / 命令 / HTTP 路由共用）
//
// 重复导入的判定顺序（从便宜到昂贵）：
//   1. 内容指纹查索引：同一段对话已经导入过一次且目标会话仍在 → 判重（除非 force）；
//   2. 索引没有时，若源 header 的 id 恰好是宿主里已有的会话，读那一份比内容指纹 → 判重
//      （索引被删过 / 首次跨机器合并时兜底）；
//   3. 同一次调用内不会创建两份：会话 id 撞了就换后缀，绝不覆盖。
// force 明确要求「另存副本」时才跳过 1/2，并在结果里点名 duplicateOf。
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { IndexStore } from './index-store.js'
import {
  buildBundle, parseImportFile, renderMarkdown, renderRawJsonl, suggestExtension,
} from './formats.js'
import { conversationEntries, countConversation, fingerprintEvents, firstUserText } from './fingerprint.js'
import { agentSources, listAgentSources, parseAgentSession } from './agents.js'
import { listProjects, moveSessionToProject } from './session-move.js'
import {
  cleanUploads as cleanUploadsDir, emptyTrash as emptyTrashDir, listTrash as listTrashDir,
  restoreTrash as restoreTrashDir, trashSessions,
} from './trash.js'
import { normalizeEnvelope, shapeEventsForHost } from './synthesize.js'
import {
  createSession, flushSession, hostFormatVersion, isSessionTakenError, listSessions, persistedIds,
  readSession, sessionTitles,
} from './host.js'
import {
  defaultExportDir, formatBytes, joinPath, listDirSafe, normalizeInputPath, safeFileName,
  sha256, slugifySessionId, statOrNull, writeFileAtomic,
} from './util.js'

const MAX_IMPORT_BYTES = 512 * 1024 * 1024
const AUDIT_MAX_SESSIONS = 120
const AUDIT_MAX_BYTES = 32 * 1024 * 1024

export class SessionBridgeCore {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = config
    this.store = new IndexStore()
  }

  /** 会话列表：宿主持久化里的全部会话 + 标题 + 是否由本插件导入。 */
  async listSessions() {
    const entries = await listSessions(this.ctx)
    const titles = await sessionTitles(entries.map((entry) => entry.header.id))
    const imports = await this.store.listImports()
    const importedBy = new Map(imports.map((entry) => [entry.sessionId, entry]))
    return entries
      .map((entry) => {
        const header = entry.header
        const imported = importedBy.get(header.id)
        return {
          id: header.id,
          title: titles.get(header.id) || '',
          createdAt: header.createdAt,
          cwd: header.cwd || '',
          version: header.version,
          sizeBytes: entry.sizeBytes,
          size: formatBytes(entry.sizeBytes),
          imported: !!imported,
          fingerprint: imported ? imported.fingerprint : undefined,
        }
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  async resolveExportDir(input) {
    const requested = typeof input === 'string' && input ? normalizeInputPath(input) : ''
    if (!requested) return defaultExportDir()
    return requested
  }

  async exportTargetPath(sessionId, title, format, input) {
    if (input && await isFileLikePath(input)) {
      // 明确给了文件路径：按它写（父目录不存在时创建）
      return normalizeInputPath(input)
    }
    const dir = await this.resolveExportDir(input)
    const base = safeFileName(title || sessionId, 'session').replace(/\.[^.]+$/, '').trim()
    const shortId = String(sessionId)
      .replace(/^bridge-/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || sha256(sessionId).slice(0, 8)
    return joinPath(dir, base + '-' + shortId + suggestExtension(format))
  }

  /**
   * 导出一个会话到文件。
   * @param {{sessionId: string, format?: 'bundle'|'markdown'|'jsonl', path?: string, preserveCreatedAt?: boolean}} input
   */
  async exportSession(input = {}) {
    const sessionId = String(input.sessionId || '').trim()
    if (!sessionId) throw new Error('缺少 sessionId（要导出哪个会话）')
    await flushSession(this.ctx, sessionId)
    const record = await readSession(this.ctx, sessionId)
    if (!record) throw new Error('读不到会话 ' + sessionId + '（可能已被删除，或宿主持久化服务不可用）')
    const entries = await listSessions(this.ctx)
    const targetVersion = hostFormatVersion(entries)
    const events = normalizeEnvelope(record.events, record.header.createdAt)
    const fingerprint = fingerprintEvents(events)
    const counts = countConversation(events)
    if (counts.messages === 0) throw new Error('会话 ' + sessionId + ' 没有可导出的对话内容')
    const title = await sessionTitles([sessionId]).then((map) => map.get(sessionId) || '') || firstUserText(events)
    const format = input.format === 'markdown' || input.format === 'jsonl' ? input.format : 'bundle'
    const header = {
      version: record.header.version || targetVersion,
      id: sessionId,
      createdAt: record.header.createdAt,
      ...(record.header.cwd ? { cwd: record.header.cwd } : {}),
      ...(record.header.parentSession ? { parentSession: record.header.parentSession } : {}),
      ...(record.header.origin ? { origin: record.header.origin } : {}),
      isSeeded: false,
      delegationDepth: 0,
    }
    const target = await this.exportTargetPath(sessionId, title, format, input.path)
    let content
    let bytes
    if (format === 'markdown') {
      content = renderMarkdown({ header, events, title })
    } else if (format === 'jsonl') {
      content = renderRawJsonl({ header, events, targetVersion })
    } else {
      content = JSON.stringify(buildBundle({
        header,
        events,
        title,
        exportedAt: Date.now(),
        fingerprint,
      }), null, 2) + '\n'
    }
    await writeFileAtomic(target, content)
    const info = await statOrNull(target)
    bytes = info ? info.size : Buffer.byteLength(content)
    const digest = sha256(content)
    const exportedAt = Date.now()
    await this.store.recordExport({
      path: target,
      sessionId,
      title,
      format,
      bytes,
      sha256: digest,
      fingerprint,
      exportedAt,
    })
    return {
      ok: true,
      status: 'exported',
      sessionId,
      title,
      format,
      path: target,
      bytes,
      size: formatBytes(bytes),
      sha256: digest,
      fingerprint,
      events: events.length,
      messages: counts.messages,
      toolCalls: counts.toolCalls,
    }
  }

  /** 批量导出：默认导出「本插件导入过的会话」，可用 sessionIds 指定。 */
  async exportAll(input = {}) {
    const format = input.format === 'markdown' || input.format === 'jsonl' ? input.format : 'bundle'
    const explicit = Array.isArray(input.sessionIds) ? input.sessionIds.filter(Boolean) : null
    const imports = explicit ? null : await this.store.listImports()
    const ids = explicit || imports.map((entry) => entry.sessionId)
    const persisted = persistedIds(await listSessions(this.ctx))
    const results = []
    const failed = []
    for (const id of ids) {
      if (!persisted.has(id)) {
        failed.push({ sessionId: id, error: '会话已不存在' })
        continue
      }
      try {
        results.push(await this.exportSession({ sessionId: id, format, path: input.dir }))
      } catch (error) {
        failed.push({ sessionId: id, error: String((error && error.message) || error) })
      }
    }
    return {
      ok: true,
      status: 'exported',
      total: ids.length,
      exported: results.length,
      failed: failed.length,
      dir: await this.resolveExportDir(input.dir),
      results,
      errors: failed.slice(0, 20),
    }
  }

  /**
   * 解析 + 归一 + 判重，但不落盘。预览与真正导入共用这一条管道，所以预览里说的
   * 「会导入多少条 / 是否重复」与按下导入后的实际判定必然一致。
   * @param {{path?: string, text?: string, name?: string, force?: boolean, title?: string,
   *          cwd?: string, sessionId?: string}} input
   */
  async prepareImport(input = {}) {
    let text = typeof input.text === 'string' ? input.text : ''
    let sourcePath = typeof input.path === 'string' && input.path ? normalizeInputPath(input.path) : ''
    const name = input.name || (sourcePath ? sourcePath : 'pasted-session.json')
    if (!text) {
      if (!sourcePath) throw new Error('缺少文件路径')
      const info = await statOrNull(sourcePath)
      if (!info) throw new Error('文件不存在：' + sourcePath)
      if (info.isDirectory()) throw new Error('这是一个目录，不是会话文件：' + sourcePath)
      if (info.size > MAX_IMPORT_BYTES) throw new Error('文件过大（' + formatBytes(info.size) + '），上限 ' + formatBytes(MAX_IMPORT_BYTES))
      text = await readFile(sourcePath, 'utf8')
    } else {
      sourcePath = sourcePath || '(upload)'
    }

    const entries = await listSessions(this.ctx)
    const persisted = persistedIds(entries)
    const targetVersion = hostFormatVersion(entries)
    const now = Date.now()
    // 合成 interchange 需要目标 id；先用一个不占位的候选（真正的 id 在判重之后再铸造）。
    const provisionalId = 'bridge-' + slugifySessionId(deriveSlug(name) || 'session').slice(0, 60)

    const parsed = parseImportFile(text, name, {
      sessionId: provisionalId,
      createdAt: now,
      hostVersion: targetVersion,
    })
    if (!parsed.ok) throw new Error(parsed.error)

    // 标题：显式参数 > 文件自带 > 首个提问
    const declaredTitle = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : ''
    const title = declaredTitle || parsed.title || ''
    let events = normalizeEnvelope(shapeEventsForHost(parsed.events, targetVersion), parsed.header?.createdAt)
    if (declaredTitle) {
      events = events.filter((ev) => ev.type !== 'session/title')
      events.push({
        type: 'session/title',
        seq: events.length,
        time: events.length > 0 ? events[events.length - 1].time : now,
        data: { title: declaredTitle, messageSeqs: [], source: { kind: 'user' } },
      })
    }
    const counts = countConversation(events)
    if (counts.messages === 0) throw new Error('文件里没有可导入的对话内容（0 条消息）')
    const fingerprint = fingerprintEvents(events)
    const duplicate = await this.findDuplicate({ fingerprint, sourceHeader: parsed.header, persisted })
    return { text, sourcePath, name, parsed, events, counts, fingerprint, title, duplicate, targetVersion, now, persisted }
  }

  /**
   * 只解析不落盘：给设置页的「导入前预览」用。
   * @returns 摘要 + 是否重复 + 前几条消息（供确认）
   */
  async previewImport(input = {}) {
    const prep = await this.prepareImport(input)
    const entries = conversationEntries(prep.events)
    const limit = Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 8
    return {
      ok: true,
      preview: true,
      sourceName: prep.name,
      sourcePath: prep.sourcePath,
      sourceKind: prep.parsed.kind,
      title: prep.title,
      events: prep.events.length,
      messages: prep.counts.messages,
      toolCalls: prep.counts.toolCalls,
      fingerprint: prep.fingerprint,
      duplicate: prep.duplicate
        ? { sessionId: prep.duplicate.sessionId, reason: prep.duplicate.reason }
        : null,
      sample: entries.slice(0, limit).map((entry) => previewEntry(entry, 600)),
      sampled: Math.min(entries.length, limit),
      total: entries.length,
    }
  }

  /** 从文件导入（path 与 text 二选一）。 */
  async importFile(input = {}) {
    const prep = await this.prepareImport(input)
    const { name, sourcePath, parsed, events, counts, fingerprint, title, duplicate, now, persisted } = prep
    if (duplicate && input.force !== true) {
      return {
        ok: true,
        status: 'duplicate',
        duplicateOf: duplicate.sessionId,
        duplicateReason: duplicate.reason,
        fingerprint,
        title,
        events: events.length,
        messages: counts.messages,
        toolCalls: counts.toolCalls,
        sourcePath,
        sourceName: name,
        targetAlive: true,
      }
    }

    const targetVersion = prep.targetVersion
    const finalId = this.mintSessionId(input.sessionId || deriveSlug(name), persisted)
    const sourceCwd = typeof input.cwd === 'string' && input.cwd && isAbsolute(input.cwd)
      ? input.cwd
      : (typeof parsed.header?.cwd === 'string' && isAbsolute(parsed.header.cwd) ? parsed.header.cwd : undefined)
    const header = {
      version: targetVersion,
      id: finalId,
      createdAt: input.preserveCreatedAt === true && Number.isSafeInteger(parsed.header?.createdAt)
        ? parsed.header.createdAt
        : now,
      ...(sourceCwd ? { cwd: sourceCwd } : {}),
      isSeeded: false,
      delegationDepth: 0,
    }

    const created = await this.createWithIdRetry(header, events, persisted)
    await this.store.recordImport({
      fingerprint,
      sessionId: created.header.id,
      title,
      sourcePath,
      sourceName: name,
      sourceKind: parsed.kind,
      sourceSessionId: parsed.header?.id || '',
      format: 'dsh-session-v1',
      importedAt: now,
      events: events.length,
      messages: counts.messages,
      toolCalls: counts.toolCalls,
      sha256: sha256(prep.text),
      forced: input.force === true,
      forcedCopyOf: duplicate ? duplicate.sessionId : undefined,
    })
    return {
      ok: true,
      status: 'imported',
      sessionId: created.header.id,
      title,
      fingerprint,
      events: events.length,
      messages: counts.messages,
      toolCalls: counts.toolCalls,
      sourcePath,
      sourceName: name,
      sourceKind: parsed.kind,
      via: created.via,
      forcedCopyOf: duplicate ? duplicate.sessionId : undefined,
      skippedLines: parsed.skippedLines ? parsed.skippedLines.length : 0,
    }
  }

  /** 判重：索引领先，源会话 id 兜底。返回命中的现有会话，或 null。 */
  async findDuplicate({ fingerprint, sourceHeader, persisted }) {
    const indexed = await this.store.findImport(fingerprint)
    if (indexed && persisted.has(indexed.sessionId)) {
      return { sessionId: indexed.sessionId, reason: 'fingerprint' }
    }
    const sourceId = sourceHeader && typeof sourceHeader.id === 'string' ? sourceHeader.id : ''
    if (sourceId && persisted.has(sourceId)) {
      const existing = await readSession(this.ctx, sourceId)
      if (existing && fingerprintEvents(normalizeEnvelope(existing.events, existing.header.createdAt)) === fingerprint) {
        return { sessionId: sourceId, reason: 'source-session' }
      }
    }
    return null
  }

  mintSessionId(base, taken) {
    const slug = slugifySessionId(String(base || '').replace(/^bridge-/, ''), 'session').slice(0, 60)
    let candidate = 'bridge-' + (slug || 'session')
    let counter = 2
    while (taken.has(candidate)) {
      candidate = 'bridge-' + (slug || 'session').slice(0, 55) + '-' + counter
      counter += 1
    }
    taken.add(candidate)
    return candidate
  }

  async createWithIdRetry(header, events, taken) {
    let attempt = 0
    let current = header
    for (;;) {
      try {
        const created = await createSession(this.ctx, current, events)
        return { header: current, ...created }
      } catch (error) {
        if (!isSessionTakenError(error) || attempt >= 5) throw error
        attempt += 1
        current = { ...current, id: this.mintSessionId(header.id, taken) }
      }
    }
  }

  async history() {
    const imports = await this.store.listImports()
    const exportsList = await this.store.listExports()
    const persisted = persistedIds(await listSessions(this.ctx))
    return {
      imports: imports.map((entry) => ({ ...entry, alive: persisted.has(entry.sessionId) })),
      exports: exportsList,
    }
  }

  /**
   * 重复会话审计：对「本插件导入过的 + 最近的」会话算内容指纹并分组。
   * 只做只读检查，不删任何会话（删除请用会话管理器）。
   */
  async audit(input = {}) {
    const limit = Number.isSafeInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, AUDIT_MAX_SESSIONS)
      : AUDIT_MAX_SESSIONS
    const imports = await this.store.listImports()
    const importedIds = imports.map((entry) => entry.sessionId)
    const entries = await listSessions(this.ctx)
    const byId = new Map(entries.map((entry) => [entry.header.id, entry]))
    const candidates = []
    for (const id of importedIds) {
      if (byId.has(id) && !candidates.includes(id)) candidates.push(id)
    }
    const rest = entries
      .filter((entry) => !candidates.includes(entry.header.id))
      .sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0))
    for (const entry of rest) {
      if (candidates.length >= limit) break
      if (entry.sizeBytes && entry.sizeBytes > AUDIT_MAX_BYTES) continue
      candidates.push(entry.header.id)
    }
    const groups = new Map()
    const titles = await sessionTitles(candidates)
    let scanned = 0
    let emptySkipped = 0
    for (const id of candidates.slice(0, limit)) {
      const record = await readSession(this.ctx, id)
      if (!record) continue
      scanned += 1
      // 空会话（没有任何对话内容）指纹都相同，不参与重复分组——它们不是「重复导入」，
      // 只是从未使用过的会话。
      if (countConversation(record.events).messages === 0) { emptySkipped += 1; continue }
      const fingerprint = fingerprintEvents(normalizeEnvelope(record.events, record.header.createdAt))
      const list = groups.get(fingerprint) || []
      const importedRecord = imports.find((entry) => entry.sessionId === id)
      list.push({
        id,
        title: titles.get(id) || '',
        createdAt: record.header.createdAt,
        events: record.events.length,
        imported: !!importedRecord,
        importedAt: importedRecord ? importedRecord.importedAt : undefined,
      })
      groups.set(fingerprint, list)
    }
    const duplicates = [...groups.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([fingerprint, list]) => ({ fingerprint, sessions: list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)) }))
      .sort((a, b) => b.sessions.length - a.sessions.length)
    return {
      ok: true,
      scanned,
      emptySkipped,
      duplicates,
      duplicateGroups: duplicates.length,
      redundantSessions: duplicates.reduce((sum, group) => sum + group.sessions.length - 1, 0),
    }
  }

  /**
   * 会话预览：不导出文件也能看清里面是什么（消息数、工具调用、前若干条内容）。
   * @param {{sessionId: string, limit?: number}} input
   */
  async previewSession(input = {}) {
    const sessionId = String(input.sessionId || '').trim()
    if (!sessionId) throw new Error('缺少 sessionId（要看哪个会话）')
    await flushSession(this.ctx, sessionId)
    const record = await readSession(this.ctx, sessionId)
    if (!record) throw new Error('读不到会话 ' + sessionId + '（可能已被删除，或宿主持久化服务不可用）')
    const events = normalizeEnvelope(record.events, record.header.createdAt)
    const counts = countConversation(events)
    const entries = conversationEntries(events)
    const limit = Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 400) : 60
    const titles = await sessionTitles([sessionId])
    return {
      ok: true,
      session: {
        id: sessionId,
        title: titles.get(sessionId) || firstUserText(events).replace(/\s+/g, ' ').slice(0, 120),
        createdAt: record.header.createdAt,
        cwd: record.header.cwd || '',
        version: record.header.version,
        events: events.length,
        messages: counts.messages,
        toolCalls: counts.toolCalls,
        fingerprint: fingerprintEvents(events),
      },
      messages: entries.slice(0, limit).map((entry) => previewEntry(entry, 1200)),
      total: entries.length,
      truncated: entries.length > limit,
    }
  }

  /**
   * 导出目录里的文件清单（导出后可在这里直接再导入）。
   * @param {{dir?: string}} input 省略时用默认导出目录
   */
  async listExportFiles(input = {}) {
    const dir = typeof input.dir === 'string' && input.dir ? normalizeInputPath(input.dir) : defaultExportDir()
    const records = await this.store.listExports()
    const byPath = new Map(records.map((record) => [record.path, record]))
    const files = []
    for (const entry of await listDirSafe(dir)) {
      if (!entry.isFile()) continue
      const path = joinPath(dir, entry.name)
      const info = await statOrNull(path)
      if (!info || !info.isFile()) continue
      const format = /\.dshbundle\.json$/i.test(entry.name) ? 'bundle'
        : /\.md$/i.test(entry.name) ? 'markdown'
          : /\.jsonl$/i.test(entry.name) ? 'jsonl' : 'other'
      const record = byPath.get(path)
      files.push({
        name: entry.name,
        path,
        bytes: info.size,
        size: formatBytes(info.size),
        mtime: info.mtimeMs,
        format,
        importable: format === 'bundle' || format === 'jsonl',
        sessionId: record ? record.sessionId : undefined,
        title: record ? record.title : undefined,
        fingerprint: record ? record.fingerprint : undefined,
      })
    }
    files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    return { ok: true, dir, files, total: files.length, bytes: formatBytes(totalBytes) }
  }

  /** 把会话移入回收站（可恢复，不硬删）。 */
  async trash(input = {}) {
    const ids = Array.isArray(input.sessionIds) ? input.sessionIds : (input.sessionId ? [input.sessionId] : [])
    if (ids.length === 0) throw new Error('没有指定要删除的会话')
    return trashSessions({ ctx: this.ctx }, ids)
  }

  async listTrash() {
    return listTrashDir()
  }

  async restoreTrash(input = {}) {
    return restoreTrashDir(input.batch, input.sessionIds)
  }

  async emptyTrash(input = {}) {
    return emptyTrashDir({ days: input.days })
  }

  async cleanUploads(input = {}) {
    return cleanUploadsDir({ keepMs: input.keepMs })
  }

  /**
   * 把会话挪到另一个 project（改 cwd + 搬分组目录 + 同步投影缓存）。
   * @param {{sessionId: string, cwd: string}} input
   */
  async moveSession(input = {}) {
    return moveSessionToProject({ ctx: this.ctx }, input.sessionId, input.cwd)
  }

  /** 现有 project 列表（给「移动到…」做候选）。 */
  async listProjects() {
    return { ok: true, projects: await listProjects() }
  }

  /** 扫描其他 Coding Agent 的会话目录（只读，不导入）。 */
  async listSources(input = {}) {
    return listAgentSources({ limit: input.limit })
  }

  /**
   * 从其他 Agent 导入：读日志 → interchange IR → 复用同一条导入管道（同样受指纹判重）。
   * @param {{kind: 'claude-code'|'codex', path: string, force?: boolean, preview?: boolean, title?: string}} input
   */
  async importAgentSession(input = {}) {
    const kind = String(input.kind || '')
    if (!agentSources().some((source) => source.kind === kind)) {
      throw new Error('不支持的来源：' + (kind || '(空)'))
    }
    const path = normalizeInputPath(input.path)
    if (!path) throw new Error('缺少来源文件路径')
    const parsed = await parseAgentSession(kind, path)
    const base = {
      ok: true,
      kind,
      path,
      name: parsed.name,
      sourceSessionId: parsed.sourceSessionId,
      turns: parsed.turns,
      previewTitle: parsed.title,
    }
    if (input.preview === true) return { ...base, preview: true }
    const out = await this.importFile({
      text: parsed.text,
      name: parsed.name,
      force: input.force === true,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined,
      cwd: parsed.cwd || undefined,
    })
    return { ...base, ...out }
  }

  /**
   * 批量从文件导入：逐条走同一条管道，单条失败不影响其余。
   * 每条都独立判重，结果逐条返回（导入 / 重复 / 失败），不做「一错全停」。
   * @param {{paths?: string[], force?: boolean, title?: string, cwd?: string}} input
   */
  async importFiles(input = {}) {
    const paths = Array.isArray(input.paths)
      ? input.paths.map((path) => String(path || '').trim()).filter(Boolean)
      : []
    if (paths.length === 0) throw new Error('没有指定要导入的文件')
    const results = []
    for (const path of paths) {
      try {
        const out = await this.importFile({
          path,
          force: input.force === true,
          title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined,
          cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
        })
        results.push({ ...out, path: normalizeInputPath(path) })
      } catch (error) {
        results.push({
          ok: false,
          status: 'failed',
          path: normalizeInputPath(path),
          error: String((error && error.message) || error),
        })
      }
    }
    const count = (status) => results.filter((result) => result.status === status).length
    return {
      ok: true,
      status: 'batch',
      total: paths.length,
      imported: count('imported'),
      duplicate: count('duplicate'),
      failed: count('failed'),
      results,
    }
  }

  /**
   * 批量从其他 Agent 导入：[{kind, path}] 逐条导入，单条失败不影响其余。
   * @param {{items?: Array<{kind: string, path: string}>, force?: boolean}} input
   */
  async importAgentSessions(input = {}) {
    const items = Array.isArray(input.items) ? input.items : []
    const cleaned = items
      .filter((item) => item && typeof item.path === 'string' && item.path.trim())
      .map((item) => ({ kind: String(item.kind || ''), path: item.path.trim() }))
    if (cleaned.length === 0) throw new Error('没有选中任何来源会话')
    const results = []
    for (const item of cleaned) {
      try {
        const out = await this.importAgentSession({ kind: item.kind, path: item.path, force: input.force === true })
        results.push({ ...out, kind: item.kind, path: item.path })
      } catch (error) {
        results.push({
          ok: false,
          status: 'failed',
          kind: item.kind,
          path: item.path,
          error: String((error && error.message) || error),
        })
      }
    }
    const count = (status) => results.filter((result) => result.status === status).length
    return {
      ok: true,
      status: 'batch',
      total: cleaned.length,
      imported: count('imported'),
      duplicate: count('duplicate'),
      failed: count('failed'),
      results,
    }
  }

  /**
   * 批量处理重复：按策略在每组里挑一条保留，其余全部移入回收站。
   *
   * 策略只影响「组内留哪一条」：
   *   keep-original 优先留本插件导入过的那条（原始），其次最早 —— 副本是后生的，删副本最安全
   *   keep-earliest 留 createdAt 最早的
   *   keep-newest   留 createdAt 最新的
   * dryRun 只算不动，界面用它先把「会删哪些」摊开给用户看。
   * @param {{strategy?: string, dryRun?: boolean, limit?: number}} input
   */
  async resolveDuplicates(input = {}) {
    const strategy = input.strategy === 'keep-newest'
      ? 'keep-newest'
      : (input.strategy === 'keep-earliest' ? 'keep-earliest' : 'keep-original')
    const audit = await this.audit({ limit: input.limit })
    const plan = []
    for (const group of audit.duplicates) {
      const ordered = [...group.sessions].sort((a, b) => duplicateOrder(strategy, a, b))
      const keep = ordered[0]
      const drop = ordered.slice(1)
      if (!keep || drop.length === 0) continue
      plan.push({
        fingerprint: group.fingerprint,
        keep,
        drop,
      })
    }
    const ids = plan.flatMap((entry) => entry.drop.map((session) => session.id))
    if (input.dryRun === true) {
      return {
        ok: true,
        status: 'plan',
        dryRun: true,
        strategy,
        scanned: audit.scanned,
        groups: plan.length,
        wouldTrash: ids.length,
        plan,
      }
    }
    if (ids.length === 0) {
      return { ok: true, status: 'resolved', strategy, scanned: audit.scanned, groups: 0, trashed: 0, plan: [] }
    }
    const out = await trashSessions({ ctx: this.ctx }, ids)
    return {
      ok: true,
      status: 'resolved',
      strategy,
      scanned: audit.scanned,
      groups: plan.length,
      trashed: out.trashed,
      skipped: out.skipped,
      plan,
    }
  }
}

const SESSION_FILE_EXT = /\.(dshbundle\.json|json|jsonl|md)$/i

/** 输入是不是「文件」而不是「目录」：已存在的文件，或带会话文件扩展名的路径。 */
async function isFileLikePath(input) {
  const target = normalizeInputPath(input)
  if (!target) return false
  const info = await statOrNull(target)
  if (info) return info.isFile()
  return SESSION_FILE_EXT.test(target)
}

/**
 * 去重时的「组内优先保留」排序：返回负数表示 a 应该被保留。
 * keep-original 先看是不是本插件导入过的（原始），再看导入时间/创建时间——副本是后生的。
 */
function duplicateOrder(strategy, a, b) {
  if (strategy === 'keep-newest') return (b.createdAt || 0) - (a.createdAt || 0)
  if (strategy === 'keep-earliest') return (a.createdAt || 0) - (b.createdAt || 0)
  const aImported = a.imported === true ? 0 : 1
  const bImported = b.imported === true ? 0 : 1
  if (aImported !== bImported) return aImported - bImported
  const aAt = Number.isSafeInteger(a.importedAt) ? a.importedAt : (a.createdAt || 0)
  const bAt = Number.isSafeInteger(b.importedAt) ? b.importedAt : (b.createdAt || 0)
  if (aAt !== bAt) return aAt - bAt
  return (a.createdAt || 0) - (b.createdAt || 0)
}

function deriveSlug(name) {
  const base = String(name || '').split(/[\\/]/).pop() || 'session'
  return base
    .replace(/\.(dshbundle\.json|json|jsonl|md|zst|zstd)$/i, '')
    .replace(/^session\.v\d+$/i, 'session')
    .slice(0, 80) || 'session'
}

/** 一条对话记录 → 预览用的紧凑结构（长文本截断，工具只留名字）。 */
function previewEntry(entry, maxChars = 800) {
  const blocks = Array.isArray(entry && entry.content) ? entry.content : []
  const texts = []
  const reasoning = []
  const tools = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.t === 'text') texts.push(block.v)
    else if (block.t === 'reasoning') reasoning.push(block.v)
    else if (block.t === 'tool-call') tools.push(block.n)
    else if (block.t === 'image') texts.push('[image]')
    else if (block.t === 'file') texts.push('[file] ' + (block.n || ''))
  }
  const clip = (value, limit) => (value.length > limit ? value.slice(0, limit) + '…' : value)
  return {
    role: entry && entry.role ? entry.role : 'unknown',
    text: clip(texts.join('\n').trim(), maxChars),
    reasoning: reasoning.length > 0 ? clip(reasoning.join('\n').trim(), 400) : undefined,
    tools: tools.length > 0 ? tools : undefined,
    error: entry && entry.err === true ? true : undefined,
  }
}
