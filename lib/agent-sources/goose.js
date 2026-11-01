// lib/agent-sources/goose.js — Goose（Block 出品）的会话库
// 块词汇与列名参考 dsh-chat-import 的 lib/sources/goose.mjs（MIT，Copyright (c) 2026 Nwflower, Scarlett）；实现为独立重写，见 THIRD-PARTY-NOTICES.md。
//
// 库在 <data dir>/sessions/sessions.db：sessions 表是索引，messages 表存
// content_json（块数组）。结果在 user 消息里以 toolResponse 块返回，所以「只带结果的
// user 消息」由 assembleTurns 回填，不另开一轮。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeDb, columnsOf, encodeRef, openDb, safeAll, tableNames, toMs } from './sqlite.js'
import { blocksOf } from './blocks.js'
import { assembleTurns } from './turns.js'

/** Goose 数据目录（与上游一致：macOS 走 Application Support，其余走 XDG）。 */
export function gooseDataDir(home = homedir()) {
  const override = process.env.GOOSE_PATH_ROOT
  if (override) return join(override, 'data')
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'Block', 'goose', 'data')
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Block', 'goose')
  return join(home, '.local', 'share', 'goose')
}

export function gooseDbPath(home = homedir()) {
  return join(gooseDataDir(home), 'sessions', 'sessions.db')
}

export function isGooseDb(dbPath) {
  const db = openDb(dbPath)
  if (!db) return false
  try {
    const tables = tableNames(db)
    return tables.has('sessions') && tables.has('messages')
  } finally {
    closeDb(db)
  }
}

export function listGooseSessions(dbPath, limit = 40) {
  const db = openDb(dbPath)
  if (!db) return []
  try {
    if (!tableNames(db).has('sessions')) return []
    const cols = columnsOf(db, 'sessions')
    const pick = (row, name) => (cols.has(name) ? row[name] : undefined)
    const rows = safeAll(db, 'SELECT * FROM sessions ORDER BY rowid DESC')
    const counts = new Map()
    for (const row of safeAll(db, 'SELECT session_id AS sid, COUNT(*) AS c FROM messages GROUP BY session_id')) {
      counts.set(row.sid, Number(row.c) || 0)
    }
    return rows.slice(0, limit).map((row) => {
      const name = typeof pick(row, 'name') === 'string' ? pick(row, 'name').trim() : ''
      const description = typeof pick(row, 'description') === 'string' ? pick(row, 'description').trim() : ''
      return {
        id: String(row.id),
        title: name || description,
        cwd: typeof pick(row, 'working_dir') === 'string' ? pick(row, 'working_dir') : '',
        updatedAt: toMs(pick(row, 'updated_at')) ?? toMs(pick(row, 'created_at')),
        messages: counts.get(row.id) || 0,
        path: encodeRef(dbPath, String(row.id)),
      }
    })
  } finally {
    closeDb(db)
  }
}

export function readGooseSession(dbPath, sessionId) {
  const db = openDb(dbPath)
  if (!db) throw new Error('打不开库：' + dbPath)
  try {
    const sessionCols = columnsOf(db, 'sessions')
    const sessionRow = safeAll(db, 'SELECT * FROM sessions WHERE id = ?', sessionId)[0] || {}
    const pick = (name) => (sessionCols.has(name) ? sessionRow[name] : undefined)
    const messageCols = columnsOf(db, 'messages')
    const order = messageCols.has('created_timestamp') ? 'created_timestamp, id' : 'id'
    const rows = safeAll(db, 'SELECT * FROM messages WHERE session_id = ? ORDER BY ' + order, sessionId)
    if (rows.length === 0) throw new Error('这个会话在库里没有消息')

    const flow = []
    for (const row of rows) {
      const role = String(row.role || '')
      if (role !== 'user' && role !== 'assistant') continue
      let content = []
      if (typeof row.content_json === 'string' && row.content_json) {
        try {
          const parsed = JSON.parse(row.content_json)
          content = Array.isArray(parsed) ? parsed : []
        } catch {
          content = []
        }
      }
      // Goose 用 metadata.userVisible=false 标记「只给模型看的」消息
      if (typeof row.metadata_json === 'string' && row.metadata_json) {
        try {
          const metadata = JSON.parse(row.metadata_json)
          if (metadata && metadata.userVisible === false) continue
        } catch {
          // 元数据坏掉不影响正文
        }
      }
      const blocks = blocksOf(content)
      if (blocks.length === 0) continue
      flow.push({ role, blocks, time: toMs(row.created_timestamp) })
    }

    const turns = assembleTurns(flow)
    if (turns.length === 0) throw new Error('这个会话里没有可导入的对话内容')
    const name = typeof pick('name') === 'string' ? pick('name').trim() : ''
    const description = typeof pick('description') === 'string' ? pick('description').trim() : ''
    const cwd = typeof pick('working_dir') === 'string' ? pick('working_dir') : ''
    const title = name || description || firstPrompt(turns)
    return {
      ok: true,
      doc: {
        interchange: 'dsh-chat-import',
        version: 1,
        title,
        provider: typeof pick('provider_name') === 'string' && pick('provider_name') ? pick('provider_name') : 'goose',
        model: '',
        meta: cwd ? { cwd } : {},
        turns,
      },
      cwd,
      sourceId: sessionId,
      title,
    }
  } finally {
    closeDb(db)
  }
}

function firstPrompt(turns) {
  const turn = turns.find((item) => item.prompt.trim())
  return turn ? turn.prompt.replace(/\s+/g, ' ').slice(0, 100) : ''
}
