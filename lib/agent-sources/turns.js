// lib/agent-sources/turns.js — 消息流 → interchange 轮次
//
// 各家日志的表达不同（part 数组、content 块、纯文本），但落到「谁说了什么 / 调了哪个工具 /
// 结果是什么」是同一件事。这里只做最后一步聚合：user 消息开一轮，assistant 消息成为一个
// step；只带工具结果的 user 消息回填到上一个 step，不另起一轮（Claude Code、opencode 都是
// 这么表达的）。
//
// block 形状（本模块的中间表示）：
//   { type: 'text', text }                    正文
//   { type: 'reasoning', text }               推理
//   { type: 'tool-call', id, name, arguments } 工具调用（arguments 是字符串）
//   { type: 'tool-result', id, content, isError }
export function assembleTurns(messages) {
  const turns = []
  let current = null

  const beginTurn = (prompt, time) => {
    current = { prompt, time, steps: [] }
    turns.push(current)
    return current
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.isSummary === true) continue
    const role = String(message.role || '')
    const blocks = Array.isArray(message.blocks) ? message.blocks : []
    if (role !== 'user' && role !== 'assistant') continue

    const texts = blocks.filter((block) => block && block.type === 'text' && block.text).map((block) => block.text)
    const results = blocks.filter((block) => block && block.type === 'tool-result')
    const prompt = texts.join('\n').trim()

    if (role === 'user') {
      // 纯结果回填：不新开轮次
      if (results.length > 0 && !prompt) {
        const step = current && current.steps.length > 0 ? current.steps[current.steps.length - 1] : null
        if (step) {
          step.toolResults.push(...results.map((block) => ({
            toolCallId: block.id,
            content: block.content,
            isError: block.isError === true,
          })))
          continue
        }
      }
      if (!prompt) continue
      const turn = beginTurn(prompt, message.time)
      if (results.length > 0) {
        turn.steps.push({ content: [], toolCalls: [], toolResults: results.map((block) => ({
          toolCallId: block.id,
          content: block.content,
          isError: block.isError === true,
        })) })
      }
      continue
    }

    if (!current) beginTurn('', message.time)
    const content = blocks
      .filter((block) => block && (block.type === 'text' || block.type === 'reasoning'))
      .map((block) => ({ type: block.type, text: block.text }))
    const toolCalls = blocks
      .filter((block) => block && block.type === 'tool-call')
      .map((block, index) => ({
        id: block.id || ('call-' + index),
        name: block.name || 'unknown',
        arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
      }))
    const toolResults = results.map((block) => ({
      toolCallId: block.id,
      content: block.content,
      isError: block.isError === true,
    }))
    if (content.length === 0 && toolCalls.length === 0 && toolResults.length === 0) continue
    current.steps.push({ content, toolCalls, toolResults, ...(message.time ? { time: message.time } : {}) })
  }

  return turns.filter((turn) => turn.prompt.trim() || turn.steps.length > 0)
}

/** 工具的输入/输出在日志里可能是对象，统一压成字符串。 */
export function stringifyToolValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
