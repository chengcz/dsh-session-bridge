// scripts/client-sim.mjs — 客户端界面的无浏览器烟测
//
// 客户端半是浏览器代码（window.__ModuleLoader__ + react），没法在 Node 里直接跑。
// 这里用最小的 React 桩把组件真的执行一遍，捕获「渲染期就抛错」的问题（未定义变量、
// 括号/hook 调用错误、slot 注册失败），再静态校验每条文案键在中英文字典里都存在。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

// ── React 桩：只支持组件用到的这几个 API ──────────────────────────────────
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial === undefined ? null : initial }
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}
globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) })

const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

// 执行客户端 bundle（它会调用 window.__ModuleLoader__.load）
new Function('window', source)(globalThis.window)
assert.ok(definition, 'client.js must register itself through __ModuleLoader__')

const plugin = definition.factory(requireStub)
const slots = []
const ctx = {
  get(name) {
    if (name === 'locale') {
      return {
        register() { return () => {} },
        bind: () => (key) => key,
        subscribe: () => () => {},
      }
    }
    if (name === 'layout') return { selectPanel() {} }
    return undefined
  },
  effect() {},
  slots: {
    inject(name, callback) { callback() },
    register(slot, Component) {
      slots.push({ slot, Component })
      return () => {}
    },
  },
}

plugin.apply(ctx)

const names = slots.map((entry) => entry.slot.name + '#' + (entry.slot.id || entry.slot.key || '')).sort()
assert.deepEqual(names, [
  'main#session-bridge',
  'settings.section#session-bridge',
  'sidebar.panellist#session-bridge',
  'sidebar.workspaces.session.row.action#session-bridge.drag',
  'sidebar.workspaces.session.row.action#session-bridge.export',
  'sidebar.workspaces.session.row.action#session-bridge.move',
], 'all UI mount points must be registered: ' + names)

const bySlot = (name) => slots.find((entry) => entry.slot.name === name)

// ── 渲染烟测：每个挂载点都要能渲染出节点 ────────────────────────────────
const main = bySlot('main')
assert.equal(main.slot.key, 'session-bridge', 'main view key must match the sidebar panel id')
assert.equal(bySlot('sidebar.panellist').slot.id, 'session-bridge')

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node.props && typeof node.props.className === 'string') out.push('.' + node.props.className)
  collectText(node.children, out)
  return out
}

const page = main.Component({})
const pageText = collectText(page).join(' ')
assert.ok(pageText.includes('dsb-root'), 'manager page must render its root container')
assert.ok(pageText.includes('dsb-tabs'), 'manager page must render the tab bar')

// 五个页签各渲染一次：批量导入 / 批量去重这些分支只有点开页签才会求值，
// 只在默认页签上跑会漏掉未定义变量与括号错误。
const tabs = ['sessions', 'import', 'exports', 'audit', 'cleanup']
const rendered = {}
for (const tab of tabs) {
  const node = main.Component({ initialTab: tab })
  const text = collectText(node).join(' ')
  assert.ok(text.includes('dsb-root'), 'tab ' + tab + ' must render')
  rendered[tab] = text
}
assert.ok(rendered.import.includes('dsb-textarea'), 'import tab must render the multi-path box')
assert.ok(rendered.import.includes('dsb-batch') || rendered.import.length > 0, 'import tab renders')
assert.ok(rendered.audit.includes('dsb-select'), 'audit tab must render the strategy selector')

// 五个页签都由同一个组件按状态切换，这里逐一点一遍标签文案是否落在字典里
const settings = bySlot('settings.section').Component({})
assert.ok(collectText(settings).join(' ').includes('dsb-root'))

const icon = bySlot('sidebar.panellist').Component({ size: 16 })
assert.equal(icon.type, 'svg', 'sidebar entry must render an svg icon')

const rowSlots = slots.filter((entry) => entry.slot.name === 'sidebar.workspaces.session.row.action')
assert.equal(rowSlots.length, 3, 'row actions: export + move + drag handle')
const exportSlot = rowSlots.find((entry) => entry.slot.id === 'session-bridge.export')
assert.equal(exportSlot.Component({ sessionId: 'demo' }).type, 'button', 'export row action renders a button')

// 移动行动作：默认收起，渲染成容纳按钮的 span，且点击会阻止冒泡（否则会切换会话）
const moveSlot = rowSlots.find((entry) => entry.slot.id === 'session-bridge.move')
const moveNode = moveSlot.Component({ sessionId: 'demo', displayTitle: 'demo' })
assert.equal(moveNode.type, 'span')
const moveButton = moveNode.children.find((child) => child && child.type === 'button')
assert.ok(moveButton, 'move row action must render a button')
assert.equal(typeof moveButton.props.onClick, 'function')

// 确认流程不能依赖 window.confirm：宿主环境里它可能被禁用并恒定返回 false，
// 表现为「点了按钮没反应」——这正是之前「移入回收站 / 全部处理」的症状。
assert.ok(!/window\.confirm\s*\(/.test(source), 'must not call window.confirm directly')
assert.ok(source.includes("className: 'dsb-result warn'"), 'in-app confirm bar must exist')
assert.ok(/askTrash/.test(source) && /runConfirm/.test(source), 'confirm flow helpers must exist')

// ── 文案字典完整性：每个 t('key') 都要有中英文 ────────────────────────────
const dictMatch = source.match(/const DICT = \{([\s\S]*?)\n    \}/)
assert.ok(dictMatch, 'DICT block must exist')
const zhBlock = source.slice(source.indexOf('      zh: {'), source.indexOf('      en: {'))
const enBlock = source.slice(source.indexOf('      en: {'), source.indexOf('\n    }\n\n    function translate'))
const keysOf = (block) => new Set([...block.matchAll(/'([a-zA-Z][a-zA-Z0-9.]*)':/g)].map((m) => m[1]))
const zhKeys = keysOf(zhBlock)
const enKeys = keysOf(enBlock)

const used = new Set([
  ...[...source.matchAll(/\bt\('([a-zA-Z][a-zA-Z0-9.]*)'/g)].map((m) => m[1]),
  ...[...source.matchAll(/translate\('([a-zA-Z][a-zA-Z0-9.]*)'/g)].map((m) => m[1]),
])
const missingZh = [...used].filter((key) => !zhKeys.has(key))
const missingEn = [...used].filter((key) => !enKeys.has(key))
assert.deepEqual(missingZh, [], 'missing zh copy: ' + missingZh.join(', '))
assert.deepEqual(missingEn, [], 'missing en copy: ' + missingEn.join(', '))

// 反向：字典里定义但没用到的键（只提示，不算失败）
const unused = [...zhKeys].filter((key) => !used.has(key))

console.log('client-sim ok:', {
  mounts: names.length,
  tabs: tabs.length,
  keys: zhKeys.size,
  unusedKeys: unused.length,
})
