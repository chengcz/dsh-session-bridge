// lib/agent-sources/opencode-family.js — zcode / opencode / mimocode 这一族
// 表结构与字段映射参考 dsh-chat-import 的 lib/sources/opencode.mjs（MIT，Copyright (c) 2026 Nwflower, Scarlett）；实现为独立重写，见 THIRD-PARTY-NOTICES.md。
//
// 三者共用同一套库结构（opencode 派生）：session / message / part 三张表，message 与 part
// 的正文都是 JSON 文本列。差别只在可选的列（zcode 有 parent_id 与 sequence，mimocode 的
// session 没有 model），所以这里一律「先探列再写 SQL」，不做版本分叉。
import { closeDb, columnsOf, encodeRef, openDb, parseJsonColumn, safeAll, tableNames, toMs } from './sqlite.js'
import { assembleTurns, stringifyToolValue } from './turns.js'

/** 这不是一族的库（缺三张表）→ false，交给下一个来源去认。 */
export function isOpenCodeFamily(dbPath) {
  const db = openDb(dbPath)
  if (!db) return false
  try {
    const tables = tableNames(db)
    return tables.has('session') && tables.has('message') && tables.has('part')
  } finally {
    closeDb(db)
  }
}

function sessionColumns(db) {
  return columnsOf(db, 'session')
}

function orderByFor(columns, fallback = 'time_created') {
  return columns.has('sequence') ? 'sequence, id' : fallback + ', id'
}

/** 库里的会话列表（只读摘要：标题、工作目录、最近活跃、消息数）。 */
export function listFamilySessions(dbPath, limit = 40) {
  const db = openDb(dbPath)
  if (!db) return []
  try {
    const tables = tableNames(db)
    if (!tables.has('session')) return []
    const cols = sessionColumns(db)
    const select = ['id']
    select.push(cols.has('title') ? 'title' : "'' AS title")
    select.push(cols.has('directory') ? 'directory' : "'' AS directory")
    if (cols.has('time_created')) select.push('time_created')
    if (cols.has('time_updated')) select.push('time_updated')
    const where = cols.has('parent_id') ? " WHERE (parent_id IS NULL OR parent_id = '')" : ''
    const order = cols.has('time_updated') ? 'time_updated DESC' : (cols.has('time_created') ? 'time_created DESC' : 'rowid DESC')
    const rows = safeAll(db, 'SELECT ' + select.join(', ') + ' FROM session' + where + ' ORDER BY ' + order)

    const counts = new Map()
    if (tables.has('message')) {
      for (const row of safeAll(db, 'SELECT session_id AS sid, COUNT(*) AS c FROM message GROUP BY session_id')) {
        counts.set(row.sid, Number(row.c) || 0)
      }
    }
    return rows.slice(0, limit).map((row) => ({
      id: String(row.id),
      title: typeof row.title === 'string' ? row.title : '',
      cwd: typeof row.directory === 'string' ? row.directory : '',
      updatedAt: toMs(row.time_updated) ?? toMs(row.time_created),
      messages: counts.get(row.id) || 0,
      path: encodeRef(dbPath, String(row.id)),
    }))
  } finally {
    closeDb(db)
  }
}

/** part 的 JSON → 中间 block（各家的 part 类型都在这里收敛）。 */
function blocksOfPart(data) {
  if (!data || typeof data !== 'object') return []
  // zcode / opencode 用 synthetic 标记「给模型看的注入」：工具目录、系统提醒等。
  // 它们不是用户说的话，进对话会让每个提醒都变成一轮提问。
  if (data.synthetic === true) return []
  const type = String(data.type || '')
  if (type === 'text') {
    return typeof data.text === 'string' && data.text ? [{ type: 'text', text: data.text }] : []
  }
  if (type === 'reasoning') {
    return typeof data.text === 'string' && data.text ? [{ type: 'reasoning', text: data.text }] : []
  }
  if (type === 'file') {
    const name = data.filename || data.name || data.path || ''
    return [{ type: 'text', text: '[file] ' + String(name) }]
  }
  if (type === 'tool' || type === 'tool-call' || type === 'tool_call') {
    const callId = String(data.callID || data.callId || data.id || '')
    const state = data.state && typeof data.state === 'object' ? data.state : {}
    const blocks = [{
      type: 'tool-call',
      id: callId,
      name: String(data.tool || data.name || 'unknown'),
      arguments: stringifyToolValue(state.input ?? data.input ?? data.arguments),
    }]
    const status = String(state.status || '')
    if (status === 'completed' && state.output !== undefined) {
      blocks.push({ type: 'tool-result', id: callId, content: stringifyToolValue(state.output), isError: false })
    } else if (status === 'error') {
      blocks.push({
        type: 'tool-result',
        id: callId,
        content: stringifyToolValue(state.error ?? state.output ?? ''),
        isError: true,
      })
    }
    return blocks
  }
  return []
}

/** 读一个会话 → interchange 文档。 */
export function readFamilySession(dbPath, sessionId) {
  const db = openDb(dbPath)
  if (!db) throw new Error('打不开库：' + dbPath + '（可能已被移除或被占用）')
  try {
    const sessionCols = sessionColumns(db)
    const sessionSelect = ['title', 'directory']
    const sessionRow = safeAll(db, 'SELECT ' + sessionSelect.join(', ') + ' FROM session WHERE id = ?', sessionId)[0] || {}

    const messageCols = columnsOf(db, 'message')
    const partCols = columnsOf(db, 'part')
    const messages = safeAll(
      db,
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY ' + orderByFor(messageCols),
      sessionId,
    )
    if (messages.length === 0) throw new Error('这个会话在库里没有消息（可能已被清空）')
    const parts = safeAll(
      db,
      'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY ' + orderByFor(partCols),
      sessionId,
    )
    const partsByMessage = new Map()
    for (const row of parts) {
      const data = parseJsonColumn(row.data)
      if (!data) continue
      if (!partsByMessage.has(row.message_id)) partsByMessage.set(row.message_id, [])
      partsByMessage.get(row.message_id).push(data)
    }

    const flow = []
    let providerId = ''
    let modelId = ''
    for (const row of messages) {
      const data = parseJsonColumn(row.data)
      if (!data) continue
      // 注入消息（工具目录 / 系统提醒）与压缩摘要都不是对话内容
      if (data.synthetic === true || data.visibility === 'model-only') continue
      if (data.mode === 'compaction' || data.summary === true) continue
      if (!providerId && typeof data.providerID === 'string') providerId = data.providerID
      if (!modelId && typeof data.modelID === 'string') modelId = data.modelID
      const blocks = (partsByMessage.get(row.id) || []).flatMap(blocksOfPart)
      if (blocks.length === 0) continue
      flow.push({ role: String(data.role || ''), blocks })
    }

    const turns = assembleTurns(flow)
    if (turns.length === 0) throw new Error('这个会话里没有可导入的对话内容')
    const cwd = sessionRow && typeof sessionRow.directory === 'string' ? sessionRow.directory : ''
    const title = sessionRow && typeof sessionRow.title === 'string' ? sessionRow.title : ''
    return {
      ok: true,
      doc: {
        interchange: 'dsh-chat-import',
        version: 1,
        title: title || firstPrompt(turns),
        provider: providerId || 'unknown',
        model: modelId,
        meta: cwd ? { cwd } : {},
        turns,
      },
      cwd,
      sourceId: sessionId,
      title: title || firstPrompt(turns),
    }
  } finally {
    closeDb(db)
  }
}

function firstPrompt(turns) {
  const turn = turns.find((item) => item.prompt.trim())
  return turn ? turn.prompt.replace(/\s+/g, ' ').slice(0, 100) : ''
}
