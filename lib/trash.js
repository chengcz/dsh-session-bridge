// lib/trash.js — 会话软删除 / 恢复 / 清理
//
// DSH 的会话是 `$DSH_HOME/sessions/<cwd slug>/<sessionId>/…` 加一份投影缓存
// `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`。这里不硬删任何东西：
// 把会话目录与投影缓存一起 move 进 `$DSH_HOME/dsh-session-bridge/trash/<stamp>/`，
// 写一份 manifest 记录原路径，随时可以原样移回。
//
// 之所以不直接 unlink：删会话是不可逆操作，而「重复导入」恰恰是这个插件最常遇到的场景，
// 用户点错的代价太高。回收站还顺带解决了「删了才发现要导出」的问题。
import { mkdir, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { bridgeHome, dshHome, formatBytes, joinPath, listDirSafe, readJsonIfExists, statOrNull, writeFileAtomic } from './util.js'

const ID_RE = /^[A-Za-z0-9._-]{1,160}$/
const DEFAULT_TRASH_DAYS = 7

function assertId(id) {
  const value = String(id || '')
  if (!ID_RE.test(value)) throw new Error('会话 id 不合法：' + value)
  return value
}

function trashRoot() {
  return joinPath(bridgeHome(), 'trash')
}

/** 在 sessions 目录里定位一个会话的全部落盘位置（目录式 / 单文件式都认）。 */
export async function locateSession(id) {
  const sessionId = assertId(id)
  const root = join(dshHome(), 'sessions')
  const items = []
  for (const group of await listDirSafe(root)) {
    if (!group.isDirectory()) continue
    const base = join(root, group.name)
    for (const entry of await listDirSafe(base)) {
      if (entry.name === sessionId && entry.isDirectory()) {
        items.push({ from: join(base, entry.name), kind: 'session-dir' })
      } else if (entry.isFile() && entry.name.startsWith(sessionId + '.')) {
        items.push({ from: join(base, entry.name), kind: 'session-file' })
      }
    }
  }
  const cache = join(dshHome(), 'storages', 'session_projcache', 'sessions', sessionId + '.json')
  if (await statOrNull(cache)) items.push({ from: cache, kind: 'projection' })
  return items
}

async function mtimeOf(path) {
  const info = await statOrNull(path)
  if (!info) return 0
  if (info.isFile()) return info.mtimeMs
  let newest = info.mtimeMs
  for (const entry of await listDirSafe(path)) {
    const child = join(path, entry.name)
    const childInfo = await statOrNull(child)
    if (childInfo && childInfo.mtimeMs > newest) newest = childInfo.mtimeMs
  }
  return newest
}

/** 会话是否正被宿主打开（活动会话不宜搬走）。 */
function isLive(ctx, id) {
  try {
    const store = ctx.get('sessions')
    if (!store || typeof store.get !== 'function') return false
    return !!store.get(id)
  } catch {
    return false
  }
}

/**
 * 把会话移入回收站。
 * @param {{ctx: object}} deps ctx 用于探测活动会话
 * @param {string[]} ids
 */
export async function trashSessions(deps, ids) {
  const ctx = deps && deps.ctx
  const moved = []
  const skipped = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bucket = join(trashRoot(), stamp)
  for (const rawId of Array.isArray(ids) ? ids : []) {
    let id
    try {
      id = assertId(rawId)
    } catch (error) {
      skipped.push({ sessionId: String(rawId), reason: String((error && error.message) || error) })
      continue
    }
    if (ctx && isLive(ctx, id)) {
      skipped.push({ sessionId: id, reason: '会话正在使用中，请先在侧栏关闭它' })
      continue
    }
    const items = await locateSession(id)
    if (items.length === 0) {
      skipped.push({ sessionId: id, reason: '找不到会话文件（可能已被删除）' })
      continue
    }
    let totalBytes = 0
    for (const item of items) {
      const info = await statOrNull(item.from)
      if (!info) continue
      totalBytes += info.isFile() ? info.size : await dirSize(item.from)
    }
    const entry = { sessionId: id, movedAt: Date.now(), items: [], bytes: totalBytes }
    let index = 0
    for (const item of items) {
      const target = join(bucket, id + '--' + index++)
      try {
        await mkdir(bucket, { recursive: true })
        await rename(item.from, target)
        entry.items.push({ kind: item.kind, from: item.from, to: target })
      } catch (error) {
        entry.items.push({ kind: item.kind, from: item.from, error: String((error && error.message) || error) })
      }
    }
    entry.size = formatBytes(totalBytes)
    moved.push(entry)
  }
  if (moved.length > 0) {
    await mkdir(bucket, { recursive: true })
    await writeFileAtomic(join(bucket, 'manifest.json'), JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      sessions: moved,
    }, null, 2) + '\n')
  }
  return { ok: true, trashed: moved.length, skipped, bucket: moved.length > 0 ? bucket : '' }
}

/** 列出回收站（按批次倒序）。 */
export async function listTrash() {
  const root = trashRoot()
  const batches = []
  for (const entry of await listDirSafe(root)) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const doc = await readJsonIfExists(join(dir, 'manifest.json'))
    const sessions = doc && Array.isArray(doc.sessions) ? doc.sessions : []
    const files = (await listDirSafe(dir)).filter((item) => item.isFile() && item.name !== 'manifest.json').length
    batches.push({
      id: entry.name,
      dir,
      createdAt: doc && Number.isSafeInteger(doc.createdAt) ? doc.createdAt : 0,
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        movedAt: session.movedAt,
        size: session.size || '',
        items: Array.isArray(session.items) ? session.items.length : 0,
      })),
      extraFiles: files,
    })
  }
  batches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return { ok: true, dir: root, batches }
}

/** 把一个批次（或其中的部分会话）移回原位。 */
export async function restoreTrash(batchId, sessionIds) {
  const batch = String(batchId || '')
  if (!ID_RE.test(batch)) throw new Error('批次 id 不合法：' + batch)
  const dir = join(trashRoot(), batch)
  const doc = await readJsonIfExists(join(dir, 'manifest.json'))
  if (!doc || !Array.isArray(doc.sessions)) throw new Error('回收站批次不存在或缺少 manifest：' + batch)
  const wanted = Array.isArray(sessionIds) && sessionIds.length > 0 ? new Set(sessionIds) : null
  const restored = []
  const rest = []
  for (const session of doc.sessions) {
    if (wanted && !wanted.has(session.sessionId)) {
      rest.push(session)
      continue
    }
    let ok = true
    for (const item of Array.isArray(session.items) ? session.items : []) {
      if (!item || item.error) continue
      try {
        await mkdir(dirname(item.from), { recursive: true })
        await rename(item.to, item.from)
      } catch (error) {
        ok = false
        item.error = String((error && error.message) || error)
      }
    }
    if (ok) restored.push(session.sessionId)
    else rest.push(session)
  }
  if (rest.length > 0) {
    await writeFileAtomic(join(dir, 'manifest.json'), JSON.stringify({ ...doc, sessions: rest }, null, 2) + '\n')
  } else {
    await rm(dir, { recursive: true, force: true })
  }
  return { ok: true, restored, remaining: rest.length, batch: rest.length > 0 ? batch : '' }
}

/** 清空回收站（不可恢复）。 */
export async function emptyTrash(options = {}) {
  const days = Number.isSafeInteger(options.days) && options.days > 0 ? options.days : 0
  const root = trashRoot()
  const cutoff = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : Number.POSITIVE_INFINITY
  let removed = 0
  let bytes = 0
  for (const entry of await listDirSafe(root)) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const newest = await mtimeOf(dir)
    if (newest > cutoff) continue
    const size = await dirSize(dir)
    await rm(dir, { recursive: true, force: true })
    removed += 1
    bytes += size
  }
  return { ok: true, removed, freed: formatBytes(bytes), days: days || null }
}

async function dirSize(dir) {
  let total = 0
  for (const entry of await listDirSafe(dir)) {
    const info = await statOrNull(join(dir, entry.name))
    if (!info) continue
    total += info.isFile() ? info.size : await dirSize(join(dir, entry.name))
  }
  return total
}

/** 清理本插件的暂存上传件（导入后原文件默认保留，这里手动清）。 */
export async function cleanUploads(options = {}) {
  const dir = joinPath(bridgeHome(), 'uploads')
  const keepMs = Number.isSafeInteger(options.keepMs) && options.keepMs > 0 ? options.keepMs : 0
  const cutoff = keepMs > 0 ? Date.now() - keepMs : Number.POSITIVE_INFINITY
  let removed = 0
  let bytes = 0
  for (const entry of await listDirSafe(dir)) {
    if (!entry.isFile()) continue
    const path = join(dir, entry.name)
    const info = await statOrNull(path)
    if (!info || info.mtimeMs > cutoff) continue
    try {
      await unlink(path)
      removed += 1
      bytes += info.size
    } catch {
      // 单个文件删不掉不影响其余
    }
  }
  return { ok: true, dir, removed, freed: formatBytes(bytes) }
}
