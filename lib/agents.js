// lib/agents.js — 其他 Coding Agent 的会话发现与解析（Claude Code / Codex）
//
// 这里只做「读别人的日志 → interchange v1 文档」，会话合成、判重、落盘全部复用 core
// 的导入管道：解析结果序列化成 interchange JSON 后，与用户手选的文件走同一条 importFile。
// 因此他源导入同样受内容指纹保护，同一段对话不会被导入两遍。
//
// 目录约定（只读，不写别人的目录）：
//   Claude Code  ~/.claude/projects/<项目 slug>/<sessionId>.jsonl
//   Codex        ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { open, readFile } from 'node:fs/promises'
import {
  bridgeHome, formatBytes, joinPath, listDirSafe, readJsonIfExists, statOrNull, writeFileAtomic,
} from './util.js'
import { closeDb, decodeRef, openDb, tableNames } from './agent-sources/sqlite.js'
import { isOpenCodeFamily, listFamilySessions, readFamilySession } from './agent-sources/opencode-family.js'
import { gooseDbPath, isGooseDb, listGooseSessions, readGooseSession } from './agent-sources/goose.js'
import { listZedThreads, readZedThread, zedThreadsDbPath } from './agent-sources/zed.js'
import { listVibeSessions, readVibeSession } from './agent-sources/vibe.js'

const MAX_SCAN_BYTES = 48 * 1024 * 1024
// 列目录只需要标题与项目：读整个文件会把 200 个会话的上百 MB 全读进内存（首次扫描几十秒）
const HEAD_BYTES = 256 * 1024
const DEFAULT_LIMIT = 40
const CACHE_VERSION = 2
const CACHE_FILE = () => joinPath(bridgeHome(), 'agents-cache.json')

/** 支持的来源清单；`root` 延迟求值，便于测试时覆盖 HOME。 */
export function agentSources() {
  const home = homedir()
  return [
    {
      type: 'files',
      kind: 'claude-code',
      label: 'Claude Code',
      root: join(home, '.claude', 'projects'),
      hint: '~/.claude/projects',
    },
    {
      type: 'files',
      kind: 'codex',
      label: 'Codex',
      root: join(home, '.codex', 'sessions'),
      hint: '~/.codex/sessions',
    },
    {
      // zcode / opencode / mimocode / kilocode 是同一套库结构（session/message/part）
      type: 'sqlite',
      kind: 'zcode',
      label: 'zcode',
      dbPath: join(home, '.zcode', 'cli', 'db', 'db.sqlite'),
      hint: '~/.zcode/cli/db/db.sqlite',
      detect: isOpenCodeFamily,
      list: listFamilySessions,
      read: readFamilySession,
    },
    {
      type: 'sqlite',
      kind: 'opencode',
      label: 'opencode',
      dbPath: join(home, '.local', 'share', 'opencode', 'opencode.db'),
      hint: '~/.local/share/opencode/opencode.db',
      detect: isOpenCodeFamily,
      list: listFamilySessions,
      read: readFamilySession,
    },
    {
      type: 'sqlite',
      kind: 'mimocode',
      label: 'mimocode',
      dbPath: join(home, '.local', 'share', 'mimocode', 'mimocode.db'),
      hint: '~/.local/share/mimocode/mimocode.db',
      detect: isOpenCodeFamily,
      list: listFamilySessions,
      read: readFamilySession,
    },
    {
      type: 'sqlite',
      kind: 'kilocode',
      label: 'kilocode',
      dbPath: join(home, '.local', 'share', 'kilo', 'kilo.db'),
      hint: '~/.local/share/kilo/kilo.db',
      detect: isOpenCodeFamily,
      list: listFamilySessions,
      read: readFamilySession,
    },
    {
      type: 'sqlite',
      kind: 'goose',
      label: 'Goose',
      dbPath: gooseDbPath(home),
      hint: '~/Library/Application Support/Block/goose/sessions/sessions.db',
      detect: isGooseDb,
      list: listGooseSessions,
      read: readGooseSession,
    },
    {
      type: 'sqlite',
      kind: 'zed',
      label: 'Zed',
      dbPath: zedThreadsDbPath(home),
      hint: '~/Library/Application Support/Zed/threads/threads.db',
      detect: null,
      list: listZedThreads,
      read: readZedThread,
    },
    {
      type: 'dir',
      kind: 'vibe',
      label: 'Mistral Vibe',
      root: join(home, '.vibe', 'logs', 'session'),
      hint: '~/.vibe/logs/session',
    },
  ]
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

async function walkFiles(root, maxDepth, out, depth = 0) {
  const entries = await listDirSafe(root)
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (depth < maxDepth) await walkFiles(join(root, entry.name), maxDepth, out, depth + 1)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(join(root, entry.name))
  }
  return out
}

/** 只读文件开头一段：头部足以拿到 id / 标题 / cwd，不必把整个会话读进来。 */
async function readFileHead(path, bytes) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

function cacheKey(info) {
  return String(info.size) + ':' + String(info.mtimeMs)
}

async function readCache() {
  const doc = await readJsonIfExists(CACHE_FILE())
  if (!doc || typeof doc !== 'object' || doc.version !== CACHE_VERSION) return { entries: {} }
  return doc.entries && typeof doc.entries === 'object' ? doc : { entries: {} }
}

async function summarize(kind, path, info, cache) {
  const key = path + '|' + cacheKey(info)
  const hit = cache.entries[key]
  if (hit) return { ...hit, path }
  if (info.size > MAX_SCAN_BYTES) {
    return {
      path, id: basename(path, '.jsonl'), title: basename(path, '.jsonl'), cwd: '',
      updatedAt: info.mtimeMs, bytes: info.size, size: formatBytes(info.size), messages: 0,
      tooLarge: true,
    }
  }
  let summary
  try {
    const text = await readFileHead(path, HEAD_BYTES)
    summary = kind === 'claude-code' ? summarizeClaude(text) : summarizeCodex(text)
  } catch {
    summary = { id: basename(path, '.jsonl'), title: basename(path, '.jsonl'), cwd: '', messages: 0 }
  }
  const record = {
    id: summary.id || basename(path, '.jsonl'),
    title: summary.title || basename(path, '.jsonl'),
    cwd: summary.cwd || '',
    messages: summary.messages || 0,
    updatedAt: info.mtimeMs,
    bytes: info.size,
    size: formatBytes(info.size),
  }
  cache.entries[key] = record
  return { ...record, path }
}

/** 扫描所有来源的会话（只读列表，不导入）。 */
export async function listAgentSources(options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT
  const cache = await readCache()
  const sources = []
  for (const source of agentSources()) {
    if (source.type === 'file' || source.type === 'files') {
      const info = await statOrNull(source.root)
      if (!info || !info.isDirectory()) {
        sources.push(describe(source, false, [], 0, source.root))
        continue
      }
      const files = await walkFiles(source.root, 4, [])
      const stats = []
      for (const file of files) {
        const stat = await statOrNull(file)
        if (stat && stat.isFile()) stats.push([file, stat])
      }
      stats.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
      const sessions = []
      for (const [file, stat] of stats.slice(0, limit)) {
        sessions.push(await summarize(source.kind, file, stat, cache))
      }
      sources.push(describe(source, true, sessions, files.length, source.root))
      continue
    }

    if (source.type === 'sqlite') {
      const info = await statOrNull(source.dbPath)
      if (!info || !info.isFile()) {
        sources.push(describe(source, false, [], 0, source.dbPath))
        continue
      }
      let sessions = []
      let usable = true
      try {
        if (source.detect && !source.detect(source.dbPath)) usable = false
        if (usable) sessions = source.list(source.dbPath, limit)
      } catch (error) {
        sources.push(describe(source, false, [], 0, source.dbPath, String((error && error.message) || error)))
        continue
      }
      if (!usable) {
        sources.push(describe(source, false, [], 0, source.dbPath, '库结构不认识（可能版本不同）'))
        continue
      }
      sources.push(describe(source, true, sessions, sessions.length, source.dbPath))
      continue
    }

    if (source.type === 'dir') {
      const info = await statOrNull(source.root)
      if (!info || !info.isDirectory()) {
        sources.push(describe(source, false, [], 0, source.root))
        continue
      }
      let sessions = []
      try {
        sessions = await listVibeSessions(limit)
      } catch {
        sessions = []
      }
      sources.push(describe(source, sessions.length > 0, sessions, sessions.length, source.root))
    }
  }
  try {
    await writeFileAtomic(CACHE_FILE(), JSON.stringify({ version: CACHE_VERSION, entries: cache.entries }, null, 2) + '\n')
  } catch {
    // 缓存写不进去不影响扫描结果
  }
  return { ok: true, sources }
}

/** 来源 → 界面要的条目（统一字段，不把内部函数漏给前端）。 */
function describe(source, available, sessions, count, root, error) {
  return {
    kind: source.kind,
    label: source.label,
    hint: source.hint,
    type: source.type,
    root: root || '',
    available: Boolean(available),
    count: Number.isFinite(count) ? count : sessions.length,
    sessions,
    ...(error ? { error } : {}),
  }
}

// ── Claude Code ─────────────────────────────────────────────────────────────

function claudeText(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 明显是工具注入的「假用户消息」（AGENTS.md、本地命令提示等），不适合当标题。 */
function looksInjected(text) {
  const head = String(text || '').trimStart().slice(0, 200)
  if (head.startsWith('<') && head.slice(0, 80).includes('>')) return true
  return head.startsWith('# AGENTS.md')
    || head.startsWith('Caveat: The messages below')
    || head.startsWith('System:')
}

function summarizeClaude(text) {
  const lines = String(text).split(/\r?\n/)
  let id = ''
  let cwd = ''
  let title = ''
  let messages = 0
  for (const line of lines) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!id && typeof row.sessionId === 'string') id = row.sessionId
    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd
    if (row.type === 'user' && row.isSidechain !== true) {
      const content = row.message && row.message.content
      const blocks = Array.isArray(content) ? content : []
      if (blocks.some((block) => block && block.type === 'tool_result')) continue
      const said = claudeText(content).trim()
      if (!said) continue
      messages += 1
      if (!title && !looksInjected(said)) title = said.replace(/\s+/g, ' ').slice(0, 100)
    } else if (row.type === 'assistant') {
      messages += 1
    }
  }
  return { id, title, cwd, messages }
}

/** Claude Code 会话 → interchange 文档。 */
export function claudeToInterchange(text, fallbackId) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object') rows.push(row)
    } catch {
      // 坏行跳过
    }
  }
  const turns = []
  let current = null
  let cwd = ''
  let id = fallbackId || ''
  let lastCallId = ''

  const openTurn = (prompt, time) => {
    current = { prompt, time, steps: [] }
    turns.push(current)
  }

  for (const row of rows) {
    if (typeof row.cwd === 'string' && row.cwd && !cwd) cwd = row.cwd
    if (typeof row.sessionId === 'string' && row.sessionId && !id) id = row.sessionId
    if (row.isSidechain === true) continue
    const time = Date.parse(row.timestamp || '') || undefined
    const message = row.message
    if (!message || typeof message !== 'object') continue

    if (row.type === 'user') {
      const content = message.content
      const blocks = Array.isArray(content) ? content : []
      const results = blocks.filter((block) => block && block.type === 'tool_result')
      if (results.length > 0) {
        // 工具结果回到「上一次 assistant step」，不新开轮次
        const step = current && current.steps.length > 0 ? current.steps[current.steps.length - 1] : null
        if (step) {
          if (!Array.isArray(step.toolResults)) step.toolResults = []
          for (const block of results) {
            step.toolResults.push({
              toolCallId: typeof block.tool_use_id === 'string' ? block.tool_use_id : lastCallId,
              content: flattenResult(block.content),
              isError: block.is_error === true,
            })
          }
        }
        continue
      }
      const said = claudeText(content).trim()
      if (!said || looksInjected(said)) continue
      const promptBlocks = Array.isArray(content)
        ? content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => ({ type: 'text', text: block.text }))
        : [{ type: 'text', text: said }]
      openTurn(said, time)
      current.promptBlocks = promptBlocks
      continue
    }

    if (row.type === 'assistant') {
      if (!current) openTurn('', time)
      const blocks = Array.isArray(message.content) ? message.content : []
      const step = { content: [], toolCalls: [], toolResults: [], time }
      if (typeof message.model === 'string' && message.model) step.model = message.model
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          step.content.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          step.content.push({ type: 'reasoning', text: block.thinking })
        } else if (block.type === 'tool_use') {
          const callId = typeof block.id === 'string' && block.id ? block.id : 'claude-call-' + step.toolCalls.length
          lastCallId = callId
          step.toolCalls.push({
            id: callId,
            name: typeof block.name === 'string' && block.name ? block.name : 'unknown',
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
      if (step.content.length > 0 || step.toolCalls.length > 0) current.steps.push(step)
    }
  }

  const usable = turns.filter((turn) => turn.prompt.trim() || turn.steps.length > 0)
  if (usable.length === 0) return { ok: false, error: '这个会话里没有可导入的对话内容' }
  return {
    ok: true,
    doc: {
      interchange: 'dsh-chat-import',
      version: 1,
      title: (usable.find((turn) => turn.prompt.trim()) || usable[0]).prompt.replace(/\s+/g, ' ').slice(0, 100),
      provider: 'anthropic',
      model: '',
      meta: cwd ? { cwd } : {},
      turns: usable,
    },
    cwd,
    sourceId: id,
  }
}

function flattenResult(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        if (block.type === 'text') return block.text || ''
        if (block.type === 'image') return '[image]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

// ── Codex ───────────────────────────────────────────────────────────────────

function codexPayload(row) {
  return row && typeof row.payload === 'object' && row.payload ? row.payload : {}
}

function summarizeCodex(text) {
  const lines = String(text).split(/\r?\n/)
  let id = ''
  let cwd = ''
  let title = ''
  let messages = 0
  for (const line of lines) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const payload = codexPayload(row)
    if (row.type === 'session_meta') {
      id = typeof payload.id === 'string' ? payload.id : id
      cwd = typeof payload.cwd === 'string' ? payload.cwd : cwd
      continue
    }
    if (row.type === 'response_item' && payload.type === 'message') {
      const said = codexMessageText(payload).trim()
      if (!said) continue
      messages += 1
      if (payload.role === 'user' && !title && !looksInjected(said)) title = said.replace(/\s+/g, ' ').slice(0, 100)
    }
  }
  return { id, title, cwd, messages }
}

function codexMessageText(payload) {
  const content = Array.isArray(payload.content) ? payload.content : []
  return content
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Codex rollout 会话 → interchange 文档。 */
export function codexToInterchange(text, fallbackId) {
  const turns = []
  let current = null
  let cwd = ''
  let id = fallbackId || ''

  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const payload = codexPayload(row)
    const time = Date.parse(row.timestamp || '') || undefined
    if (row.type === 'session_meta') {
      cwd = typeof payload.cwd === 'string' ? payload.cwd : cwd
      id = typeof payload.id === 'string' ? payload.id : id
      continue
    }
    if (row.type !== 'response_item') continue

    if (payload.type === 'message') {
      const said = codexMessageText(payload).trim()
      if (!said || looksInjected(said)) continue
      if (payload.role === 'user') {
        current = { prompt: said, time, steps: [] }
        turns.push(current)
      } else if (payload.role === 'assistant') {
        if (!current) {
          current = { prompt: '', time, steps: [] }
          turns.push(current)
        }
        current.steps.push({ content: [{ type: 'text', text: said }], toolCalls: [], toolResults: [], time })
      }
      continue
    }
    if (!current) continue
    if (payload.type === 'reasoning') {
      const said = [payload.summary, payload.content]
        .flat()
        .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean)
        .join('\n')
      if (said) {
        const last = current.steps[current.steps.length - 1]
        if (last) last.content.push({ type: 'reasoning', text: said })
        else current.steps.push({ content: [{ type: 'reasoning', text: said }], toolCalls: [], toolResults: [], time })
      }
      continue
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'local_shell_call') {
      const callId = typeof payload.call_id === 'string' && payload.call_id
        ? payload.call_id
        : (typeof payload.id === 'string' ? payload.id : 'codex-call-' + turns.length)
      const name = typeof payload.name === 'string' && payload.name
        ? payload.name
        : (payload.type === 'local_shell_call' ? 'shell' : 'unknown')
      const rawArgs = payload.arguments ?? payload.input ?? payload.action ?? {}
      current.steps.push({
        content: [],
        toolCalls: [{
          id: callId,
          name,
          arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs),
        }],
        toolResults: [],
        time,
      })
      continue
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output' || payload.type === 'local_shell_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
      const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '')
      for (let index = current.steps.length - 1; index >= 0; index -= 1) {
        const step = current.steps[index]
        if ((step.toolCalls || []).some((call) => call.id === callId)) {
          step.toolResults.push({ toolCallId: callId, content: output })
          break
        }
      }
    }
  }

  const usable = turns.filter((turn) => turn.prompt.trim() || turn.steps.length > 0)
  if (usable.length === 0) return { ok: false, error: '这个会话里没有可导入的对话内容' }
  return {
    ok: true,
    doc: {
      interchange: 'dsh-chat-import',
      version: 1,
      title: (usable.find((turn) => turn.prompt.trim()) || usable[0]).prompt.replace(/\s+/g, ' ').slice(0, 100),
      provider: 'openai',
      model: '',
      meta: cwd ? { cwd } : {},
      turns: usable,
    },
    cwd,
    sourceId: id,
  }
}

/**
 * 读取一个他源会话文件并转成 interchange JSON 文本（可直接交给 core.importFile）。
 * @param {'claude-code'|'codex'} kind
 * @param {string} path
 */
export async function parseAgentSession(kind, path) {
  const source = agentSources().find((item) => item.kind === kind)
  if (!source) throw new Error('不支持的来源：' + kind)

  // 库型：path 是 `<dbPath>#<sessionId>`
  if (source.type === 'sqlite') {
    const { dbPath, sessionId } = decodeRef(path)
    if (!sessionId) throw new Error('缺少会话 id（期望 <dbPath>#<sessionId>，收到：' + path + '）')
    const info = await statOrNull(dbPath)
    if (!info || !info.isFile()) throw new Error('库文件不存在：' + dbPath)
    const parsed = source.read(dbPath, sessionId)
    return toParsed(kind, path, parsed, sessionId, dbPath)
  }

  // 目录型（vibe）：path 是 messages.jsonl
  if (kind === 'vibe') {
    const parsed = await readVibeSession(path)
    return toParsed(kind, path, parsed, parsed.sourceId, path)
  }

  // 文件型（Claude Code / Codex）
  const info = await statOrNull(path)
  if (!info || !info.isFile()) throw new Error('文件不存在：' + path)
  if (info.size > MAX_SCAN_BYTES) throw new Error('会话文件过大（' + formatBytes(info.size) + '），请先用对应工具导出')
  const text = await readFile(path, 'utf8')
  const fallbackId = basename(path, '.jsonl')
  const parsed = kind === 'claude-code' ? claudeToInterchange(text, fallbackId) : codexToInterchange(text, fallbackId)
  if (!parsed.ok) throw new Error(parsed.error)
  return {
    ok: true,
    kind,
    path,
    name: basename(path),
    cwd: parsed.cwd || '',
    sourceSessionId: parsed.sourceId || fallbackId,
    title: parsed.doc.title,
    turns: parsed.doc.turns.length,
    interchange: parsed.doc,
    text: JSON.stringify(parsed.doc, null, 2) + '\n',
  }
}

/** 各种读取器的统一产物：interchange 文档 + 导入要用的名字/来源 id。 */
function toParsed(kind, path, parsed, sessionId, locator) {
  if (!parsed || !parsed.ok) throw new Error((parsed && parsed.error) || '解析失败')
  const stem = String(sessionId || basename(String(locator || path)) || kind)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || kind
  return {
    ok: true,
    kind,
    path,
    name: stem + '.json',
    cwd: parsed.cwd || '',
    sourceSessionId: sessionId || '',
    title: parsed.title || parsed.doc.title || '',
    turns: parsed.doc.turns.length,
    interchange: parsed.doc,
    text: JSON.stringify(parsed.doc, null, 2) + '\n',
  }
}
