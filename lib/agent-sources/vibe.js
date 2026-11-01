// lib/agent-sources/vibe.js — Mistral Vibe 的会话目录
//
// 一个会话 = 一个目录：messages.jsonl（逐行一条消息）+ meta.json（标题 / cwd）。
// 目录在 ~/.vibe/logs/session/ 下（可用 VIBE_HOME 覆盖）。
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { blocksOf } from './blocks.js'
import { assembleTurns } from './turns.js'
import { statOrNull, listDirSafe } from '../util.js'

export function vibeSessionRoots(home = homedir()) {
  const override = process.env.VIBE_HOME
  if (override) return [join(override, 'logs', 'session')]
  return [join(home, '.vibe', 'logs', 'session')]
}

async function readMeta(dir) {
  const file = join(dir, 'meta.json')
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function countLines(file) {
  try {
    const text = await readFile(file, 'utf8')
    return text.split('\n').filter((line) => line.trim()).length
  } catch {
    return 0
  }
}

/** 扫描所有会话目录（含 messages.jsonl 的目录即会话，不再下钻）。 */
export async function listVibeSessions(limit = 40) {
  const out = []
  for (const root of vibeSessionRoots()) {
    const info = await statOrNull(root)
    if (!info || !info.isDirectory()) continue
    for (const entry of await listDirSafe(root)) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const messagesPath = join(dir, 'messages.jsonl')
      const messagesInfo = await statOrNull(messagesPath)
      if (!messagesInfo || !messagesInfo.isFile()) continue
      const meta = await readMeta(dir)
      out.push({
        id: entry.name,
        title: (typeof meta.title === 'string' && meta.title)
          || (typeof meta.name === 'string' && meta.name)
          || entry.name,
        cwd: typeof meta.cwd === 'string' ? meta.cwd : (typeof meta.working_dir === 'string' ? meta.working_dir : ''),
        updatedAt: (await statOrNull(dir))?.mtimeMs,
        messages: await countLines(messagesPath),
        path: messagesPath,
      })
    }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return out.slice(0, limit)
}

/** 读一个 vibe 会话（messages.jsonl）→ interchange 文档。 */
export async function readVibeSession(messagesPath) {
  const info = await statOrNull(messagesPath)
  if (!info || !info.isFile()) throw new Error('找不到会话文件：' + messagesPath)
  const text = await readFile(messagesPath, 'utf8')
  const dir = messagesPath.replace(/[/\\][^/\\]*$/, '')
  const meta = await readMeta(dir)
  const flow = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!row || typeof row !== 'object') continue
    const role = String(row.role || '')
    if (role !== 'user' && role !== 'assistant') continue
    const blocks = blocksOf(row.content ?? row.message ?? row.text)
    if (blocks.length === 0) continue
    flow.push({ role, blocks, time: Number.isFinite(row.timestamp) ? row.timestamp : undefined })
  }
  const turns = assembleTurns(flow)
  if (turns.length === 0) throw new Error('这个会话里没有可导入的对话内容')
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : (typeof meta.working_dir === 'string' ? meta.working_dir : '')
  const title = (typeof meta.title === 'string' && meta.title)
    || (typeof meta.name === 'string' && meta.name)
    || firstPrompt(turns)
    || basename(dir)
  return {
    ok: true,
    doc: {
      interchange: 'dsh-chat-import',
      version: 1,
      title,
      provider: 'mistral',
      model: '',
      meta: cwd ? { cwd } : {},
      turns,
    },
    cwd,
    sourceId: basename(dir),
    title,
  }
}

function firstPrompt(turns) {
  const turn = turns.find((item) => item.prompt.trim())
  return turn ? turn.prompt.replace(/\s+/g, ' ').slice(0, 100) : ''
}
