// lib/agent-sources/blocks.js — 各家的内容块 → 本地中间块
//
// 每个 Agent 都有自己的块词汇（Claude 的 text/tool_use、Goose 的 text/toolRequest、
// Zed 的 text/tool_use…）。这里用「认字段不认类型名」的宽松归一：只要块里有 text 就是正文，
// 带 name+input 就是工具调用，带 tool_use_id/tool_result 就是工具结果。
// 宁可少解析一个怪块，也不虚构内容——认不出的块直接丢弃。
import { stringifyToolValue } from './turns.js'

function textOf(block) {
  if (typeof block.text === 'string') return block.text
  if (typeof block.thinking === 'string') return block.thinking
  if (block.value && typeof block.value.text === 'string') return block.value.text
  return ''
}

/** 一个块 → 0..n 个中间块。 */
export function blockOf(raw) {
  if (raw === null || raw === undefined) return []
  if (typeof raw === 'string') return raw ? [{ type: 'text', text: raw }] : []
  if (typeof raw !== 'object') return []

  const type = String(raw.type || '')

  // 工具调用：Claude tool_use / Goose toolRequest / Zed tool_use / 通用 tool-call
  if (type === 'tool_use' || type === 'tool-call' || type === 'tool_call' || type === 'toolRequest') {
    const envelope = raw.tool_call && typeof raw.tool_call === 'object'
      ? (raw.tool_call.value && typeof raw.tool_call.value === 'object' ? raw.tool_call.value : raw.tool_call)
      : null
    const name = raw.name || (envelope && envelope.name) || ''
    const id = raw.id || raw.toolCallId || raw.callID || ''
    const input = raw.input ?? raw.arguments ?? (envelope ? envelope.arguments : undefined) ?? {}
    if (!name && !id) return []
    return [{
      type: 'tool-call',
      id: String(id || ''),
      name: String(name || 'unknown'),
      arguments: stringifyToolValue(input),
    }]
  }

  // 工具结果：Claude tool_result / Goose toolResponse / 通用 tool-result
  if (type === 'tool_result' || type === 'tool-result' || type === 'toolResponse') {
    const envelope = raw.tool_result && typeof raw.tool_result === 'object' ? raw.tool_result : null
    const value = envelope ? (envelope.value ?? envelope.error) : (raw.content ?? raw.output ?? raw.value)
    const id = raw.tool_use_id || raw.toolCallId || raw.id || ''
    const isError = raw.is_error === true
      || (envelope && typeof envelope.status === 'string' && envelope.status !== 'success' && envelope.status !== 'completed')
    let text = ''
    if (typeof value === 'string') text = value
    else if (Array.isArray(value)) {
      text = value.map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item.text === 'string') return item.text
        return ''
      }).filter(Boolean).join('\n')
    } else if (value && typeof value === 'object') {
      text = typeof value.text === 'string' ? value.text : stringifyToolValue(value)
    }
    return [{ type: 'tool-result', id: String(id || ''), content: text, isError: Boolean(isError) }]
  }

  // 推理：各家的 thinking / reasoning
  if (type === 'thinking' || type === 'reasoning') {
    const text = textOf(raw)
    return text ? [{ type: 'reasoning', text }] : []
  }

  // 正文（也兜住 "<type>: image/document/..." 这类：无文本就丢）
  if (type === 'text' || type === 'input_text' || type === 'output_text' || type === '') {
    const text = textOf(raw)
    return text ? [{ type: 'text', text }] : []
  }

  return []
}

/** content 可能是字符串、块数组或单块对象 → 中间块数组。 */
export function blocksOf(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (Array.isArray(content)) return content.flatMap(blockOf)
  if (content && typeof content === 'object') return blockOf(content)
  return []
}
