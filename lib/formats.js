// lib/formats.js — 落盘文件格式：便携 bundle、原生 JSONL、interchange v1、Markdown
//
// 导出（事件级无损）用 `.dshbundle.json`：一段 JSONL 日志 + 双层 sha256，能原样导入回 DSH，
// 也能读 dsh-chat-import 的同名便携包（`bundle: "dsh-chat-import"` + `log`）。
// 导入还接受 interchange v1 文档（`interchange: "dsh-chat-import"`）与未压缩的 DSH 会话日志。
// Markdown / JSONL 是给人看与给别的工具用的旁路导出，不参与导入。
import { basename } from 'node:path'
import { canonicalJson, sha256 } from './util.js'
import { readToolResult } from './fingerprint.js'
import { normalizeEnvelope, shapeEventsForHost, synthesizeSession } from './synthesize.js'

export const BUNDLE_KIND = 'dsh-session-bridge'
export const BUNDLE_FORMAT = 'dsh-session-v1'
export const BUNDLE_VERSION = 1

// ── JSONL 日志 ──────────────────────────────────────────────────────────────

/** header + 事件 → JSONL（首行 header，其余逐事件一行）。 */
export function eventsToJsonl(header, events) {
  const lines = [JSON.stringify(header)]
  for (const ev of events) lines.push(JSON.stringify(ev))
  return lines.join('\n') + '\n'
}

/** JSONL → { header, events }；坏行跳过并计数，不静默。 */
export function parseJsonl(text) {
  const lines = String(text || '').split(/\r?\n/)
  let header = null
  const events = []
  const skippedLines = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let value
    try {
      value = JSON.parse(trimmed)
    } catch {
      skippedLines.push({ line: events.length + 1, reason: 'json' })
      continue
    }
    if (!value || typeof value !== 'object') {
      skippedLines.push({ line: events.length + 1, reason: 'shape' })
      continue
    }
    if (header === null && typeof value.id === 'string' && !value.type) {
      header = value
      continue
    }
    if (typeof value.type === 'string' && value.data !== undefined) {
      events.push(value)
      continue
    }
    skippedLines.push({ line: events.length + 1, reason: 'unknown' })
  }
  return { header, events, skippedLines }
}

// ── 便携 bundle ─────────────────────────────────────────────────────────────

function bundleSeal(doc) {
  const { sha256: _ignored, ...rest } = doc
  return sha256(canonicalJson(rest))
}

/**
 * 导出便携包。log 是完整会话日志（事件级无损），sha256.log 校验 log，
 * sha256.bundle 校验除自身外的全部字段（损坏检测）。
 * @param {{header: object, events: object[], title?: string, exportedAt: number, fingerprint: string}} input
 */
export function buildBundle({ header, events, title, exportedAt, fingerprint }) {
  const log = eventsToJsonl(header, events)
  const doc = {
    bundle: BUNDLE_KIND,
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt,
    source: {
      sessionId: header && header.id,
      title: title || '',
      createdAt: header && header.createdAt,
      cwd: header && header.cwd,
      formatVersion: header && header.version,
      events: events.length,
    },
    fingerprint,
    log,
    sha256: { log: sha256(log) },
  }
  doc.sha256.bundle = bundleSeal(doc)
  return doc
}

function bundleIntegrity(doc) {
  const seals = doc && doc.sha256 && typeof doc.sha256 === 'object' ? doc.sha256 : {}
  // 本插件用 sha256.log，dsh-chat-import 用 sha256.session：同一个含义（日志的摘要）。
  const logHash = typeof seals.log === 'string' ? seals.log : (typeof seals.session === 'string' ? seals.session : null)
  if (logHash && typeof doc.log === 'string' && sha256(doc.log) !== logHash) {
    return '文件自校验失败：log 的 sha256 与记录不符（文件被截断或修改过）'
  }
  // 文件级摘要只对本插件自己的编码校验：别人的规范化 JSON 口径未知，误拒一份好备份
  // 比少做一次校验更糟；日志摘要已经能挡住截断与篡改。
  if (doc.bundle === BUNDLE_KIND && typeof seals.bundle === 'string' && bundleSeal(doc) !== seals.bundle) {
    return '文件自校验失败：bundle 的 sha256 与记录不符（文件被修改过）'
  }
  return null
}

/**
 * 解析便携包（本插件或 dsh-chat-import 的），返回 header/events/标题。
 * 校验失败一律给出可读原因，不返回半截数据。
 */
export function parseBundle(doc) {
  const integrity = bundleIntegrity(doc)
  if (integrity) return { ok: false, error: integrity }
  const log = typeof doc.log === 'string' ? doc.log : ''
  if (!log) return { ok: false, error: '便携包里没有 log 字段（不是有效的会话备份）' }
  const parsed = parseJsonl(log)
  if (!parsed.header || parsed.events.length === 0) {
    return { ok: false, error: '便携包的 log 里没有可识别的会话日志（header/事件缺失）' }
  }
  const title = (doc.source && typeof doc.source.title === 'string' && doc.source.title)
    || (typeof doc.title === 'string' ? doc.title : '')
  return {
    ok: true,
    kind: 'bundle',
    header: parsed.header,
    events: parsed.events,
    title,
    skippedLines: parsed.skippedLines,
  }
}

// ── interchange v1 ──────────────────────────────────────────────────────────

function normalizeInterchangeTurn(turn) {
  const steps = Array.isArray(turn && turn.steps) ? turn.steps : []
  return {
    prompt: typeof turn?.prompt === 'string' ? turn.prompt : '',
    promptBlocks: Array.isArray(turn?.promptBlocks) ? turn.promptBlocks : undefined,
    steps: steps.map((step) => ({
      content: Array.isArray(step?.content) ? step.content : [],
      toolCalls: Array.isArray(step?.toolCalls) ? step.toolCalls : [],
      // interchange 允许把结果块写在 content 里；统一派生进 toolResults（显式列表优先）。
      toolResults: Array.isArray(step?.toolResults)
        ? step.toolResults
        : (Array.isArray(step?.content) ? step.content : [])
          .filter((block) => block && block.type === 'tool-result')
          .map((block) => ({ toolCallId: block.toolCallId, content: block.content, isError: block.isError })),
      time: Number.isSafeInteger(step?.time) ? step.time : undefined,
      model: typeof step?.model === 'string' ? step.model : undefined,
      usage: step?.usage,
    })),
    time: Number.isSafeInteger(turn?.time) ? turn.time : undefined,
    aborted: turn?.aborted === true,
  }
}

/** interchange v1 文档 → { header, events, title, stats }。 */
export function parseInterchange(doc, { sessionId, createdAt }) {
  const version = Number(doc && doc.version)
  if (version !== 1) return { ok: false, error: '不支持的 interchange 版本：' + String(doc && doc.version) + '（只认 1）' }
  const rawTurns = Array.isArray(doc.turns) ? doc.turns : []
  const turns = rawTurns.map(normalizeInterchangeTurn).filter((turn) => turn.prompt.trim() || turn.steps.length > 0)
  if (turns.length === 0) return { ok: false, error: 'interchange 文档里没有可导入的轮次（turns 为空）' }
  const meta = {
    id: sessionId,
    createdAt: Number.isSafeInteger(createdAt) ? createdAt : Date.now(),
    cwd: typeof doc.meta?.cwd === 'string' ? doc.meta.cwd : undefined,
  }
  const synthesized = synthesizeSession({
    meta,
    turns,
    title: typeof doc.title === 'string' ? doc.title : '',
    provider: typeof doc.provider === 'string' ? doc.provider : 'unknown',
    model: typeof doc.model === 'string' ? doc.model : undefined,
  })
  return {
    ok: true,
    kind: 'interchange',
    header: {
      version: 4,
      id: meta.id,
      createdAt: meta.createdAt,
      ...(meta.cwd ? { cwd: meta.cwd } : {}),
      isSeeded: false,
      delegationDepth: 0,
    },
    events: synthesized.events,
    title: typeof doc.title === 'string' ? doc.title : '',
    stats: synthesized.stats,
  }
}

// ── 识别 ────────────────────────────────────────────────────────────────────

/**
 * 内容识别（不看扩展名）：bundle > interchange > DSH JSONL。
 * @returns {{kind: 'bundle'|'interchange'|'jsonl'|'unknown', doc?: object, error?: string}}
 */
export function detectFormat(text, fileName = '') {
  const head = String(text || '').slice(0, 64 * 1024).trim()
  if (!head) return { kind: 'unknown', error: '文件是空的' }
  if (head.startsWith('{') || head.startsWith('[')) {
    // JSONL 的头部也是 JSON，但整份文件不是合法 JSON——先试整份 JSON。
    try {
      const doc = JSON.parse(String(text))
      if (doc && doc.bundle === 'dsh-chat-import') return { kind: 'bundle', doc }
      if (doc && doc.bundle === BUNDLE_KIND) return { kind: 'bundle', doc }
      if (doc && doc.interchange === 'dsh-chat-import') return { kind: 'interchange', doc }
      if (doc && typeof doc.bundle === 'string') return { kind: 'unknown', error: '未知的 bundle 类型：' + doc.bundle }
      if (doc && typeof doc.interchange === 'string') return { kind: 'unknown', error: '未知的 interchange 标记：' + doc.interchange }
      return { kind: 'unknown', error: '是 JSON，但不是会话备份 / interchange 文档（缺少 bundle / interchange 标记）' }
    } catch {
      // 落到 JSONL 探测
    }
  }
  const firstLine = head.split(/\r?\n/, 1)[0].trim()
  if (firstLine.startsWith('{')) {
    try {
      const header = JSON.parse(firstLine)
      if (header && typeof header.id === 'string' && typeof header.version === 'number') {
        return { kind: 'jsonl', doc: null }
      }
    } catch {
      // 忽略
    }
  }
  const name = basename(String(fileName || ''))
  return { kind: 'unknown', error: '无法识别的文件格式：' + (name || '（无文件名）') + '（支持 .dshbundle.json、interchange v1 JSON、DSH 会话 JSONL）' }
}

/**
 * 把一份文件文本解析成可导入的会话记录。
 * @returns {{ok: true, kind, header, events, title, skippedLines} | {ok: false, error}}
 */
export function parseImportFile(text, fileName, { sessionId, createdAt, hostVersion }) {
  const detected = detectFormat(text, fileName)
  if (detected.kind === 'unknown') return { ok: false, error: detected.error }
  if (detected.kind === 'bundle') {
    const parsed = parseBundle(detected.doc)
    if (!parsed.ok) return parsed
    return { ...parsed, events: parsed.events }
  }
  if (detected.kind === 'interchange') {
    const parsed = parseInterchange(detected.doc, { sessionId, createdAt })
    if (!parsed.ok) return parsed
    return parsed
  }
  const parsed = parseJsonl(text)
  if (!parsed.header) return { ok: false, error: 'JSONL 里没有会话 header（首行应为会话元数据）' }
  if (parsed.events.length === 0) return { ok: false, error: 'JSONL 里没有会话事件' }
  return {
    ok: true,
    kind: 'jsonl',
    header: parsed.header,
    events: parsed.events,
    title: '',
    skippedLines: parsed.skippedLines,
  }
}

// ── Markdown / JSONL 旁路导出 ───────────────────────────────────────────────

function fence(text, lang = '') {
  const body = String(text ?? '')
  const longest = Math.max(3, ...(body.match(/`+/g) || []).map((run) => run.length + 1))
  const mark = '`'.repeat(longest)
  return mark + lang + '\n' + body + '\n' + mark
}

function blockText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return ''
    if (block.type === 'text') return block.text || ''
    if (block.type === 'reasoning') return block.text ? '> 推理：' + String(block.text).replace(/\n/g, '\n> ') : ''
    if (block.type === 'image') return '[image]'
    if (block.type === 'file') return '[file] ' + (block.attachment?.name || '')
    if (block.type === 'tool-call') return fence(block.arguments || '', 'json')
    return ''
  }).filter(Boolean).join('\n\n')
}

/** 可读的 Markdown 导出：一轮一问一答，工具调用与结果折叠成代码块。 */
export function renderMarkdown({ header, events, title }) {
  const lines = []
  const heading = (title || '').trim() || (header && header.id) || 'session'
  lines.push('# ' + heading)
  lines.push('')
  const meta = []
  if (header && header.id) meta.push('- 会话 id：`' + header.id + '`')
  if (header && Number.isFinite(header.createdAt)) meta.push('- 创建时间：' + new Date(header.createdAt).toISOString())
  if (header && header.cwd) meta.push('- 工作目录：`' + header.cwd + '`')
  meta.push('- 事件数：' + (Array.isArray(events) ? events.length : 0))
  lines.push(meta.join('\n'))
  lines.push('')
  let turn = 0
  for (const ev of events) {
    if (!ev || !ev.type) continue
    if (ev.type === 'turn/start') {
      turn = ev.data && ev.data.turn ? ev.data.turn : turn + 1
      continue
    }
    if (ev.type === 'user/message') {
      const source = ev.data && ev.data.source
      // 插件注入行（上下文注入 / 压缩检查点）不是人说的话：V3 写作 kind:'plugin'，
      // V4 改写成生产者自己的 kind，两种代次都按「不是 user」判定。
      if (source && typeof source.kind === 'string' && source.kind !== 'user') continue
      lines.push('## 第 ' + turn + ' 轮 · 用户', '', blockText(ev.data && ev.data.content), '')
      continue
    }
    if (ev.type === 'assistant/message') {
      lines.push('## 第 ' + turn + ' 轮 · 助手', '', blockText(ev.data?.message?.content), '')
      continue
    }
    if (ev.type === 'tool/result') {
      const result = readToolResult(ev)
      if (!result) continue
      const text = blockText(result.blocks).slice(0, 4000)
      lines.push('> 工具结果 `' + result.callId + '`' + (result.isError ? '（错误）' : ''), '', fence(text, 'text'), '')
    }
  }
  return lines.join('\n')
}

/** 原始事件 JSONL（header + 全部事件），供外部工具处理。 */
export function renderRawJsonl({ header, events, targetVersion }) {
  const shaped = normalizeEnvelope(shapeEventsForHost(events, targetVersion || header?.version || 4), header?.createdAt)
  return eventsToJsonl({ ...header, version: targetVersion || header?.version || 4 }, shaped)
}

export function suggestExtension(format) {
  if (format === 'markdown') return '.md'
  if (format === 'jsonl') return '.jsonl'
  return '.dshbundle.json'
}

