// lib/tools.js — Agent 工具面：导出会话、从文件导入、重复审计
//
// 三个工具共用 core 的编排；工具只负责参数归一与可读结果。导入工具**没有**「扫描 DSH
// 会话目录再全部导入」的入口：那正是旧插件把 import-* 会话再导入一遍、长出
// import-import-* 链路的原因。要迁移一份会话，导出成文件再导入即可，内容指纹会拦住重复。

const text = (value) => [{ type: 'text', text: value }]

/**
 * 工具返回值必须是「无损 JSON」：对象里带 undefined 的键会被宿主判成不可序列化，
 * 整次调用变成 "invalid output"。core 的返回值里有可选的 duplicateOf / forcedCopyOf，
 * 在边界上统一剥掉 undefined、把非有限数归一为 null。
 */
function jsonSafe(value, seen = new Set()) {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type !== 'object') return String(value)
  if (seen.has(value)) return null
  seen.add(value)
  let out
  if (Array.isArray(value)) {
    out = value.map((item) => jsonSafe(item, seen))
  } else {
    out = {}
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue
      out[key] = jsonSafe(value[key], seen)
    }
  }
  seen.delete(value)
  return out
}

function numberOrUndefined(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function registerTools(ctx, core) {
  ctx.tools.register({
    name: 'session_history_export',
    description: 'Export a DSH session history to a file (lossless .dshbundle.json by default, or Markdown / raw JSONL).'
      + ' Use all:true to export every session this plugin has imported, or pass sessionIds.'
      + ' 导出后可用 session_history_import 原样导回。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session id to export. Defaults to the current conversation.',
        },
        format: {
          type: 'string',
          enum: ['bundle', 'markdown', 'jsonl'],
          description: 'bundle = lossless .dshbundle.json (re-importable, default); markdown = readable .md; jsonl = raw session log.',
        },
        path: {
          type: 'string',
          description: 'Output directory (or an exact file path). Defaults to $DSH_HOME/dsh-session-bridge/exports.',
        },
        all: {
          type: 'boolean',
          description: 'Export every session this plugin imported before (batch).',
        },
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional explicit batch list (implies all).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string' },
          path: { type: 'string' },
          sessionId: { type: 'string' },
          bytes: { type: 'number' },
          exported: { type: 'number' },
        },
      },
      render(args, value) {
        if (!value || value.ok !== true) return text('导出失败：' + ((value && value.error) || '未知错误'))
        if (value.status === 'exported' && typeof value.exported === 'number' && typeof value.sessionId !== 'string') {
          return text('已导出 ' + value.exported + '/' + value.total + ' 个会话到 ' + value.dir
            + (value.failed ? '（失败 ' + value.failed + '）' : '')
            + (value.errors && value.errors.length ? '\n' + value.errors.map((e) => '  - ' + e.sessionId + '：' + e.error).join('\n') : ''))
        }
        return text('已导出会话 ' + (value.sessionId || '') + '（' + (value.format || 'bundle') + '，' + (value.size || '') + '）\n'
          + '文件：' + value.path + '\n'
          + '事件 ' + value.events + ' 条，消息 ' + value.messages + ' 条，工具调用 ' + value.toolCalls + ' 次\n'
          + '内容指纹：' + value.fingerprint)
      },
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const batch = input.all === true || Array.isArray(input.sessionIds)
      if (batch) {
        return jsonSafe(await core.exportAll({
          dir: input.path,
          format: input.format,
          sessionIds: Array.isArray(input.sessionIds) ? input.sessionIds.filter((id) => typeof id === 'string' && id) : undefined,
        }))
      }
      const sessionId = typeof input.sessionId === 'string' && input.sessionId
        ? input.sessionId
        : (exec && exec.agent && exec.agent.id ? String(exec.agent.id) : '')
      if (!sessionId) return { ok: false, error: '没有当前会话，请显式传 sessionId' }
      return jsonSafe(await core.exportSession({
        sessionId,
        format: input.format,
        path: typeof input.path === 'string' ? input.path : undefined,
      }))
    },
  })

  ctx.tools.register({
    name: 'session_history_import',
    description: 'Import a session history file as a new resumable DSH session.'
      + ' Accepts .dshbundle.json (this plugin or dsh-chat-import), interchange v1 JSON, and uncompressed DSH session JSONL.'
      + ' Pass paths:[...] to import several files in one call (each judged separately).'
      + ' Import is keyed by a content fingerprint: the same conversation is never imported twice unless force:true.'
      + ' 重复导入会被拦下并返回 duplicateOf。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path (or ~/path) of the session file to import.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Batch: several session files to import in one call (implies batch mode; each file is judged separately).',
        },
        force: {
          type: 'boolean',
          description: 'Import a copy even when the same conversation is already imported (returns forcedCopyOf).',
        },
        title: {
          type: 'string',
          description: 'Optional replacement title for the imported session.',
        },
        cwd: {
          type: 'string',
          description: 'Optional absolute working directory to group the new session under.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string' },
          sessionId: { type: 'string' },
          duplicateOf: { type: 'string' },
        },
      },
      render(args, value) {
        if (!value || value.ok !== true) return text('导入失败：' + ((value && value.error) || '未知错误'))
        if (value.status === 'batch') {
          const lines = (value.results || []).map((item) => {
            if (item.status === 'imported') return '  ✓ ' + item.path + ' → ' + item.sessionId
            if (item.status === 'duplicate') return '  · ' + item.path + ' → 已导入（' + item.duplicateOf + '）'
            return '  ✗ ' + item.path + ' → ' + (item.error || '失败')
          })
          return text('批量导入：共 ' + value.total + ' 个，导入 ' + value.imported
            + ' 个，重复 ' + value.duplicate + ' 个，失败 ' + value.failed + ' 个\n'
            + lines.join('\n'))
        }
        if (value.status === 'duplicate') {
          return text('未导入：这份对话已经导入过（已有会话 ' + value.duplicateOf
            + '，判定依据：' + (value.duplicateReason === 'source-session' ? '源会话内容一致' : '内容指纹一致') + '）。\n'
            + '要另存一份副本请用 force:true。')
        }
        return text('已导入为可继续的会话 ' + value.sessionId + '\n'
          + (value.title ? '标题：' + value.title + '\n' : '')
          + '来源：' + (value.sourceName || '') + '（' + (value.sourceKind || '') + '）\n'
          + '事件 ' + value.events + ' 条，消息 ' + value.messages + ' 条，工具调用 ' + value.toolCalls + ' 次\n'
          + '内容指纹：' + value.fingerprint
          + (value.forcedCopyOf ? '\n（force 副本，原会话：' + value.forcedCopyOf + '）' : ''))
      },
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      const paths = Array.isArray(input.paths)
        ? input.paths.map((item) => String(item || '').trim()).filter(Boolean)
        : []
      try {
        if (paths.length > 0) {
          return jsonSafe(await core.importFiles({
            paths,
            force: input.force === true,
            title: typeof input.title === 'string' ? input.title : undefined,
            cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
          }))
        }
        const path = typeof input.path === 'string' ? input.path.trim() : ''
        if (!path) return { ok: false, error: '缺少 path（要导入的文件）或 paths（批量）' }
        return jsonSafe(await core.importFile({
          path,
          force: input.force === true,
          title: typeof input.title === 'string' ? input.title : undefined,
          cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
        }))
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
  })

  ctx.tools.register({
    name: 'session_history_move',
    description: 'Move a session to another project: rewrites the header cwd, relocates the session'
      + ' directory under the target project and updates the projection cache. Live sessions are moved'
      + ' in place (no restart) when the persistence backend exposes a per-id write lock.'
      + ' 把会话移动到另一个 project（工作目录）；可先不传 cwd 看候选。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session id to move.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute target project path (e.g. /Users/me/work/another-project).',
        },
        list: {
          type: 'boolean',
          description: 'When true, only list candidate projects instead of moving anything.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string' },
          sessionId: { type: 'string' },
          cwd: { type: 'string' },
          projects: { type: 'array' },
        },
      },
      render(args, value) {
        if (!value || value.ok !== true) return text('移动失败：' + ((value && value.error) || '未知错误'))
        if (Array.isArray(value.projects)) {
          if (value.projects.length === 0) return text('没有可用的 project 候选。')
          return text('可用 project（会话数）：\n'
            + value.projects.slice(0, 20).map((project) => '  - ' + project.cwd + '（' + project.sessions + '）').join('\n'))
        }
        if (value.status === 'unchanged') return text('会话已经是这个 project 的了：' + value.cwd)
        return text('已移动会话 ' + value.sessionId + ' 到：' + value.cwd
          + (value.projectionUpdated === false ? '\n（投影缓存未更新，重启后按 header 重建）' : ''))
      },
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      try {
        if (input.list === true) {
          const out = await core.listProjects()
          return jsonSafe({ ok: true, projects: out.projects })
        }
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
        const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
        if (!sessionId) return { ok: false, error: '缺少 sessionId' }
        if (!cwd) {
          const out = await core.listProjects()
          return jsonSafe({ ok: false, error: '缺少 cwd（目标 project 的绝对路径）', projects: out.projects })
        }
        return jsonSafe(await core.moveSession({ sessionId, cwd }))
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
  })

  ctx.tools.register({
    name: 'session_history_audit',
    description: 'Read-only duplicate audit: fingerprint the sessions this plugin imported (plus the most recent ones) and report groups holding the same conversation.'
      + ' 只报告不删除；清理请用会话管理器。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum sessions to fingerprint (default 120, max 120).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          scanned: { type: 'number' },
          duplicateGroups: { type: 'number' },
          redundantSessions: { type: 'number' },
        },
      },
      render(args, value) {
        if (!value || value.ok !== true) return text('审计失败：' + ((value && value.error) || '未知错误'))
        if (value.duplicateGroups === 0) return text('没有发现重复会话（已扫描 ' + value.scanned + ' 个会话）')
        const lines = ['发现 ' + value.duplicateGroups + ' 组重复会话，冗余 ' + value.redundantSessions + ' 个（已扫描 ' + value.scanned + ' 个）：']
        for (const group of value.duplicates.slice(0, 8)) {
          lines.push('  · 指纹 ' + group.fingerprint.slice(0, 10) + '：' + group.sessions.length + ' 份')
          for (const session of group.sessions.slice(0, 6)) {
            lines.push('      ' + session.id + '  ' + (session.title || '(无标题)'))
          }
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      try {
        return jsonSafe(await core.audit({ limit: numberOrUndefined(input.limit) }))
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
  })
}
