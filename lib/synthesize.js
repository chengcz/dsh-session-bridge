// lib/synthesize.js — interchange v1 的 turns IR → 平衡的 DSH 会话事件日志
//
// 宿主对导入日志有几组硬不变量，合成时必须同时满足：
//   * seq 从 0 连续；surface 事件带 surfaceOp:'append'；
//   * surface 的首个事件是 system head（v3→v4 迁移的 protected head），紧随其后是环境变更声明；
//   * 工具生命周期闭合在调用被广告的同一 step 内，每个调用恰好一条结果；
//   * tool/result 形状按目标代次（V3 包装 / V4 一级 tool 消息），V4 的 source.kind 必须是
//     生产者自己的名字（不再接受 'plugin'）。
//
// 这一段改编自 dsh-chat-import（MIT）的 lib/convert/events.mjs + lib/convert/shape.mjs：
// 只保留「interchange 文档 → 事件」需要的最小集合（压缩检查点、预算裁剪、逐源降级表不在
// 本插件范围内），不变量与字段拼写保持与上游一致，便于两边的导出互相导入。
import { readToolResult } from './fingerprint.js'

const SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt'

// 宿主 V3 插件名 → 当前生产者 kind（V4 只认这些字面量）。表照抄宿主迁移器，避免写错后
// 检查点在 UI 里退化成普通 user 消息。
const RENAMED_PRODUCERS = {
  compact: 'compact-checkpoint',
  'tools-code-mode': 'ptc-mode',
  'tools-ptc': 'ptc-mode',
  'dsh-compaction-basic': 'compact-basic',
  [SYSTEM_PROMPT_PLUGIN]: 'runtime-context',
}
const SAME_NAME_PRODUCERS = new Set([
  'agent-instructions', 'session-reference', 'team-message', 'goal', 'skill-invocation',
  'skill-catalog', 'coordinator', 'subagent-report', 'subagent-settled', 'webhook',
  'agent-message', 'model-selection', 'plan-mode', 'time-context', 'tmux-context',
  'user-approval', 'repeat-tool-reminder', 'tool-cordis', 'cordis-host-runner', 'tool-goal',
  'tool-jobs', 'hooks-codex', 'hooks-claude-code', 'schedule', 'dsh-session-title-llm',
])

function producerKind(plugin, role) {
  if (plugin === SYSTEM_PROMPT_PLUGIN && role === 'system') return 'system-prompt'
  if (Object.hasOwn(RENAMED_PRODUCERS, plugin)) return RENAMED_PRODUCERS[plugin]
  if (SAME_NAME_PRODUCERS.has(plugin)) return plugin
  return 'plugin:' + plugin
}

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

function environmentNotice(provider) {
  const label = typeof provider === 'string' && provider ? provider : 'unknown'
  const body = 'Environment change notice: this session was migrated from ' + label
    + ' to DeepSeek Harness (DSH). The current runtime environment, available tool list,'
    + ' permissions, and execution instructions are all governed by the current DSH session;'
    + ' do not reuse tool names, commands, or environment conventions from the source environment.'
  return [REMINDER_OPEN, body.replaceAll(REMINDER_CLOSE, '<\\/system-reminder>'), REMINDER_CLOSE].join('\n')
}

function sanitizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const ok = (v) => Number.isSafeInteger(v) && v >= 0
  if (!ok(usage.inputTokens) || !ok(usage.outputTokens)) return undefined
  const out = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  if (ok(usage.cacheReadTokens)) out.cacheReadTokens = usage.cacheReadTokens
  if (ok(usage.cacheWriteTokens)) out.cacheWriteTokens = usage.cacheWriteTokens
  if (ok(usage.reasoningTokens)) out.reasoningTokens = usage.reasoningTokens
  return out
}

/**
 * 工具结果的内容块。
 *
 * interchange 文档里 content 是块数组（[{type:'text',text}]），而各来源的读取器更愿意直接给
 * 字符串（zcode 的 state.output、Claude 的 tool_result、Codex 的 output …）。这里两种都认：
 * 只接受数组会把这些结果悄悄变成空 content —— 会话能导入，但工具输出一片空白。
 */
function toolResultBlocks(result) {
  if (!result) return []
  const content = result.content
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (content === undefined || content === null) return []
  try {
    const text = JSON.stringify(content)
    return text && text !== '{}' ? [{ type: 'text', text }] : []
  } catch {
    return []
  }
}

function normalizeCall(call, index) {
  const id = typeof call.id === 'string' && call.id ? call.id : 'call-' + index
  return {
    id,
    name: typeof call.name === 'string' && call.name ? call.name : 'unknown',
    arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
  }
}

/**
 * turns → 事件。
 * @param {object} input
 * @param {{id: string, createdAt: number, cwd?: string}} input.meta 目标会话身份
 * @param {Array} input.turns interchange turns
 * @param {string} [input.title] 会话标题
 * @param {string} [input.provider] 源标识（只进环境声明与 assistant 消息的 source）
 * @param {string} [input.model] 源模型名
 */
export function synthesizeSession({ meta, turns, title, provider, model }) {
  const events = []
  let seq = 0
  let turn = 0
  let clock = Number.isSafeInteger(meta.createdAt) ? meta.createdAt : Date.now()
  const providerName = typeof provider === 'string' && provider ? provider : 'unknown'
  const modelName = typeof model === 'string' && model ? model : providerName

  const advance = (time) => {
    if (Number.isSafeInteger(time) && time > clock) clock = time
  }
  const push = (type, data, surface, sourceEventSeqs) => {
    const event = { type, seq: seq++, time: clock, data }
    if (surface === true) event.surfaceOp = 'append'
    if (sourceEventSeqs) event.sourceEventSeqs = sourceEventSeqs
    events.push(event)
    return event
  }

  // 配对预扫描：真实结果按 callId 归位到调用的 step；无调用的孤儿结果与重复结果丢弃。
  const callById = new Map()
  const resultByCallId = new Map()
  let duplicateToolResults = 0
  for (const t of turns) {
    for (const s of t.steps || []) {
      for (const call of s.toolCalls || []) {
        const normalized = normalizeCall(call, callById.size)
        if (!callById.has(normalized.id)) callById.set(normalized.id, normalized)
      }
      for (const result of s.toolResults || []) {
        const key = typeof result.toolCallId === 'string' ? result.toolCallId : ''
        if (!key) continue
        if (resultByCallId.has(key)) { duplicateToolResults += 1; continue }
        resultByCallId.set(key, result)
      }
    }
  }
  let orphanToolResults = 0
  for (const callId of [...resultByCallId.keys()]) {
    if (!callById.has(callId)) { orphanToolResults += 1; resultByCallId.delete(callId) }
  }

  let headPushed = false
  const pushSystemHead = (turnNo, stepNo) => {
    headPushed = true
    push('system/message', {
      turn: turnNo,
      step: stepNo,
      message: {
        id: 'bridge:' + meta.id + ':sys',
        role: 'system',
        content: [],
        source: { kind: 'plugin', plugin: SYSTEM_PROMPT_PLUGIN },
      },
    }, true)
  }
  let envInjected = false
  const pushEnvInjection = () => {
    envInjected = true
    push('user/message', {
      id: 'bridge:' + meta.id + ':env',
      role: 'user',
      content: [{ type: 'text', text: environmentNotice(providerName) }],
      source: { kind: 'plugin', plugin: 'dsh-session-bridge' },
    }, true)
  }

  for (const t of turns) {
    let steps = Array.isArray(t.steps) ? t.steps : []
    turn += 1
    advance(t.time)
    push('turn/start', { turn })
    if (steps.length === 0) {
      // 只有提问、没有回复的轮次：补一个只装 head 的空 step（空 step 合法）。
      if (!headPushed) {
        push('step/start', { turn, step: 1 })
        pushSystemHead(turn, 1)
        if (!envInjected) pushEnvInjection()
        push('step/end', { turn, step: 1 })
      }
      push('user/message', {
        id: 'bridge:' + meta.id + ':u' + turn,
        role: 'user',
        content: Array.isArray(t.promptBlocks) && t.promptBlocks.length > 0
          ? t.promptBlocks
          : [{ type: 'text', text: String(t.prompt ?? '') }],
        source: { kind: 'user' },
      }, true)
    } else {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        const stepNo = i + 1
        push('step/start', { turn, step: stepNo })
        if (!headPushed) pushSystemHead(turn, stepNo)
        if (!envInjected) pushEnvInjection()
        if (i === 0) {
          push('user/message', {
            id: 'bridge:' + meta.id + ':u' + turn,
            role: 'user',
            content: Array.isArray(t.promptBlocks) && t.promptBlocks.length > 0
              ? t.promptBlocks
              : [{ type: 'text', text: String(t.prompt ?? '') }],
            source: { kind: 'user' },
          }, true)
        }
        advance(step.time)
        const usage = sanitizeUsage(step.usage)
        const calls = (step.toolCalls || []).map((call, index) => normalizeCall(call, index))
        const content = Array.isArray(step.content) ? [...step.content] : []
        // 广告工具调用：assistant 消息里必须带同名 tool-call 块（宿主投影按块算 tool_calls）。
        for (const call of calls) {
          if (!content.some((block) => block && block.type === 'tool-call' && block.id === call.id)) {
            content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
          }
        }
        push('assistant/message', {
          turn,
          step: stepNo,
          stream: [],
          ...(usage ? { usage } : {}),
          message: {
            id: 'bridge:' + meta.id + ':a' + turn + ':' + stepNo,
            role: 'assistant',
            content,
            source: { kind: 'model', provider: providerName, model: step.model || modelName },
          },
        }, true)
        const callSeqs = []
        for (const call of calls) {
          const event = push('tool/call', {
            turn,
            step: stepNo,
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
          })
          callSeqs.push(event.seq)
        }
        for (let ci = 0; ci < calls.length; ci++) {
          const call = calls[ci]
          const result = resultByCallId.get(call.id)
          advance(result && result.time)
          push('tool/result', {
            turn,
            step: stepNo,
            message: {
              id: 'bridge:' + meta.id + ':t' + turn + ':' + stepNo + ':' + call.id,
              role: 'user',
              content: [{
                type: 'tool-result',
                toolCallId: call.id,
                content: toolResultBlocks(result),
                ...(result && result.isError ? { isError: true } : {}),
              }],
              source: { kind: 'tool', callId: call.id },
            },
          }, true, [callSeqs[ci]])
        }
        push('step/end', { turn, step: stepNo })
      }
    }
    push('turn/end', {
      turn,
      reason: t.aborted === true ? { kind: 'aborted', reason: { kind: 'legacy' } } : { kind: 'completed' },
    })
  }

  const trimmedTitle = String(title || '').trim()
  if (trimmedTitle) {
    push('session/title', { title: trimmedTitle, messageSeqs: [], source: { kind: 'user' } })
  }

  return {
    events,
    stats: {
      turns: turn,
      duplicateToolResults,
      orphanToolResults,
    },
  }
}

// ── 代次形状归一 ────────────────────────────────────────────────────────────

function shapeReplaceOps(events, version) {
  const v4Names = version >= 4
  return events.map((ev) => {
    const op = ev && ev.surfaceOp
    if (!op || typeof op !== 'object' || op.op !== 'replace') return ev
    const hasOld = Object.hasOwn(op, 'start') && Object.hasOwn(op, 'end')
    const hasSeq = Object.hasOwn(op, 'startSeq') && Object.hasOwn(op, 'endSeq')
    if (v4Names && hasOld && !hasSeq) {
      return { ...ev, surfaceOp: { op: 'replace', startSeq: op.start, endSeq: op.end } }
    }
    if (!v4Names && hasSeq && !hasOld) {
      return { ...ev, surfaceOp: { op: 'replace', start: op.startSeq, end: op.endSeq } }
    }
    return ev
  })
}

function shapeMessageSources(events, version) {
  if (!(version >= 4)) return events
  const fixSource = (source, role) => {
    if (!source || typeof source !== 'object' || source.kind !== 'plugin' || typeof source.plugin !== 'string') return source
    const { plugin, ...rest } = source
    return { ...rest, kind: producerKind(plugin, role) }
  }
  const fixMessage = (message) => {
    if (!message || typeof message !== 'object') return message
    const source = fixSource(message.source, message.role)
    return source === message.source ? message : { ...message, source }
  }
  return events.map((ev) => {
    if (!ev || typeof ev !== 'object' || !ev.data || typeof ev.data !== 'object') return ev
    if (ev.type === 'user/message') {
      const next = fixMessage(ev.data)
      return next === ev.data ? ev : { ...ev, data: next }
    }
    if (ev.type === 'system/message' || ev.type === 'assistant/message' || ev.type === 'tool/result') {
      const next = fixMessage(ev.data.message)
      return next === ev.data.message ? ev : { ...ev, data: { ...ev.data, message: next } }
    }
    return ev
  })
}

function shapeToolResults(events, version) {
  const wantV4 = version >= 4
  return events.map((ev) => {
    const result = readToolResult(ev)
    if (!result) return ev
    const message = ev.data.message
    const next = {
      ...message,
      source: { ...(message.source || {}), kind: 'tool', callId: result.callId },
    }
    delete next.plugin
    if (wantV4) {
      next.role = 'tool'
      next.toolCallId = result.callId
      next.content = result.blocks
      if (result.isError) next.isError = true
      else delete next.isError
    } else {
      next.role = 'user'
      next.content = [{
        type: 'tool-result',
        toolCallId: result.callId,
        content: result.blocks,
        ...(result.isError ? { isError: true } : {}),
      }]
      delete next.toolCallId
      delete next.isError
    }
    return { ...ev, data: { ...ev.data, message: next } }
  })
}

/**
 * 把事件归一到目标宿主代次：工具结果形状、source 生产者名、替换标记拼写。
 * 幂等；bundle 回灌的事件同样过这一层（跨代次备份也能读）。
 */
export function shapeEventsForHost(events, version) {
  const list = Array.isArray(events) ? events : []
  if (list.length === 0) return list
  return shapeReplaceOps(shapeMessageSources(shapeToolResults(list, version), version), version)
}

/** 事件的 envelope 清洗：seq 从 0 重排、data 缺失补空对象、time 单调不减。 */
export function normalizeEnvelope(events, baseTime = Date.now()) {
  let clock = Number.isSafeInteger(baseTime) ? baseTime : Date.now()
  return (Array.isArray(events) ? events : []).map((ev, index) => {
    const time = Number.isSafeInteger(ev && ev.time) && ev.time > 0 ? ev.time : clock
    if (time > clock) clock = time
    return {
      ...ev,
      seq: index,
      time,
      data: ev && typeof ev.data === 'object' && ev.data !== null ? ev.data : {},
    }
  })
}
