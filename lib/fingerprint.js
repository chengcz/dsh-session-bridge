// lib/fingerprint.js — 会话「内容指纹」
//
// 重复导入的判定不能用文件字节（同一段对话可以被导出、压缩、改标题、换路径），也不能用
// 会话 id（重导会另铸 id），更不能用源路径（同一内容可从不同路径到达，DSH 源回灌正是
// 这样把 import-* 会话再次导入、产出 import-import-* 的）。这里只取**模型看得到的内容**：
// 谁说了什么、调用了什么工具、结果是什么；丢弃 id / seq / 时间戳 / 模型名 / 系统提示词 /
// 插件注入行。同一段对话无论经多少种格式转写，指纹一致。
import { sha256 } from './util.js'

/** 内容块的规范化：只保留语义，丢弃 id、附件引用、格式细节。 */
function normalizeBlocks(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) out.push({ t: 'text', v: block.text })
        break
      case 'reasoning':
        if (typeof block.text === 'string' && block.text.length > 0) out.push({ t: 'reasoning', v: block.text })
        break
      case 'tool-call':
        out.push({ t: 'tool-call', n: String(block.name || ''), a: String(block.arguments || '') })
        break
      case 'tool-result':
        out.push({ t: 'tool-result', id: String(block.toolCallId || ''), c: normalizeBlocks(block.content) })
        break
      case 'image':
        out.push({ t: 'image' })
        break
      case 'file':
        out.push({ t: 'file', n: block.attachment ? String(block.attachment.name || '') : '' })
        break
      default:
        out.push({ t: String(block.type || 'unknown') })
    }
  }
  return out
}

/**
 * 读一条 tool/result，兼容 V3 包装形状与 V4 一级 tool 消息形状。
 * 返回**原始**内容块（调用方按自己的目的归一：指纹要语义、形状转换要保真）。
 */
export function readToolResult(ev) {
  if (!ev || ev.type !== 'tool/result' || !ev.data) return null
  const message = ev.data.message
  if (!message || typeof message !== 'object') return null
  if (message.role === 'tool' && typeof message.toolCallId === 'string') {
    return { callId: message.toolCallId, blocks: Array.isArray(message.content) ? message.content : [], isError: message.isError === true }
  }
  const wrapper = Array.isArray(message.content)
    ? message.content.find((block) => block && block.type === 'tool-result')
    : null
  if (wrapper && typeof wrapper.toolCallId === 'string') {
    return { callId: wrapper.toolCallId, blocks: Array.isArray(wrapper.content) ? wrapper.content : [], isError: wrapper.isError === true }
  }
  const callId = message.source && typeof message.source.callId === 'string' ? message.source.callId : ''
  if (callId) return { callId, blocks: Array.isArray(message.content) ? message.content : [], isError: message.isError === true }
  return null
}

/**
 * 用户消息是否由插件注入（上下文注入 / 压缩检查点 / 环境声明…）。
 * 只认 source.kind === 'user' 为「真人说的」：V3 写作 { kind:'plugin', plugin }，
 * V4 改写成生产者自己的 kind（runtime-context / compact-checkpoint / plugin:<name>），
 * 两种代次在这里必须得到同一个判定，否则同一段对话的指纹会随宿主版本漂移。
 */
function isInjected(message) {
  const kind = message && message.source && message.source.kind
  return typeof kind === 'string' && kind !== 'user'
}

/**
 * 会话的规范化对话序列。顺序即日志顺序（DSH 的消息投影不重排）。
 * 跳过：system / developer 消息（各机器系统提示词不同）、插件注入行（上下文注入、
 * 压缩检查点等，随宿主版本变化）。
 */
export function conversationEntries(events) {
  const entries = []
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'user/message') {
      if (isInjected(ev.data)) continue
      entries.push({ role: 'user', content: normalizeBlocks(ev.data && ev.data.content) })
      continue
    }
    if (ev.type === 'assistant/message') {
      const message = ev.data && ev.data.message
      if (!message) continue
      entries.push({ role: 'assistant', content: normalizeBlocks(message.content) })
      continue
    }
    if (ev.type === 'tool/result') {
      const result = readToolResult(ev)
      if (!result) continue
      entries.push({ role: 'tool', id: result.callId, content: normalizeBlocks(result.blocks), err: result.isError })
    }
  }
  return entries
}

/** 会话内容指纹（hex）。同一段对话 → 同一指纹，与文件路径、id、时间无关。 */
export function fingerprintEvents(events) {
  return sha256(JSON.stringify(conversationEntries(events)))
}

/** 统计：真实消息数（不含插件注入）与工具调用数。 */
export function countConversation(events) {
  let messages = 0
  let toolCalls = 0
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'user/message' && !isInjected(ev.data)) messages += 1
    else if (ev.type === 'assistant/message') messages += 1
    else if (ev.type === 'tool/result') messages += 1
    else if (ev.type === 'tool/call') toolCalls += 1
  }
  return { messages, toolCalls }
}

/** 首个用户提问的文本投影（标题兜底、空会话判定）。 */
export function firstUserText(events) {
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.type !== 'user/message' || isInjected(ev.data)) continue
    const content = Array.isArray(ev.data && ev.data.content) ? ev.data.content : []
    const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim()
    if (text) return text
  }
  return ''
}
