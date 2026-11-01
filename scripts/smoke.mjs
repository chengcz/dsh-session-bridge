// scripts/smoke.mjs — 纯函数层冒烟测试（不连宿主）：合成 → 指纹 → 导出 → 解析 → 指纹一致
import assert from 'node:assert/strict'
import { buildBundle, parseBundle, parseImportFile, renderMarkdown } from '../lib/formats.js'
import { fingerprintEvents } from '../lib/fingerprint.js'
import { shapeEventsForHost, synthesizeSession } from '../lib/synthesize.js'

const turns = [
  {
    prompt: '帮我看下这个报错',
    steps: [
      {
        content: [
          { type: 'text', text: '我先读一下文件。' },
          { type: 'reasoning', text: '需要定位堆栈' },
        ],
        toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' }],
        toolResults: [{ toolCallId: 'call-1', content: [{ type: 'text', text: 'line 1' }] }],
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    ],
  },
  { prompt: '继续', steps: [{ content: [{ type: 'text', text: '好的。' }], toolCalls: [], toolResults: [] }] },
]

const meta = { id: 'bridge-demo', createdAt: 1767224650000, cwd: '/tmp/demo' }
const synthesized = synthesizeSession({ meta, turns, title: '演示会话', provider: 'demo', model: 'demo-model' })
assert.ok(synthesized.events.length > 10, 'should synthesize events')
assert.equal(synthesized.events[0].seq, 0)
assert.equal(synthesized.events[0].type, 'turn/start')
const head = synthesized.events.find((event) => event.type === 'system/message')
assert.ok(head, 'system head must exist')

// V4 形状：tool/result 是一级 tool 消息
const v4 = shapeEventsForHost(synthesized.events, 4)
const toolResult = v4.find((event) => event.type === 'tool/result')
assert.equal(toolResult.data.message.role, 'tool')
assert.equal(toolResult.data.message.toolCallId, 'call-1')
assert.equal(toolResult.data.message.source.kind, 'tool')

const header = { version: 4, id: meta.id, createdAt: meta.createdAt, cwd: meta.cwd, isSeeded: false, delegationDepth: 0 }
const fingerprint = fingerprintEvents(v4)
assert.equal(fingerprint, fingerprintEvents(synthesized.events), 'V3/V4 两种形状指纹一致')

// bundle 往返
const bundle = buildBundle({ header, events: v4, title: '演示会话', exportedAt: Date.now(), fingerprint })
const text = JSON.stringify(bundle, null, 2)
const parsed = parseBundle(JSON.parse(text))
assert.equal(parsed.ok, true, parsed.error)
assert.equal(parsed.events.length, v4.length)
assert.equal(fingerprintEvents(parsed.events), fingerprint, 'bundle 往返后指纹一致')

// 篡改检测
const tampered = JSON.parse(text)
tampered.log = tampered.log.replace('演示会话', '被改过')
assert.equal(parseBundle(tampered).ok, false)

// interchange 往返（导入 → 导出 → 再导入，指纹不变）
const interchange = {
  interchange: 'dsh-chat-import',
  version: 1,
  title: '演示会话',
  provider: 'demo',
  turns,
}
const fromInterchange = parseImportFile(JSON.stringify(interchange), 'demo.json', {
  sessionId: 'bridge-demo', createdAt: meta.createdAt, hostVersion: 4,
})
assert.equal(fromInterchange.ok, true, fromInterchange.error)
const fp2 = fingerprintEvents(shapeEventsForHost(fromInterchange.events, 4))
assert.equal(fp2, fingerprint, 'interchange 与 bundle 同一段对话的指纹一致')

// 旧插件（dsh-chat-import）的便携包：sha256.session 而不是 sha256.log
const foreign = {
  bundle: 'dsh-chat-import',
  format: 'interchange-v1',
  version: 1,
  exportedAt: Date.now(),
  sourceSessionId: 'import-demo',
  title: '旧插件备份',
  log: bundle.log,
  sha256: { session: bundle.sha256.log, bundle: 'deadbeef' },
}
const foreignParsed = parseBundle(foreign)
assert.equal(foreignParsed.ok, true, foreignParsed.error)
assert.equal(fingerprintEvents(foreignParsed.events), fingerprint, '旧插件备份导入后指纹一致')
const brokenForeign = { ...foreign, log: foreign.log + '{"type":"turn/start","seq":999,"time":0,"data":{"turn":9}}\n' }
assert.equal(parseBundle(brokenForeign).ok, false, '损坏的旧插件备份必须被拒绝')

// markdown 可读导出
const markdown = renderMarkdown({ header, events: v4, title: '演示会话' })
assert.ok(markdown.includes('演示会话'))
assert.ok(markdown.includes('帮我看下这个报错'))

console.log('smoke ok:', {
  events: v4.length,
  fingerprint: fingerprint.slice(0, 12),
  bundleBytes: text.length,
  markdownBytes: markdown.length,
})
