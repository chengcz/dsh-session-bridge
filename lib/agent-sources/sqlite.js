// lib/agent-sources/sqlite.js — 只读打开别的 Agent 的 SQLite 历史库
//
// 这些库都不归我们管：只读打开、不建表、不写 WAL、跑完就关。库可能正被原程序
// 使用（WAL 模式），所以既要能读到最新提交，又不能留下任何痕迹。
import { DatabaseSync } from 'node:sqlite'

/** 只读打开；打不开返回 null（「这台机器上没有这个库」与「库坏了」都走同一分支）。 */
export function openDb(path) {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

export function closeDb(db) {
  try {
    db.close()
  } catch {
    // 关闭失败不影响已经读到的数据
  }
}

export function tableNames(db) {
  try {
    return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
  } catch {
    return new Set()
  }
}

export function columnsOf(db, table) {
  try {
    return new Set(db.prepare('PRAGMA table_info(' + JSON.stringify(table) + ')').all().map((row) => row.name))
  } catch {
    return new Set()
  }
}

/** 安全的 prepare().all()：表/列不匹配时返回空数组，不把异常抛给调用方。 */
export function safeAll(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params)
  } catch {
    return []
  }
}

/** JSON 列解析：解析不了返回 null（坏行跳过，不让一条脏数据毁掉整个库）。 */
export function parseJsonColumn(value) {
  if (typeof value !== 'string' || !value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** 统一时间戳到毫秒：有的库存秒、有的存毫秒、有的存 ISO 字符串。 */
export function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const asNumber = Number(value)
    if (Number.isFinite(asNumber) && asNumber > 0) return toMs(asNumber)
  }
  return undefined
}

/** 一个库里的会话条目，`path` 用 `<dbPath>#<sessionId>` 编码，界面与深链都按它走。 */
export function encodeRef(dbPath, sessionId) {
  return dbPath + '#' + sessionId
}

export function decodeRef(ref) {
  const text = String(ref || '')
  const index = text.lastIndexOf('#')
  if (index <= 0) return { dbPath: text, sessionId: '' }
  return { dbPath: text.slice(0, index), sessionId: text.slice(index + 1) }
}

export function fileSizeOf(path, statSync) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
