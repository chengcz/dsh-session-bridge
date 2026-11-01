// lib/commands.js — 斜杠命令面（人触发、不占模型轮次）
//
// /history-export [format] [path]  —— 导出当前会话（format ∈ bundle / markdown / jsonl）
// /history-import <path> [--force] —— 从文件导入为可继续的会话
//
// commands 是可选 host 服务（headless / 无命令面板的组合不挂载），经 ctx.inject 延迟注册：
// 服务缺席时工具与路由照常可用。

function usageExport() {
  return '用法：/history-export [bundle|markdown|jsonl] [path]（path 省略 = $DSH_HOME/dsh-session-bridge/exports）'
}

export function registerCommands(ctx, core) {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'history-export',
      description: '把当前会话导出为文件（默认事件级无损的 .dshbundle.json，可被 /history-import 原样导回）。'
        + '用法：/history-export [bundle|markdown|jsonl] [path]',
      input: { hint: '[bundle|markdown|jsonl] [path]' },
      async handler(invocation) {
        const raw = String(invocation.rawInput || '').trim()
        const parts = raw ? raw.split(/\s+/) : []
        let format
        let path
        if (parts[0] === 'bundle' || parts[0] === 'markdown' || parts[0] === 'jsonl') {
          format = parts.shift()
        }
        if (parts.length > 0) path = parts.join(' ')
        const sessionId = invocation.agent && invocation.agent.id ? String(invocation.agent.id) : ''
        if (!sessionId) return { kind: 'error', text: '当前没有会话，无法导出' }
        try {
          const out = await core.exportSession({ sessionId, format, path })
          return {
            kind: 'success',
            text: '已导出（' + out.format + '，' + out.size + '）：' + out.path
              + '\n事件 ' + out.events + ' 条，消息 ' + out.messages + ' 条'
              + '\n内容指纹：' + out.fingerprint,
          }
        } catch (error) {
          return { kind: 'error', text: '导出失败：' + String((error && error.message) || error) }
        }
      },
    })

    commandCtx.commands.register({
      name: 'history-import',
      description: '从文件导入会话历史为可继续的 DSH 会话（支持 .dshbundle.json / interchange v1 JSON / DSH 会话 JSONL）。'
        + '同一段对话已导入过会被拦下；--force 另存副本。用法：/history-import <path> [--force]',
      input: { hint: '<path> [--force]' },
      async handler(invocation) {
        const raw = String(invocation.rawInput || '').trim()
        if (!raw) return { kind: 'error', text: '用法：/history-import <path> [--force]' }
        const force = /(^|\s)--force(\s|$)/.test(raw)
        const path = raw.replace(/(^|\s)--force(\s|$)/g, ' ').trim()
        if (!path) return { kind: 'error', text: '用法：/history-import <path> [--force]' }
        try {
          const out = await core.importFile({ path, force })
          if (out.status === 'duplicate') {
            return {
              kind: 'success',
              text: '未导入：这份对话已经导入过（已有会话 ' + out.duplicateOf + '）。要另存副本请加 --force。',
            }
          }
          return {
            kind: 'success',
            text: '已导入为会话 ' + out.sessionId + (out.title ? '（' + out.title + '）' : '')
              + '\n消息 ' + out.messages + ' 条，工具调用 ' + out.toolCalls + ' 次'
              + (out.forcedCopyOf ? '\n（force 副本，原会话：' + out.forcedCopyOf + '）' : ''),
          }
        } catch (error) {
          return { kind: 'error', text: '导入失败：' + String((error && error.message) || error) }
        }
      },
    })
  })
}

export { usageExport }
