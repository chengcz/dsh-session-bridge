// lib/session-move.js — 把已导入的会话挪到另一个 project（workspace）
//
// 宿主没有「移动会话」的接口，归属是由会话自己决定的，一共三处要保持一致：
//   1. 分组目录：$DSH_HOME/sessions/<cwd 的 slug>/<sessionId>/
//   2. 会话文件首行 header 的 cwd
//   3. 投影缓存 $DSH_HOME/storages/session_projcache/sessions/<id>.json 的 workingDirectory
//
// 做法是「先整目录搬过去，再改文件里的 cwd」——搬目录是可回滚的一步（失败就搬回来），
// 改 header 只碰一个文件。会话事件本体一个字节都不重排，压缩的仍按原编码压缩写回。
import { readFile } from 'node:fs/promises'
import { mkdir, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  dshHome, joinPath, listDirSafe, readJsonIfExists, statOrNull, writeFileAtomic,
} from './util.js'
import { locateSession } from './trash.js'

const ID_RE = /^[A-Za-z0-9._-]{1,160}$/
const SESSION_FILE_RE = /^session\.v\d+\.jsonl(\.zstd)?$/i
// 列 project 只需要读 header：超过这个体积的会话不为拿 cwd 去解压整个文件
const MAX_HEADER_BYTES = 8 * 1024 * 1024

/** cwd → 会话分组目录名（宿主的口径：`/a/b` → `--a-b--`）。 */
export function slugForCwd(cwd) {
  const value = String(cwd || '')
  if (!value) return ''
  return '-' + value.replace(/[\\/]+/g, '-').replace(/^-+/, '') + '-'
}

function liveSessionOf(ctx, id) {
  try {
    const store = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
    if (!store || typeof store.get !== 'function') return null
    return store.get(id) || null
  } catch {
    return null
  }
}

/** 持久化的按 id 串行化（没有就返回 null，调用方据此判断能否移动运行中会话）。 */
function serializeFor(ctx, id) {
  try {
    const sp = ctx && typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null
    const coordinator = sp && sp.coordinator
    if (coordinator && typeof coordinator.serialize === 'function') {
      return (operation) => coordinator.serialize(id, operation)
    }
  } catch {
    // 没有协调器
  }
  return null
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 会话文件是「多帧 zstd 顺序拼接」：每追加一批事件就是一帧。
 * zstdDecompressSync 只解第一帧（正好是 header），所以必须逐帧解压再拼起来——
 * 否则改写 header 时会把后面的所有事件写丢。
 */
function decompressSession(raw) {
  const offsets = []
  let index = 0
  while ((index = raw.indexOf(ZSTD_MAGIC, index)) !== -1) {
    offsets.push(index)
    index += 4
  }
  if (offsets.length <= 1) return zstdDecompressSync(raw).toString('utf8')
  let text = ''
  for (let k = 0; k < offsets.length; k += 1) {
    const from = offsets[k]
    const to = k + 1 < offsets.length ? offsets[k + 1] : raw.length
    text += zstdDecompressSync(raw.subarray(from, to)).toString('utf8')
  }
  return text
}

async function readHeader(file) {
  const raw = await readFile(file)
  const compressed = /\.zstd$/i.test(file)
  const text = compressed ? decompressSession(raw) : raw.toString('utf8')
  const newline = text.indexOf('\n')
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  let header
  try {
    header = JSON.parse(firstLine)
  } catch {
    throw new Error('会话文件首行不是合法 JSON，拒绝改动：' + file)
  }
  return { header, compressed, text }
}

async function rewriteHeader(file, header, info) {
  const newline = info.text.indexOf('\n')
  const rest = newline === -1 ? '' : info.text.slice(newline)
  const next = JSON.stringify(header) + rest
  // 全量重压成一帧：不做帧边界假设（帧可能切在行中间），也不丢任何一帧
  const bytes = info.compressed ? zstdCompressSync(Buffer.from(next, 'utf8')) : Buffer.from(next, 'utf8')
  await writeFileAtomic(file, bytes)
}

/** 投影缓存里的 workingDirectory 跟着改，避免侧栏还按旧 project 显示。 */
async function syncProjection(sessionId, cwd) {
  const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', sessionId + '.json')
  const doc = await readJsonIfExists(file)
  const rows = doc && doc.record && doc.record.rows
  const row = rows && rows.workingDirectory
  if (!row || typeof row !== 'object') return false
  row.val = cwd
  if (Number.isSafeInteger(row.seq)) row.seq += 1
  try {
    await writeFileAtomic(file, JSON.stringify(doc))
    return true
  } catch {
    return false
  }
}

/**
 * 把会话移动到目标 project。
 * @param {{ctx: object}} deps ctx 用来判断会话是否正在使用
 * @param {string} sessionId
 * @param {string} cwd 目标绝对路径
 */
export async function moveSessionToProject(deps, sessionId, cwd) {
  const id = String(sessionId || '')
  if (!ID_RE.test(id)) throw new Error('会话 id 不合法：' + id)
  const targetCwd = String(cwd || '').trim()
  if (!targetCwd) throw new Error('缺少目标路径')
  if (!isAbsolute(targetCwd)) throw new Error('目标路径必须是绝对路径：' + targetCwd)
  if (process.platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(targetCwd)) {
    throw new Error('Windows 下要写盘符，例如 C:\\work\\project')
  }
  const ctx = deps && deps.ctx
  const liveSession = liveSessionOf(ctx, id)
  const serialize = serializeFor(ctx, id)
  // 运行中的会话能否安全移动，取决于持久化后端有没有「按 id 串行化」的能力：
  // 没有这把锁就可能在 write-behind 追加时搬文件，两边都写坏（session-manager 同样这么判）。
  if (liveSession && !serialize) {
    throw new Error('当前运行时不支持安全迁移运行中的会话（缺少写锁），请先在侧栏关闭它再移动')
  }

  const items = await locateSession(id)
  // 可能有残留的同名空目录（删除中断、旧版本遗留）：只认真正装着会话文件的那个
  let oldDir = ''
  let fileName = ''
  for (const item of items) {
    if (item.kind !== 'session-dir') continue
    const candidates = (await listDirSafe(item.from)).filter((entry) => entry.isFile() && SESSION_FILE_RE.test(entry.name))
    if (candidates.length > 0) {
      oldDir = item.from
      fileName = candidates[0].name
      break
    }
  }
  if (!oldDir) throw new Error('找不到这个会话的会话文件（可能已被删除，或不是目录式存储）')
  const newSlug = slugForCwd(targetCwd)
  if (!newSlug) throw new Error('无法从目标路径推导分组目录')
  const newDir = join(dshHome(), 'sessions', newSlug, id)

  // 读旧 header：拿现状 cwd，并顺手确认这是这个会话的文件
  const oldFile = join(oldDir, fileName)
  const info = await readHeader(oldFile)
  const fromCwd = typeof info.header.cwd === 'string' ? info.header.cwd : ''
  if (info.header.id !== id) throw new Error('会话文件里的 id 与请求不符（' + info.header.id + '）')
  if (fromCwd === targetCwd && oldDir === newDir) {
    return { ok: true, status: 'unchanged', sessionId: id, cwd: targetCwd, from: fromCwd, projectionUpdated: false }
  }

  if (oldDir === newDir) {
    // 路径没变（同一分组）：只改 header 与投影缓存
    info.header.cwd = targetCwd
    await rewriteHeader(oldFile, info.header, info)
    const projectionUpdated = await syncProjection(id, targetCwd)
    return { ok: true, status: 'moved', sessionId: id, cwd: targetCwd, from: fromCwd, to: newDir, projectionUpdated }
  }

  const targetExists = await statOrNull(newDir)
  if (targetExists) throw new Error('目标位置已经有同名会话：' + newDir)

  // 先把内存里的事件刷到盘上（此时还在旧 cwd），再在写锁内搬文件
  if (liveSession) {
    try {
      const store = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
      if (store && typeof store.flush === 'function') await store.flush(liveSession)
    } catch {
      // flush 失败不阻塞：文件里已有的内容仍然完整
    }
  }

  const doMove = async () => {
    await mkdir(dirname(newDir), { recursive: true })
    let moved = false
    try {
    await rename(oldDir, newDir)
    moved = true
    const newFile = join(newDir, fileName)
    info.header.cwd = targetCwd
    await rewriteHeader(newFile, info.header, info)
    // 读回校验：header 的 cwd 必须已经是目标路径
      const check = await readHeader(newFile)
      if (check.header.cwd !== targetCwd) throw new Error('写回校验失败：header.cwd 不是目标路径')
    } catch (error) {
      if (moved) {
        try {
          await rename(newDir, oldDir)
        } catch (rollbackError) {
          throw new Error('移动失败（' + String((error && error.message) || error)
            + '），回滚也失败，会话现在在：' + newDir + '（' + String((rollbackError && rollbackError.message) || rollbackError) + '）')
        }
      }
      throw error
    }
  }

  if (serialize) await serialize(doMove)
  else await doMove()

  // 运行中的会话保持活着（不销毁、不重启），只把内存里的 header 指到新 cwd，
  // 与磁盘保持一致；宿主的聊天面板不用重新初始化。
  if (liveSession && liveSession.header && typeof liveSession.header === 'object') {
    liveSession.header.cwd = targetCwd
  }

  const projectionUpdated = await syncProjection(id, targetCwd)
  return {
    ok: true,
    status: 'moved',
    sessionId: id,
    cwd: targetCwd,
    from: fromCwd,
    fromDir: oldDir,
    toDir: newDir,
    projectionUpdated,
  }
}

/** 列出当前所有 project（会话分组目录对应的 cwd），给「移动目标」做候选。 */
export async function listProjects(deps = {}) {
  const disk = await scanDiskProjects()
  const registry = registryOf(deps && deps.ctx)
  if (!registry) return disk
  try {
    const rows = registry.list()
    if (!Array.isArray(rows) || rows.length === 0) return disk
    const byPath = new Map(disk.map((project) => [project.cwd, project]))
    const merged = []
    for (const row of rows) {
      const cwd = row && typeof row.path === 'string' ? row.path : ''
      if (!cwd) continue
      const hit = byPath.get(cwd)
      merged.push({
        cwd,
        id: typeof row.id === 'string' ? row.id : '',
        name: typeof row.name === 'string' ? row.name : '',
        sessions: hit ? hit.sessions : 0,
        fromRegistry: true,
      })
    }
    // 注册表里没有、但磁盘上还有会话的分组也保留（例如工作区被移除但会话还在）
    for (const project of disk) {
      if (!merged.some((item) => item.cwd === project.cwd)) merged.push(project)
    }
    return merged.sort((a, b) => b.sessions - a.sessions)
  } catch {
    return disk
  }
}

/** 宿主的 workspace 注册表（可用时比从磁盘反推更准：含还没落会话的工作区）。 */
function registryOf(ctx) {
  try {
    const registry = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
    return registry && typeof registry.list === 'function' ? registry : null
  } catch {
    return null
  }
}

async function scanDiskProjects() {
  const root = joinPath(dshHome(), 'sessions')
  const groups = await listDirSafe(root)
  const projects = []
  const seen = new Set()
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const dir = join(root, group.name)
    const entries = await listDirSafe(dir)
    const sessionCount = entries.filter((entry) => entry.isDirectory()).length
    if (sessionCount === 0) continue
    // 从任一会话文件里读回真实 cwd（目录名是 slug，反推不可靠）
    let cwd = ''
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const files = (await listDirSafe(join(dir, entry.name))).filter((file) => file.isFile() && SESSION_FILE_RE.test(file.name))
      if (files.length === 0) continue
      const filePath = join(dir, entry.name, files[0].name)
      const fileInfo = await statOrNull(filePath)
      if (!fileInfo || fileInfo.size > MAX_HEADER_BYTES) continue
      try {
        const info = await readHeader(filePath)
        if (typeof info.header.cwd === 'string' && info.header.cwd) cwd = info.header.cwd
      } catch {
        // 坏文件跳过
      }
      if (cwd) break
    }
    const key = cwd || group.name
    if (seen.has(key)) continue
    seen.add(key)
    projects.push({ cwd: key, slug: group.name, sessions: sessionCount })
  }
  projects.sort((a, b) => b.sessions - a.sessions)
  return projects
}
