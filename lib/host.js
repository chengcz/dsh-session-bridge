// lib/host.js — 宿主会话 ABI 适配：列会话、读事件、建会话、标题与默认模型
//
// 只认宿主公开的服务面（sessionPersistence / agents / agentDefaultModel / agentPresets /
// sessionProjections 的持久缓存文件），不 import 任何 DSH 包，也不写宿主私有结构。
// 新旧两套 sessionPersistence 形状在这里收敛一次：
//   句柄式：open(id,'read') → handle.read(from, length) → { events }；create(header) 返回写句柄
//   直写式：readFrom(id, from) → { events }；create(header) 无返回值，append(id, events)
import { join } from 'node:path'
import { readJsonIfExists } from './util.js'
import { dshHome } from './util.js'

/** list() 元素 → header（新旧形状都认）。 */
function headerOf(entry) {
  if (!entry || typeof entry !== 'object') return undefined
  return entry.header && typeof entry.header === 'object' ? entry.header : entry
}

export async function listSessions(ctx) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function') return []
  try {
    const entries = await sp.list()
    return (Array.isArray(entries) ? entries : [])
      .map((entry) => {
        const header = headerOf(entry)
        if (!header || typeof header.id !== 'string') return null
        return {
          header,
          sizeBytes: entry && Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : undefined,
          revision: entry && entry.revision !== undefined ? entry.revision : undefined,
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function persistedIds(entries) {
  const ids = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry && entry.header && typeof entry.header.id === 'string') ids.add(entry.header.id)
  }
  return ids
}

/** 宿主当前写入的会话格式代次：优先存量 header 的最大 version（空库回退 4）。 */
export function hostFormatVersion(entries) {
  let version
  for (const entry of Array.isArray(entries) ? entries : []) {
    const v = entry && entry.header && entry.header.version
    if (Number.isSafeInteger(v) && v >= 0 && (version === undefined || v > version)) version = v
  }
  return version === undefined ? 4 : version
}

/**
 * 让当前会话的缓冲事件先落盘（只对「活着的会话」有意义）。
 * 导出正在进行的会话时，最后几条事件可能还在内存里——不 flush 会导出一份偏短的备份。
 */
export async function flushSession(ctx, id) {
  try {
    const store = ctx.get('sessions')
    const session = store && typeof store.get === 'function' ? store.get(id) : undefined
    if (session && store && typeof store.flush === 'function') await store.flush(session)
    return true
  } catch (error) {
    console.error('[dsh-session-bridge] flush 会话失败（' + id + '）: ' + String((error && error.message) || error))
    return false
  }
}

/** 读会话（header + 全部事件）；读不到返回 null。 */
export async function readSession(ctx, id) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof id !== 'string' || !id) return null
  if (typeof sp.readFrom === 'function') {
    try {
      const out = await sp.readFrom(id, 0)
      if (out && Array.isArray(out.events)) return { header: out.meta || { id }, events: out.events }
    } catch {
      // 落到句柄式
    }
  }
  if (typeof sp.open !== 'function') return null
  let handle
  try {
    handle = await sp.open(id, 'read')
    const out = await handle.read(0, Number.MAX_SAFE_INTEGER)
    if (!out || !Array.isArray(out.events)) return null
    return { header: handle.header || { id }, events: out.events }
  } catch {
    return null
  } finally {
    if (handle && typeof handle.close === 'function') {
      try {
        await handle.close()
      } catch {
        // 读句柄释放失败不影响已读到的事件
      }
    }
  }
}

/** 默认模型 → agents.create 的 agentOptions（探测不到返回 undefined，不阻塞导入）。 */
export async function defaultAgentOptions(ctx) {
  try {
    const service = ctx.get('agentDefaultModel')
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
      && selection.provider && selection.model) {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(Number.isSafeInteger(selection.maxTokens) && selection.maxTokens > 0 ? { maxTokens: selection.maxTokens } : {}),
      }
    }
  } catch {
    // 无默认模型配置：让宿主按自己的回落链选
  }
  return undefined
}

async function defaultPresetId(ctx) {
  try {
    const presets = ctx.get('agentPresets')
    if (!presets || typeof presets.resolve !== 'function') return undefined
    const preset = await presets.resolve()
    return preset && typeof preset.id === 'string' && preset.id ? preset.id : undefined
  } catch {
    return undefined
  }
}

async function mountPreset(ctx, agentCtx, presetId) {
  try {
    const presets = ctx.get('agentPresets')
    if (presets && typeof presets.mount === 'function') await presets.mount(agentCtx, presetId)
  } catch (error) {
    console.error('[dsh-session-bridge] 挂载默认 preset 失败: ' + String((error && error.message) || error))
  }
}

/** 宿主拒绝「会话 id 已被占用」的错误判定。 */
export function isSessionTakenError(error) {
  const name = String((error && error.name) || '')
  if (name === 'SessionAlreadyExistsError' || name === 'SessionAlreadyOwnedError') return true
  return /already exists|duplicate session|already owned by an active write handle/i.test(String((error && error.message) || error))
}

/**
 * 写一个新会话：优先 agents.create（会 enter + announce，侧栏立刻可见；同时挂默认 preset
 * 与默认模型），失败则回退 sessionPersistence 直写（headless / 无 agents 服务的组合）。
 */
export async function createSession(ctx, header, events) {
  const agents = ctx.get('agents')
  if (agents && typeof agents.create === 'function') {
    const presetId = await defaultPresetId(ctx)
    const agentOptions = await defaultAgentOptions(ctx)
    try {
      await agents.create({
        sessionId: header.id,
        meta: { ...header, ...(presetId ? { agentPreset: presetId } : {}) },
        seed: events,
        ...(agentOptions ? { agentOptions } : {}),
        setup: (agentCtx) => mountPreset(ctx, agentCtx, presetId),
      })
      return { via: 'agents' }
    } catch (error) {
      if (isSessionTakenError(error)) throw error
      console.error('[dsh-session-bridge] agents.create 失败，回退 sessionPersistence: ' + String((error && error.message) || error))
      try {
        await writeViaPersistence(ctx, header, events)
        return { via: 'sessionPersistence', fallbackReason: String((error && error.message) || error) }
      } catch (fallbackError) {
        if (isSessionTakenError(fallbackError)) throw fallbackError
        throw new Error('agents.create 失败（' + String((error && error.message) || error)
          + '），sessionPersistence 回退也失败（' + String((fallbackError && fallbackError.message) || fallbackError) + '）')
      }
    }
  }
  await writeViaPersistence(ctx, header, events)
  return { via: 'sessionPersistence' }
}

async function writeViaPersistence(ctx, header, events) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.create !== 'function') throw new Error('sessionPersistence 不可用（缺少 create）')
  const handle = await sp.create(header)
  if (handle && typeof handle.append === 'function') {
    try {
      await handle.append(events)
      if (typeof handle.flush === 'function') await handle.flush()
    } finally {
      if (typeof handle.close === 'function') {
        try {
          await handle.close()
        } catch (error) {
          console.error('[dsh-session-bridge] 会话写句柄关闭失败（' + header.id + '）: ' + String((error && error.message) || error))
        }
      }
    }
    return
  }
  if (typeof sp.append === 'function') {
    await sp.append(header.id, events)
    return
  }
  throw new Error('sessionPersistence 写入面不可用（create 未返回写句柄，也没有 append(id, events)）')
}

/** 会话标题：读宿主的持久投影缓存（与侧栏显示同一个标题）；读不到返回 ''。 */
export async function sessionTitle(id) {
  if (typeof id !== 'string' || !id) return ''
  const file = join(dshHome(), 'storages', 'session_projcache', 'sessions', id + '.json')
  const doc = await readJsonIfExists(file)
  const rows = doc && doc.record && doc.record.rows
  if (!rows) return ''
  const title = rows.title && typeof rows.title.val === 'string' ? rows.title.val : ''
  if (title) return title
  const input = rows.titleInput && rows.titleInput.val
  const first = input && input.first && typeof input.first.text === 'string' ? input.first.text : ''
  return first.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** 批量取标题（列表页一次取完，避免每行一次 IO）。 */
export async function sessionTitles(ids) {
  const map = new Map()
  const list = Array.isArray(ids) ? ids : []
  const CONCURRENCY = 16
  let index = 0
  async function worker() {
    while (index < list.length) {
      const id = list[index++]
      map.set(id, await sessionTitle(id))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker))
  return map
}
