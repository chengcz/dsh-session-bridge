// lib/agent-sources/zed.js — Zed 编辑器的线程库
//
// <data dir>/threads/threads.db 的 threads 表：一行一个线程，`data` 是 zstd 压缩的
// 线程 JSON（data_type='zstd'，也认未压缩的 'json'）。summary 列就是标题。
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeDb, columnsOf, encodeRef, openDb, safeAll, tableNames, toMs } from './sqlite.js'
import { blocksOf } from './blocks.js'
import { assembleTurns } from './turns.js'

export function zedThreadsDbPath(home = homedir()) {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'Zed', 'threads', 'threads.db')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Zed', 'threads', 'threads.db')
  }
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && /^([a-zA-Z]:[\\/]|[\\/])/.test(xdg) ? join(xdg, 'zed') : join(home, '.local', 'share', 'zed')
  return join(base, 'threads', 'threads.db')
}

function isThreadsDb(dbPath) {
  const db = openDb(dbPath)
  if (!db) return false
  try {
    const tables = tableNames(db)
    if (!tables.has('threads')) return false
    const cols = columnsOf(db, 'threads')
    return cols.has('data') && cols.has('id')
  } finally {
    closeDb(db)
  }
}

/** data 列 → 线程对象；解压/解析失败返回 null（坏线程跳过，不虚构）。 */
function decodeThread(row) {
  const raw = row.data
  const type = String(row.data_type || 'zstd')
  try {
    let text
    if (raw instanceof Uint8Array) {
      const bytes = Buffer.from(raw)
      text = type === 'json' ? bytes.toString('utf8') : zstdDecompressSync(bytes).toString('utf8')
    } else if (typeof raw === 'string') {
      text = raw
    } else {
      return null
    }
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** folder_paths 列是「\n 连路径 / , 连顺序」的编码，取第一个当 cwd。 */
function firstFolderPath(value) {
  if (typeof value !== 'string' || !value) return ''
  return value.split('\n').filter(Boolean)[0] || ''
}

export function listZedThreads(dbPath, limit = 40) {
  if (!isThreadsDb(dbPath)) return []
  const db = openDb(dbPath)
  if (!db) return []
  try {
    const cols = columnsOf(db, 'threads')
    const select = ['id']
    select.push(cols.has('summary') ? 'summary' : "'' AS summary")
    if (cols.has('updated_at')) select.push('updated_at')
    if (cols.has('created_at')) select.push('created_at')
    if (cols.has('folder_paths')) select.push('folder_paths')
    const rows = safeAll(db, 'SELECT ' + select.join(', ') + ' FROM threads ORDER BY rowid DESC')
    return rows.slice(0, limit).map((row) => ({
      id: String(row.id),
      title: typeof row.summary === 'string' ? row.summary : '',
      cwd: firstFolderPath(row.folder_paths),
      updatedAt: toMs(row.updated_at) ?? toMs(row.created_at),
      messages: 0,
      path: encodeRef(dbPath, String(row.id)),
    }))
  } finally {
    closeDb(db)
  }
}

export function readZedThread(dbPath, threadId) {
  const db = openDb(dbPath)
  if (!db) throw new Error('打不开库：' + dbPath)
  try {
    const row = safeAll(db, 'SELECT * FROM threads WHERE id = ?', threadId)[0]
    if (!row) throw new Error('库里没有这个线程：' + threadId)
    const thread = decodeThread(row)
    if (!thread) throw new Error('这个线程的数据解不开（zstd 损坏或格式不认识）')
    const source = Array.isArray(thread.messages) ? thread.messages
      : (Array.isArray(thread.chunks) ? thread.chunks : [])
    const flow = []
    for (const message of source) {
      if (!message || typeof message !== 'object') continue
      const role = String(message.role || message.author || '')
      if (role !== 'user' && role !== 'assistant') continue
      const blocks = blocksOf(message.content ?? message.chunks ?? message.text)
      if (blocks.length === 0) continue
      flow.push({ role, blocks, time: toMs(message.timestamp) })
    }
    const turns = assembleTurns(flow)
    if (turns.length === 0) throw new Error('这个线程里没有可导入的对话内容')
    const cwd = firstFolderPath(row.folder_paths)
    const title = (typeof row.summary === 'string' && row.summary)
      || (typeof thread.summary === 'string' ? thread.summary : '')
      || firstPrompt(turns)
    return {
      ok: true,
      doc: {
        interchange: 'dsh-chat-import',
        version: 1,
        title,
        provider: 'zed',
        model: '',
        meta: cwd ? { cwd } : {},
        turns,
      },
      cwd,
      sourceId: threadId,
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
