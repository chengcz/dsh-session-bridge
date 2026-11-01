// client.js — 会话桥的管理界面
//
// 三处入口，同一套数据通道（宿主半注册的 POST /api-session-bridge/*）：
//   sidebar.panellist  侧栏的独立入口（图标），点开切到本插件的全屏页
//   main               全屏管理页：会话 / 导入 / 导出文件 / 重复检查 / 清理
//   settings.section   设置里的精简入口（说明 + 直达按钮 + 最近导入）
// 另外保留会话行 hover 的 ↓ 一键导出。
//
// 页面不读会话日志、不碰文件系统：所有列表与结果都来自路由返回的结构化数据，
// 这样「界面看到的」与「工具/命令做的」永远是同一份判断。
window.__ModuleLoader__.load({
  id: 'dsh-session-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const LOCALE_NS = 'dsh-session-bridge'
    const PANEL_ID = 'session-bridge'
    let localeSvc = null

    const DICT = {
      zh: {
        'section.title': '会话桥',
        'section.subtitle': '把会话历史导出成文件，或从文件导入为可继续的会话；同一段对话只会导入一次。',
        'section.open': '打开会话桥管理界面',
        'panel.title': '会话桥',
        'tab.sessions': '会话',
        'tab.import': '导入',
        'tab.exports': '导出文件',
        'tab.audit': '重复检查',
        'tab.cleanup': '清理',
        'sessions.search': '搜索标题或会话 id',
        'sessions.all': '全部会话',
        'sessions.imported': '只看导入的',
        'sessions.fresh': '只看非导入的',
        'sessions.selectAll': '全选',
        'sessions.selected': '已选 {n} 个',
        'sessions.export': '导出选中',
        'sessions.trash': '移入回收站',
        'sessions.exportAll': '导出全部已导入',
        'sessions.preview': '预览',
        'sessions.move': '移动',
        'sessions.noProject': '(无工作目录)',
        'move.title': '移动到 project',
        'move.hint': '目标目录必须是绝对路径；会话会整体搬到该 project 下（header 的 cwd 与投影缓存同步更新）。',
        'move.action': '移动',
        'move.busy': '移动中…',
        'move.projects': '现有 project',
        'move.pick': '选这个',
        'move.success': '已移动到 {cwd}',
        'move.cancel': '取消',
        'move.rowTitle': '移动到另一个 project',
        'move.current': '当前：{cwd}',
        'move.pathPlaceholder': '目标 project 的绝对路径',
        'sessions.empty': '没有匹配的会话',
        'sessions.loading': '正在读取会话列表…',
        'sessions.refresh': '刷新',
        'sessions.total': '共 {n} 个会话',
        'import.file': '从文件导入',
        'import.fileDesc': '支持 .dshbundle.json（本插件或 dsh-chat-import 的备份）、interchange v1 JSON、未压缩的 DSH 会话 JSONL。',
        'import.path': '文件路径',
        'import.pathPlaceholder': '例如 ~/Downloads/my-session.dshbundle.json',
        'import.pick': '选择文件…',
        'import.pathsHint': '每行一个路径，可一次导入多个文件',
        'import.batchAction': '批量导入',
        'import.batchBusy': '批量导入中…',
        'import.batchResult': '导入 {imported} 个，重复 {duplicate} 个，失败 {failed} 个',
        'import.statusImported': '已导入',
        'import.statusDuplicate': '重复',
        'import.statusFailed': '失败',
        'import.agentsSelectAll': '全选',
        'import.agentsSelected': '已选 {n} 条',
        'import.agentsImportSelected': '导入选中',
        'import.agentsImporting': '导入中…',
        'import.force': '另存副本（跳过重复检测）',
        'import.previewAction': '先预览',
        'import.action': '导入',
        'import.busy': '导入中…',
        'import.agents': '从其他 Agent 导入',
        'import.agentsDesc': '扫描本机上 Claude Code、Codex、zcode、opencode、Goose、Zed、Vibe 等 Agent 的会话记录，转成可继续的 DSH 会话（同样受内容指纹判重保护）。',
        'import.scan': '扫描来源',
        'import.scanning': '扫描中…',
        'import.noSources': '没有检测到可导入的来源目录。',
        'import.agentsMissing': '未检测到：{list}',
        'import.sourceEmpty': '这个来源下没有找到会话文件。',
        'import.agentPreview': '解析预览',
        'import.agentImport': '导入这条',
        'exports.title': '导出目录',
        'exports.empty': '这个目录里还没有导出文件。',
        'exports.importAction': '导入这个文件',
        'exports.bytes': '{n} 个文件，共 {size}',
        'exports.refresh': '刷新',
        'exports.notImportable': '不可导入（仅阅读）',
        'audit.title': '重复检查',
        'audit.desc': '对已导入的会话（以及最近的会话）按内容算指纹并分组，只报告不删除。',
        'audit.action': '开始检查',
        'audit.busy': '检查中…',
        'audit.none': '没有发现重复会话（已扫描 {n} 个）。',
        'audit.found': '发现 {g} 组重复、冗余 {r} 个（已扫描 {n} 个）：',
        'audit.keepNewest': '保留最早一条，其余移入回收站',
        'audit.strategy': '保留策略',
        'audit.keepOriginal': '优先保留原始（非副本）',
        'audit.keepEarliest': '保留创建最早的',
        'audit.keepNewestFirst': '保留创建最新的',
        'audit.previewAction': '预览影响',
        'audit.applyAction': '全部处理',
        'audit.planTitle': '将保留 {keep} 条，移入回收站 {drop} 个',
        'audit.noPlan': '没有可处理的重复组。',
        'audit.done': '已处理 {groups} 组，移入回收站 {n} 个',
        'cleanup.uploads': '待导入暂存件',
        'cleanup.uploadsDesc': '「选择文件…」上传的原始字节会先暂存在这里，导入成功或失败都保留。',
        'cleanup.uploadsEmpty': '没有暂存文件。',
        'cleanup.cleanUploads': '清理暂存件',
        'cleanup.trash': '回收站',
        'cleanup.trashDesc': '被移入回收站的会话与投影缓存；恢复后原样回到原位。',
        'cleanup.trashEmpty': '回收站是空的。',
        'cleanup.restore': '恢复',
        'cleanup.emptyTrash': '清空回收站（不可恢复）',
        'preview.title': '会话预览',
        'preview.importTitle': '导入预览',
        'preview.close': '关闭',
        'preview.loading': '读取中…',
        'preview.empty': '这个会话没有可显示的对话内容。',
        'preview.meta': '{messages} 条消息 · {tools} 次工具调用 · {events} 个事件',
        'preview.truncated': '只显示前 {n} 条（共 {total} 条）',
        'history.title': '最近导入',
        'history.empty': '还没有导入记录。',
        'history.alive': '会话仍在',
        'history.gone': '会话已删除',
        'export.action': '导出',
        'preview.duplicate': '重复：这段对话已经导入过（会话 {id}）',
        'preview.fresh': '可以导入：这段对话还没有导入过',
        'preview.willImport': '将导入 {messages} 条消息、{tools} 次工具调用',
        'result.imported': '已导入为会话 {id}',
        'result.duplicate': '未导入：这份对话已经导入过（会话 {id}）',
        'result.exported': '已导出到 {path}（{size}）',
        'result.exportedMany': '已导出 {n} 个会话到 {dir}',
        'result.trashed': '已移入回收站：{n} 个会话',
        'result.restored': '已恢复：{n} 个会话',
        'result.cleaned': '已清理 {n} 个文件（释放 {size}）',
        'result.error': '失败：{error}',
        'common.forceCopy': '要另存副本请勾选「另存副本」。',
        'common.none': '无',
        'common.cancel': '取消',
        'common.confirm': '确认',
        'common.confirmTrash': '确定把 {n} 个会话移入回收站？（可从「清理」页恢复）',
        'common.done': '完成',
        'sidebar.label': '会话桥',
      },
      en: {
        'section.title': 'Session Bridge',
        'section.subtitle': 'Export a session history to a file, or import one back as a resumable session. The same conversation is imported only once.',
        'section.open': 'Open the Session Bridge manager',
        'panel.title': 'Session Bridge',
        'tab.sessions': 'Sessions',
        'tab.import': 'Import',
        'tab.exports': 'Exports',
        'tab.audit': 'Duplicates',
        'tab.cleanup': 'Cleanup',
        'sessions.search': 'Search title or session id',
        'sessions.all': 'All sessions',
        'sessions.imported': 'Imported only',
        'sessions.fresh': 'Not imported',
        'sessions.selectAll': 'Select all',
        'sessions.selected': '{n} selected',
        'sessions.export': 'Export selected',
        'sessions.trash': 'Move to trash',
        'sessions.exportAll': 'Export all imported',
        'sessions.preview': 'Preview',
        'sessions.move': 'Move',
        'sessions.noProject': '(no working directory)',
        'move.title': 'Move to project',
        'move.hint': 'The target must be an absolute path. The session is relocated under that project (header cwd and projection cache are updated together).',
        'move.action': 'Move',
        'move.busy': 'Moving…',
        'move.projects': 'Existing projects',
        'move.pick': 'Use this',
        'move.success': 'Moved to {cwd}',
        'move.cancel': 'Cancel',
        'move.rowTitle': 'Move to another project',
        'move.current': 'Current: {cwd}',
        'move.pathPlaceholder': 'Absolute path of the target project',
        'sessions.empty': 'No matching session',
        'sessions.loading': 'Loading sessions…',
        'sessions.refresh': 'Refresh',
        'sessions.total': '{n} sessions',
        'import.file': 'Import from file',
        'import.fileDesc': 'Supports .dshbundle.json (this plugin or dsh-chat-import), interchange v1 JSON, and uncompressed DSH session JSONL.',
        'import.path': 'File path',
        'import.pathPlaceholder': 'e.g. ~/Downloads/my-session.dshbundle.json',
        'import.pick': 'Choose file…',
        'import.pathsHint': 'One path per line; import several files at once',
        'import.batchAction': 'Import batch',
        'import.batchBusy': 'Importing…',
        'import.batchResult': '{imported} imported, {duplicate} duplicates, {failed} failed',
        'import.statusImported': 'imported',
        'import.statusDuplicate': 'duplicate',
        'import.statusFailed': 'failed',
        'import.agentsSelectAll': 'Select all',
        'import.agentsSelected': '{n} selected',
        'import.agentsImportSelected': 'Import selected',
        'import.agentsImporting': 'Importing…',
        'import.force': 'Save a copy anyway (skip duplicate check)',
        'import.previewAction': 'Preview first',
        'import.action': 'Import',
        'import.busy': 'Importing…',
        'import.agents': 'Import from other agents',
        'import.agentsDesc': 'Scan Claude Code / Codex / zcode / opencode / Goose / Zed / Vibe session logs on this machine and turn them into resumable DSH sessions (fingerprint dedupe applies).',
        'import.scan': 'Scan sources',
        'import.scanning': 'Scanning…',
        'import.noSources': 'No importable source directory found.',
        'import.agentsMissing': 'Not found: {list}',
        'import.sourceEmpty': 'No session file under this source.',
        'import.agentPreview': 'Parse preview',
        'import.agentImport': 'Import this one',
        'exports.title': 'Export directory',
        'exports.empty': 'No exported file yet.',
        'exports.importAction': 'Import this file',
        'exports.bytes': '{n} files, {size}',
        'exports.refresh': 'Refresh',
        'exports.notImportable': 'Not importable (reading only)',
        'audit.title': 'Duplicate check',
        'audit.desc': 'Fingerprints imported sessions (plus recent ones) and groups identical conversations. Read-only.',
        'audit.action': 'Run check',
        'audit.busy': 'Checking…',
        'audit.none': 'No duplicates found ({n} scanned).',
        'audit.found': '{g} duplicate groups, {r} redundant sessions ({n} scanned):',
        'audit.keepNewest': 'Keep the earliest, trash the rest',
        'audit.strategy': 'Keep',
        'audit.keepOriginal': 'Prefer the original (non-copy)',
        'audit.keepEarliest': 'Keep the earliest created',
        'audit.keepNewestFirst': 'Keep the newest created',
        'audit.previewAction': 'Preview impact',
        'audit.applyAction': 'Resolve all',
        'audit.planTitle': 'Keep {keep}, trash {drop}',
        'audit.noPlan': 'Nothing to resolve.',
        'audit.done': 'Resolved {groups} groups, {n} sessions trashed',
        'cleanup.uploads': 'Staged uploads',
        'cleanup.uploadsDesc': 'Bytes chosen with "Choose file…" are staged here first; kept after success or failure.',
        'cleanup.uploadsEmpty': 'No staged file.',
        'cleanup.cleanUploads': 'Clean staged files',
        'cleanup.trash': 'Trash',
        'cleanup.trashDesc': 'Sessions moved to trash (plus their projection cache); restoring puts them back.',
        'cleanup.trashEmpty': 'Trash is empty.',
        'cleanup.restore': 'Restore',
        'cleanup.emptyTrash': 'Empty trash (irreversible)',
        'preview.title': 'Session preview',
        'preview.importTitle': 'Import preview',
        'preview.close': 'Close',
        'preview.loading': 'Loading…',
        'preview.empty': 'This session has no visible conversation.',
        'preview.meta': '{messages} messages · {tools} tool calls · {events} events',
        'preview.truncated': 'Showing first {n} of {total}',
        'history.title': 'Recent imports',
        'history.empty': 'Nothing imported yet.',
        'history.alive': 'session alive',
        'history.gone': 'session deleted',
        'export.action': 'Export',
        'preview.duplicate': 'Duplicate: this conversation is already imported (session {id})',
        'preview.fresh': 'Ready to import: this conversation is new',
        'preview.willImport': 'Will import {messages} messages, {tools} tool calls',
        'result.imported': 'Imported as session {id}',
        'result.duplicate': 'Not imported: this conversation is already imported (session {id})',
        'result.exported': 'Exported to {path} ({size})',
        'result.exportedMany': 'Exported {n} sessions to {dir}',
        'result.trashed': 'Moved {n} sessions to trash',
        'result.restored': 'Restored {n} sessions',
        'result.cleaned': 'Removed {n} files ({size})',
        'result.error': 'Failed: {error}',
        'common.forceCopy': 'Tick "Save a copy anyway" to keep a copy.',
        'common.none': 'none',
        'common.cancel': 'Cancel',
        'common.confirm': 'Confirm',
        'common.confirmTrash': 'Move {n} sessions to trash? (restorable from the Cleanup tab)',
        'common.done': 'Done',
        'sidebar.label': 'Session Bridge',
      },
    }

    function translate(key, vars) {
      let text = key
      try {
        if (localeSvc && typeof localeSvc.bind === 'function') text = localeSvc.bind(LOCALE_NS)(key)
      } catch {
        text = key
      }
      if (!text || text === key) text = DICT.zh[key] || key
      if (vars) {
        for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]))
      }
      return text
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!data) throw new Error('宿主返回了无法解析的响应（HTTP ' + response.status + '）')
      if (data.ok === false) throw new Error(data.error || ('HTTP ' + response.status))
      return data
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result || '')
          const comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    /** 会话按 project（cwd）分组：同一个工作目录的会话排在一起。 */
    function groupSessionsByProject(list) {
      const map = new Map()
      for (const session of list) {
        const cwd = session.cwd || ''
        if (!map.has(cwd)) map.set(cwd, [])
        map.get(cwd).push(session)
      }
      return [...map.entries()]
        .map(([cwd, sessions]) => ({ cwd, sessions, label: cwd || translate('sessions.noProject') }))
        .sort((a, b) => b.sessions.length - a.sessions.length)
    }

    function shortPath(path, max = 46) {
      const value = String(path || '')
      if (value.length <= max) return value
      return '…' + value.slice(value.length - max + 1)
    }

    const CSS = [
      '.dsb-root{display:flex;flex-direction:column;height:100%;min-height:0;padding:16px 20px 24px;color:var(--dsw-alias-label-primary,#1f2328);box-sizing:border-box;gap:12px;}',
      '.dsb-head h2{margin:0;font-size:17px;font-weight:600;letter-spacing:.01em;}',
      '.dsb-head p{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.dsb-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;}',
      '.dsb-tab{appearance:none;border:none;background:transparent;padding:8px 12px;font-size:13px;font-family:inherit;color:var(--dsw-alias-label-secondary,#5b6570);-webkit-text-fill-color:currentColor;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;}',
      '.dsb-tab:hover{color:var(--dsw-alias-label-primary);}',
      '.dsb-tab.on{color:var(--dsw-alias-brand-primary,#2f6fed);border-bottom-color:var(--dsw-alias-brand-primary,#2f6fed);font-weight:600;}',
      '.dsb-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:2px;}',
      '.dsb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
      '.dsb-card h3{margin:0;font-size:13px;font-weight:600;}',
      '.dsb-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.dsb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.dsb-resultbar{flex:none;}',
      '.dsb-grow{flex:1;min-width:0;}',
      '.dsb-input{flex:1 1 220px;min-width:160px;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;box-sizing:border-box;}',
      '.dsb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#2f6fed);}',
      '.dsb-textarea{flex:1 1 100%;min-height:64px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;line-height:1.5;resize:vertical;box-sizing:border-box;}',
      '.dsb-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#2f6fed);}',
      '.dsb-batch{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;max-height:260px;overflow-y:auto;}',
      '.dsb-select{height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;}',
      '.dsb-btn{height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#d6d9de);background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-primary,#1f2328);-webkit-text-fill-color:currentColor;font-size:13px;font-family:inherit;cursor:pointer;white-space:nowrap;line-height:1;display:inline-flex;align-items:center;justify-content:center;gap:4px;}',
      '.dsb-btn:hover{border-color:var(--dsw-alias-border-l2);}',
      '.dsb-btn:disabled{opacity:1;cursor:default;color:var(--dsw-alias-label-tertiary,#8a939c);background:var(--dsw-alias-bg-layer-1,#fafafa);border-color:var(--dsw-alias-border-l1,#e5e7eb);}',
      // 主按钮不用 brand-primary + 硬编码白字：深色主题下 brand-primary 本身就是近白色，
  // 白字会糊成一片。改用「前景色当底、背景色当字」这对天然互补的变量，任何主题都反色可见。
      '.dsb-btn.dsb-primary{background:var(--dsw-alias-label-primary,#1f2328);border-color:var(--dsw-alias-label-primary,#1f2328);color:var(--dsw-alias-bg-base,#fff);-webkit-text-fill-color:currentColor;}',
      '.dsb-btn.dsb-primary:disabled{background:var(--dsw-alias-bg-layer-2,#f2f3f5);border-color:var(--dsw-alias-border-l1,#e5e7eb);color:var(--dsw-alias-label-tertiary,#8a939c);-webkit-text-fill-color:currentColor;}',
      '.dsb-btn.dsb-danger{color:var(--dsw-alias-state-error-primary,#d93838);border-color:var(--dsw-alias-state-error-primary,#d93838);}',
      '.dsb-btn.sm{height:26px;padding:0 10px;font-size:12px;border-radius:7px;}',
      '.dsb-check{display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;}',
      '.dsb-result{font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);word-break:break-all;white-space:pre-wrap;flex:none;}',
      '.dsb-result.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dsb-result.warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dsb-result.ok{border-color:var(--dsw-alias-state-success-primary);}',
      '.dsb-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;}',
      '.dsb-item{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dsb-item:last-child{border-bottom:none;}',
      '.dsb-item:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dsb-item-main{flex:1 1 180px;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.dsb-item-title{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dsb-item-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dsb-tag{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex:none;}',
      '.dsb-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}',
      '.dsb-tag.gone{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
      '.dsb-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:10px 2px;}',
      '.dsb-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:6px;}',
      '.dsb-group + .dsb-group{margin-top:8px;}',
      '.dsb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;justify-content:flex-end;z-index:60;}',
      '.dsb-overlay.center{align-items:center;justify-content:center;}',
      '.dsb-dialog{width:min(520px,92vw);max-height:82vh;overflow-y:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px;}',
      '.dsb-dialog h3{margin:0;font-size:14px;font-weight:600;}',
      '.dsb-grouphead{display:flex;gap:8px;align-items:center;padding:6px 10px;background:var(--dsw-alias-bg-layer-2);border-radius:8px 8px 0 0;font-size:12px;}',
      '.dsb-grouphead .dsb-grow{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsb-drawer{width:min(560px,92vw);height:100%;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;}',
      '.dsb-drawer-head{display:flex;gap:10px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dsb-drawer-head h3{margin:0;font-size:14px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsb-drawer-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px 24px;display:flex;flex-direction:column;gap:10px;}',
      '.dsb-msg{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-base);}',
      '.dsb-msg-role{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);}',
      '.dsb-msg-text{font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;}',
      '.dsb-msg-tools{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
      '.dsb-src{margin-top:6px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:6px;}',
    ].join('\n')

    function useLocaleVersion() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        if (!localeSvc || typeof localeSvc.subscribe !== 'function') return undefined
        return localeSvc.subscribe(() => force((value) => value + 1))
      }, [])
    }

    function Card(props) {
      return h('section', { className: 'dsb-card' },
        h('h3', null, props.title),
        props.desc ? h('p', { className: 'dsb-desc' }, props.desc) : null,
        props.children)
    }

    function Tag(props) {
      return h('span', { className: 'dsb-tag ' + (props.kind || '') }, props.children)
    }

    function Result(props) {
      if (!props.state) return null
      return h('div', { className: 'dsb-result ' + (props.state.kind || '') }, props.state.text)
    }

    // ── 预览抽屉 ────────────────────────────────────────────────────────────

    function PreviewDrawer(props) {
      const { t } = props
      if (!props.open) return null
      const data = props.data
      return h('div', { className: 'dsb-overlay', onClick: props.onClose },
        h('div', { className: 'dsb-drawer', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'dsb-drawer-head' },
            h('h3', null, props.title),
            h('button', { type: 'button', className: 'dsb-btn sm', onClick: props.onClose }, t('preview.close'))),
          h('div', { className: 'dsb-drawer-body' },
            props.loading ? h('div', { className: 'dsb-empty' }, t('preview.loading')) : null,
            data && data.session
              ? h('p', { className: 'dsb-desc' },
                t('preview.meta', {
                  messages: data.session.messages,
                  tools: data.session.toolCalls,
                  events: data.session.events,
                }) + (data.session.cwd ? ' · ' + data.session.cwd : ''))
              : null,
            data && data.preview
              ? h('div', null,
                h('p', { className: 'dsb-desc' }, t('preview.willImport', {
                  messages: data.messages || 0,
                  tools: data.toolCalls || 0,
                })),
                h('div', { className: 'dsb-result ' + (data.duplicate ? 'warn' : 'ok') },
                  data.duplicate
                    ? t('preview.duplicate', { id: data.duplicate.sessionId })
                    : t('preview.fresh')))
              : null,
            data && Array.isArray(data.messages)
              ? (data.messages.length === 0
                ? h('div', { className: 'dsb-empty' }, t('preview.empty'))
                : data.messages.map((message, index) => h('div', { className: 'dsb-msg', key: index },
                  h('div', { className: 'dsb-msg-role' }, message.role),
                  message.text ? h('div', { className: 'dsb-msg-text' }, message.text) : null,
                  message.reasoning ? h('div', { className: 'dsb-msg-tools' }, '↳ ' + message.reasoning) : null,
                  message.tools ? h('div', { className: 'dsb-msg-tools' }, '⚙ ' + message.tools.join(', ')) : null)))
              : null,
            data && data.truncated
              ? h('div', { className: 'dsb-empty' }, t('preview.truncated', { n: data.messages.length, total: data.total }))
              : null))
      )
    }

    // ── 全屏管理页 ──────────────────────────────────────────────────────────

    function SessionBridgePage(props) {
      useLocaleVersion()
      const t = translate
      // props.initialTab 只给自检脚本用；宿主不传，默认落在「会话」页
      const [tab, setTab] = React.useState(props && props.initialTab ? props.initialTab : 'sessions')
      const [sessions, setSessions] = React.useState([])
      const [imports, setImports] = React.useState([])
      const [exportDir, setExportDir] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [scope, setScope] = React.useState('all')
      const [selected, setSelected] = React.useState([])
      const [format, setFormat] = React.useState('bundle')
      const [path, setPath] = React.useState('')
      const [force, setForce] = React.useState(false)
      const [preview, setPreview] = React.useState({ open: false, loading: false, data: null, title: '' })
      const [sources, setSources] = React.useState(null)
      const [exportFiles, setExportFiles] = React.useState(null)
      const [audit, setAudit] = React.useState(null)
      const [trash, setTrash] = React.useState(null)
      const [uploads, setUploads] = React.useState(null)
      const [batchResult, setBatchResult] = React.useState(null)
      const [agentSelected, setAgentSelected] = React.useState([])
      const [strategy, setStrategy] = React.useState('keep-original')
      const [plan, setPlan] = React.useState(null)
      const [projects, setProjects] = React.useState([])
      const [move, setMove] = React.useState({ open: false, sessionId: '', cwd: '', title: '' })
      const [confirm, setConfirm] = React.useState(null)
      const fileRef = React.useRef(null)

      const fail = (error) => setResult({ kind: 'error', text: t('result.error', { error: String((error && error.message) || error) }) })

      const refresh = React.useCallback(async (options) => {
        setLoading(true)
        try {
          const data = await post('/api-session-bridge/list')
          setSessions(Array.isArray(data.sessions) ? data.sessions : [])
          setImports(Array.isArray(data.imports) ? data.imports : [])
          setExportDir(data.exportDir || '')
          if (!(options && options.keepResult)) setResult(null)
        } catch (error) {
          fail(error)
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => { refresh(); loadProjects() }, [refresh])

      const loadTrash = async () => {
        try {
          const data = await post('/api-session-bridge/trash/list')
          setTrash(data)
        } catch (error) {
          fail(error)
        }
      }

      const loadUploads = async () => {
        try {
          const data = await post('/api-session-bridge/uploads')
          setUploads(data)
        } catch (error) {
          fail(error)
        }
      }

      const loadExports = async () => {
        setBusy('exports')
        try {
          const data = await post('/api-session-bridge/exports')
          setExportFiles(data)
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      React.useEffect(() => {
        if (tab === 'cleanup') { loadTrash(); loadUploads() }
        if (tab === 'exports') loadExports()
      }, [tab])

      // 筛选
      const needle = query.trim().toLowerCase()
      const visible = sessions.filter((session) => {
        if (scope === 'imported' && !session.imported) return false
        if (scope === 'fresh' && session.imported) return false
        if (!needle) return true
        return (session.title || '').toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle)
      })
      const selectedSet = new Set(selected)
      const toggle = (id) => {
        setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
      }
      const toggleGroup = (groupSessions) => {
        const ids = groupSessions.map((session) => session.id)
        const every = ids.every((id) => selectedSet.has(id))
        setSelected((prev) => (every
          ? prev.filter((id) => !ids.includes(id))
          : [...new Set([...prev, ...ids])]))
      }

      const toggleAll = () => {
        const allIds = visible.map((session) => session.id)
        const every = allIds.length > 0 && allIds.every((id) => selectedSet.has(id))
        setSelected(every ? [] : allIds)
      }

      const openSessionPreview = async (session) => {
        setPreview({ open: true, loading: true, data: null, title: session.title || session.id })
        try {
          const data = await post('/api-session-bridge/preview-session', { sessionId: session.id, limit: 80 })
          setPreview({ open: true, loading: false, data, title: data.session.title || session.id })
        } catch (error) {
          setPreview({ open: false, loading: false, data: null, title: '' })
          fail(error)
        }
      }

      const openImportPreview = async (filePath) => {
        setPreview({ open: true, loading: true, data: null, title: t('preview.importTitle') })
        try {
          const data = await post('/api-session-bridge/preview-import', { path: filePath })
          setPreview({ open: true, loading: false, data, title: data.title || t('preview.importTitle') })
        } catch (error) {
          setPreview({ open: false, loading: false, data: null, title: '' })
          fail(error)
        }
      }

      /** 路径框支持多行 / 分号分隔：一行一个文件。 */
      const splitPaths = (text) => String(text || '')
        .split(/[\n;]+/)
        .map((line) => line.trim())
        .filter(Boolean)

      /** 批量导入：逐条导入，逐条给结果（导入 / 重复 / 失败都不打断其余）。 */
      const runImportBatch = async (list) => {
        const paths = (Array.isArray(list) ? list : []).filter(Boolean)
        if (paths.length === 0) return
        setBusy('import-batch')
        setResult(null)
        setBatchResult(null)
        try {
          const data = await post('/api-session-bridge/import-batch', { paths, force })
          await refresh({ keepResult: true })
          setBatchResult(data)
          setResult({
            kind: data.failed > 0 ? 'warn' : 'ok',
            text: t('import.batchResult', {
              imported: data.imported,
              duplicate: data.duplicate,
              failed: data.failed,
            }),
          })
          if (data.imported > 0) setPath('')
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const runImport = async (filePath) => {
        const paths = splitPaths(filePath)
        if (paths.length === 0) return
        if (paths.length > 1) {
          await runImportBatch(paths)
          return
        }
        setBusy('import')
        setResult(null)
        setBatchResult(null)
        try {
          const data = await post('/api-session-bridge/import', { path: paths[0], force })
          await refresh({ keepResult: true })
          setBatchResult({ total: 1, imported: data.status === 'imported' ? 1 : 0, duplicate: data.status === 'duplicate' ? 1 : 0, failed: 0, results: [{ ...data, path: paths[0] }] })
          if (data.status === 'duplicate') {
            setResult({
              kind: 'warn',
              text: t('result.duplicate', { id: data.duplicateOf }) + ' ' + t('common.forceCopy'),
            })
          } else {
            setResult({ kind: 'ok', text: t('result.imported', { id: data.sessionId }) })
            setPath('')
          }
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const pickFile = () => {
        const input = fileRef.current
        if (!input) return
        input.value = ''
        input.click()
      }

      /** 选择文件支持多选：逐个上传暂存，再一次性批量导入。 */
      const onFileChosen = async (event) => {
        const files = event.target.files ? Array.from(event.target.files) : []
        if (files.length === 0) return
        setBusy('upload')
        setResult(null)
        setBatchResult(null)
        try {
          const uploaded = []
          for (const file of files) {
            const data = await fileToBase64(file)
            const out = await post('/api-session-bridge/upload', { name: file.name, data })
            uploaded.push(out.path)
          }
          setPath(uploaded.join('\n'))
          setBusy('')
          await runImportBatch(uploaded)
        } catch (error) {
          fail(error)
          setBusy('')
        }
      }

      const exportSelected = async (scope) => {
        // scope='all' 明确导出全部已导入；否则只导出勾选的（没勾选就什么都不做）
        const ids = scope === 'all' ? null : (selected.length > 0 ? selected : null)
        if (scope !== 'all' && !ids) return
        setBusy('export')
        setResult(null)
        try {
          const data = await post('/api-session-bridge/export-batch', ids ? { sessionIds: ids, format } : { format })
          setResult({ kind: 'ok', text: t('result.exportedMany', { n: data.exported, dir: data.dir }) })
          if (tab === 'exports') await loadExports()
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const exportOne = async (sessionId) => {
        setBusy('export:' + sessionId)
        setResult(null)
        try {
          const data = await post('/api-session-bridge/export', { sessionId, format })
          setResult({ kind: 'ok', text: t('result.exported', { path: data.path, size: data.size }) })
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      /** 不依赖 window.confirm：宿主环境里它可能被禁用并恒定返回 false（表现为点了没反应）。 */
      const askTrash = (ids) => {
        const list = Array.isArray(ids) ? ids : selected
        if (list.length === 0) return
        setConfirm({ kind: 'trash', ids: list, text: t('common.confirmTrash', { n: list.length }) })
      }

      const doTrash = async (ids) => {
        const list = Array.isArray(ids) ? ids : selected
        if (list.length === 0) return
        setBusy('trash')
        setResult(null)
        try {
          const data = await post('/api-session-bridge/trash', { sessionIds: list })
          await refresh({ keepResult: true })
          setSelected([])
          const skipped = Array.isArray(data.skipped) && data.skipped.length > 0
            ? '\n' + data.skipped.map((item) => item.sessionId + '：' + item.reason).join('\n')
            : ''
          setResult({ kind: 'ok', text: t('result.trashed', { n: data.trashed }) + skipped })
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const scanSources = async () => {
        setBusy('scan')
        setResult(null)
        try {
          const data = await post('/api-session-bridge/sources', { limit: 40 })
          setSources(data.sources || [])
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const previewAgent = async (source, session) => {
        setPreview({ open: true, loading: true, data: null, title: session.title || session.id })
        try {
          const data = await post('/api-session-bridge/import-source', {
            kind: source.kind, path: session.path, preview: true,
          })
          setPreview({
            open: true,
            loading: false,
            title: session.title || session.id,
            data: {
              preview: true,
              messages: data.turns || 0,
              toolCalls: 0,
              duplicate: null,
            },
          })
        } catch (error) {
          setPreview({ open: false, loading: false, data: null, title: '' })
          fail(error)
        }
      }

      const importAgent = async (source, session) => {
        setBusy('agent:' + session.path)
        setResult(null)
        try {
          const data = await post('/api-session-bridge/import-source', {
            kind: source.kind, path: session.path, force,
          })
          await refresh({ keepResult: true })
          if (data.status === 'duplicate') {
            setResult({
              kind: 'warn',
              text: t('result.duplicate', { id: data.duplicateOf }) + ' ' + t('common.forceCopy'),
            })
          } else {
            setResult({ kind: 'ok', text: t('result.imported', { id: data.sessionId }) })
          }
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const agentKeyOf = (source, session) => source.kind + '::' + session.path
      const parseAgentKey = (key) => {
        const index = String(key).indexOf('::')
        return index < 0
          ? { kind: '', path: String(key) }
          : { kind: String(key).slice(0, index), path: String(key).slice(index + 2) }
      }
      const toggleAgent = (key) => {
        setAgentSelected((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]))
      }
      const toggleAllAgents = (source) => {
        const keys = source.sessions.map((session) => agentKeyOf(source, session))
        const every = keys.length > 0 && keys.every((key) => agentSelected.includes(key))
        setAgentSelected((prev) => (every
          ? prev.filter((key) => !keys.includes(key))
          : [...new Set([...prev, ...keys])]))
      }

      const importAgentBatch = async (keys) => {
        const items = (Array.isArray(keys) ? keys : []).map(parseAgentKey).filter((item) => item.kind && item.path)
        if (items.length === 0) return
        setBusy('agent-batch')
        setResult(null)
        setBatchResult(null)
        try {
          const data = await post('/api-session-bridge/import-source-batch', { items, force })
          await refresh({ keepResult: true })
          setBatchResult(data)
          setResult({
            kind: data.failed > 0 ? 'warn' : 'ok',
            text: t('import.batchResult', {
              imported: data.imported,
              duplicate: data.duplicate,
              failed: data.failed,
            }),
          })
          setAgentSelected([])
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const previewDedupe = async () => {
        setBusy('plan')
        setResult(null)
        try {
          setPlan(await post('/api-session-bridge/audit/resolve', { strategy, dryRun: true }))
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      /** 先算一遍再让用户确认：确认条里必须是真实数量。 */
      const askDedupe = async () => {
        setBusy('plan')
        setResult(null)
        try {
          const preview = plan || await post('/api-session-bridge/audit/resolve', { strategy, dryRun: true })
          setPlan(preview)
          if (preview.wouldTrash === 0) {
            setResult({ kind: 'ok', text: t('audit.noPlan') })
            return
          }
          setConfirm({ kind: 'dedupe', text: t('common.confirmTrash', { n: preview.wouldTrash }) })
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const doDedupe = async () => {
        setBusy('resolve')
        setResult(null)
        try {
          const data = await post('/api-session-bridge/audit/resolve', { strategy })
          await refresh({ keepResult: true })
          setPlan(null)
          setAudit(null)
          const skipped = Array.isArray(data.skipped) && data.skipped.length > 0
            ? '\n' + data.skipped.map((item) => item.sessionId + '：' + item.reason).join('\n')
            : ''
          setResult({ kind: 'ok', text: t('audit.done', { groups: data.groups, n: data.trashed }) + skipped })
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const loadProjects = async () => {
        try {
          const data = await post('/api-session-bridge/projects')
          setProjects(Array.isArray(data.projects) ? data.projects : [])
        } catch {
          setProjects([])
        }
      }

      const openMove = (session) => {
        setMove({ open: true, sessionId: session.id, cwd: session.cwd || '', title: session.title || session.id })
        loadProjects()
      }

      const doMove = async () => {
        const cwd = String(move.cwd || '').trim()
        if (!cwd) return
        setBusy('move')
        setResult(null)
        try {
          const data = await post('/api-session-bridge/session/move', { sessionId: move.sessionId, cwd })
          setMove({ open: false, sessionId: '', cwd: '', title: '' })
          await Promise.all([refresh({ keepResult: true }), loadProjects()])
          if (data.status === 'unchanged') {
            setResult({ kind: 'ok', text: t('move.success', { cwd }) })
          } else {
            setResult({
              kind: 'ok',
              text: t('move.success', { cwd }) + (data.projectionUpdated === false ? '（投影缓存未能更新，重启后按 header 重建）' : ''),
            })
          }
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const runAudit = async () => {
        setBusy('audit')
        setAudit(null)
        try {
          setAudit(await post('/api-session-bridge/audit', {}))
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const cleanUploads = async () => {
        setBusy('cleanup')
        try {
          const data = await post('/api-session-bridge/cleanup/uploads', {})
          setResult({ kind: 'ok', text: t('result.cleaned', { n: data.removed, size: data.freed }) })
          await loadUploads()
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const emptyTrash = async () => {
        setBusy('empty')
        try {
          const data = await post('/api-session-bridge/trash/empty', {})
          setResult({ kind: 'ok', text: t('result.cleaned', { n: data.removed, size: data.freed }) })
          await loadTrash()
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const restoreBatch = async (batch) => {
        setBusy('restore:' + batch.id)
        try {
          const data = await post('/api-session-bridge/trash/restore', { batch: batch.id })
          setResult({ kind: 'ok', text: t('result.restored', { n: data.restored.length }) })
          await Promise.all([loadTrash(), refresh({ keepResult: true })])
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const TABS = [
        { id: 'sessions', label: t('tab.sessions') },
        { id: 'import', label: t('tab.import') },
        { id: 'exports', label: t('tab.exports') },
        { id: 'audit', label: t('tab.audit') },
        { id: 'cleanup', label: t('tab.cleanup') },
      ]

      const sessionsTab = () => h('div', { className: 'dsb-card' },
        h('div', { className: 'dsb-row' },
          h('input', {
            className: 'dsb-input',
            value: query,
            placeholder: t('sessions.search'),
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('select', { className: 'dsb-select', value: scope, onChange: (event) => setScope(event.target.value) },
            h('option', { value: 'all' }, t('sessions.all')),
            h('option', { value: 'imported' }, t('sessions.imported')),
            h('option', { value: 'fresh' }, t('sessions.fresh'))),
          h('button', { type: 'button', className: 'dsb-btn', onClick: () => refresh() }, t('sessions.refresh'))),
        h('div', { className: 'dsb-row' },
          h('label', { className: 'dsb-check' },
            h('input', { type: 'checkbox', checked: visible.length > 0 && visible.every((s) => selectedSet.has(s.id)), onChange: toggleAll }),
            t('sessions.selectAll')),
          h('span', { className: 'dsb-desc' }, t('sessions.selected', { n: selected.length })),
          h('select', { className: 'dsb-select', value: format, onChange: (event) => setFormat(event.target.value) },
            h('option', { value: 'bundle' }, 'bundle (.dshbundle.json)'),
            h('option', { value: 'markdown' }, 'markdown (.md)'),
            h('option', { value: 'jsonl' }, 'jsonl (.jsonl)')),
          h('button', {
            type: 'button',
            className: 'dsb-btn dsb-primary',
            disabled: busy !== '' || selected.length === 0,
            onClick: () => exportSelected('selected'),
          }, t('sessions.export') + (selected.length > 0 ? ' (' + selected.length + ')' : '')),
          h('button', { type: 'button', className: 'dsb-btn', disabled: busy !== '', onClick: () => exportSelected('all') },
            t('sessions.exportAll')),
          h('button', { type: 'button', className: 'dsb-btn dsb-danger', disabled: busy !== '' || selected.length === 0, onClick: () => trashSelected(selected) },
            t('sessions.trash') + (selected.length > 0 ? ' (' + selected.length + ')' : '')),
          h('span', { className: 'dsb-desc' }, exportDir ? t('sessions.total', { n: visible.length }) : '')),
        loading
          ? h('div', { className: 'dsb-empty' }, t('sessions.loading'))
          : visible.length === 0
            ? h('div', { className: 'dsb-empty' }, t('sessions.empty'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
              groupSessionsByProject(visible).map((group) => h('div', {
                key: group.cwd || '(none)',
                className: 'dsb-list',
              },
              h('div', { className: 'dsb-grouphead' },
                h('span', { className: 'dsb-grow', title: group.cwd }, shortPath(group.label, 60)),
                h('span', { className: 'dsb-desc' }, group.sessions.length + ' 个会话'),
                h('label', { className: 'dsb-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: group.sessions.every((session) => selectedSet.has(session.id)),
                    onChange: () => toggleGroup(group.sessions),
                  }),
                  t('sessions.selectAll'))),
              group.sessions.slice(0, 300).map((session) => h('div', { className: 'dsb-item', key: session.id },
                h('input', { type: 'checkbox', checked: selectedSet.has(session.id), onChange: () => toggle(session.id) }),
                h('div', { className: 'dsb-item-main' },
                  h('div', { className: 'dsb-item-title' }, session.title || '(无标题)'),
                  h('div', { className: 'dsb-item-meta' },
                    session.id
                    + (session.createdAt ? ' · ' + formatTime(session.createdAt) : '')
                    + (session.size ? ' · ' + session.size : ''))),
                session.imported ? h(Tag, { kind: 'ok' }, 'imported') : null,
                h('button', { type: 'button', className: 'dsb-btn sm', disabled: busy !== '', onClick: () => openSessionPreview(session) }, t('sessions.preview')),
                h('button', { type: 'button', className: 'dsb-btn sm', disabled: busy !== '', onClick: () => exportOne(session.id) },
                  busy === 'export:' + session.id ? '…' : t('sessions.export')),
                h('button', { type: 'button', className: 'dsb-btn sm', disabled: busy !== '', onClick: () => openMove(session) }, t('sessions.move'))))))))

      const importTab = () => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Card, { title: t('import.file'), desc: t('import.fileDesc') },
          h('div', { className: 'dsb-row' },
            h('textarea', {
              className: 'dsb-textarea',
              value: path,
              placeholder: t('import.pathPlaceholder'),
              spellCheck: false,
              onChange: (event) => setPath(event.target.value),
            })),
          h('div', { className: 'dsb-row' },
            h('button', { type: 'button', className: 'dsb-btn', onClick: pickFile, disabled: busy !== '' }, t('import.pick')),
            h('button', {
              type: 'button',
              className: 'dsb-btn',
              disabled: busy !== '' || !path.trim(),
              onClick: () => openImportPreview(splitPaths(path)[0]),
            }, t('import.previewAction')),
            // 只有一个路径时「导入」就是它自己，批量按钮没有意义，不占位
            splitPaths(path).length > 1
              ? h('button', {
                type: 'button',
                className: 'dsb-btn',
                disabled: busy !== '',
                onClick: () => runImportBatch(splitPaths(path)),
              }, busy === 'import-batch'
                ? t('import.batchBusy')
                : t('import.batchAction') + ' (' + splitPaths(path).length + ')')
              : null,
            h('button', {
              type: 'button',
              className: 'dsb-btn dsb-primary',
              disabled: busy !== '' || !path.trim(),
              onClick: () => runImport(path),
            }, busy === 'import' || busy === 'upload' ? t('import.busy') : t('import.action'))),
          h('div', { className: 'dsb-row' },
            h('label', { className: 'dsb-check' },
              h('input', { type: 'checkbox', checked: force, onChange: (event) => setForce(event.target.checked) }),
              t('import.force')),
            h('span', { className: 'dsb-desc' }, t('import.pathsHint'))),
          h('input', { ref: fileRef, type: 'file', multiple: true, style: { display: 'none' }, onChange: onFileChosen }),
          batchResult
            ? h('div', { className: 'dsb-batch' },
              batchResult.results.map((item, index) => h('div', { className: 'dsb-item', key: String(item.path || '') + index },
                h('div', { className: 'dsb-item-main' },
                  h('div', { className: 'dsb-item-title' }, shortPath(item.path || '', 72)),
                  h('div', { className: 'dsb-item-meta' },
                    item.status === 'imported'
                      ? t('import.statusImported') + ' · ' + (item.sessionId || '')
                      : item.status === 'duplicate'
                        ? t('import.statusDuplicate') + ' · ' + (item.duplicateOf || '')
                        : (item.error || t('import.statusFailed')))),
                h(Tag, { kind: item.status === 'imported' ? 'ok' : (item.status === 'duplicate' ? '' : 'gone') },
                  item.status === 'imported'
                    ? t('import.statusImported')
                    : (item.status === 'duplicate' ? t('import.statusDuplicate') : t('import.statusFailed'))))))
            : null),

        h(Card, { title: t('import.agents'), desc: t('import.agentsDesc') },
          h('div', { className: 'dsb-row' },
            h('button', { type: 'button', className: 'dsb-btn dsb-primary', disabled: busy !== '', onClick: scanSources },
              busy === 'scan' ? t('import.scanning') : t('import.scan')),
            h('span', { className: 'dsb-desc' }, t('import.agentsSelected', { n: agentSelected.length })),
            h('button', {
              type: 'button',
              className: 'dsb-btn',
              disabled: busy !== '' || agentSelected.length === 0,
              onClick: () => importAgentBatch(agentSelected),
            }, busy === 'agent-batch'
              ? t('import.agentsImporting')
              : t('import.agentsImportSelected') + ' (' + agentSelected.length + ')')),
          sources === null
            ? null
            : sources.every((source) => !source.available)
              ? h('div', { className: 'dsb-empty' }, t('import.noSources'))
              : sources.filter((source) => source.available).map((source) => h('div', { key: source.kind, className: 'dsb-src' },
                h('div', { className: 'dsb-row' },
                  h('b', { style: { fontSize: '12px' } }, source.label),
                  h('span', { className: 'dsb-desc' }, source.available ? (source.count + ' 个会话 · ' + source.hint) : '未检测到目录 (' + source.hint + ')'),
                  source.available && source.sessions.length > 0
                    ? h('label', { className: 'dsb-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: source.sessions.every((session) => agentSelected.includes(agentKeyOf(source, session))),
                        onChange: () => toggleAllAgents(source),
                      }),
                      t('import.agentsSelectAll'))
                    : null),
                source.available && source.sessions.length > 0
                  ? h('div', { style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '8px' } },
                    groupSessionsByProject(source.sessions).map((group) => h('div', { key: group.cwd || '(none)' },
                      h('div', { className: 'dsb-grouphead' },
                        h('span', { className: 'dsb-grow', title: group.cwd }, shortPath(group.label, 52)),
                        h('span', { className: 'dsb-desc' }, group.sessions.length + ' 个会话')),
                      h('div', { className: 'dsb-list' },
                        group.sessions.map((session) => h('div', { className: 'dsb-item', key: session.path },
                          h('input', {
                            type: 'checkbox',
                            checked: agentSelected.includes(agentKeyOf(source, session)),
                            onChange: () => toggleAgent(agentKeyOf(source, session)),
                          }),
                          h('div', { className: 'dsb-item-main' },
                            h('div', { className: 'dsb-item-title' }, session.title || session.id),
                            h('div', { className: 'dsb-item-meta' },
                              (session.size || '') + (session.messages ? ' · ≥' + session.messages + ' msgs' : '')
                              + (session.updatedAt ? ' · ' + formatTime(session.updatedAt) : ''))),
                          h('button', { type: 'button', className: 'dsb-btn sm', disabled: busy !== '', onClick: () => previewAgent(source, session) }, t('import.agentPreview')),
                          h('button', {
                            type: 'button',
                            className: 'dsb-btn sm',
                            disabled: busy !== '',
                            onClick: () => importAgent(source, session),
                          }, busy === 'agent:' + session.path ? '…' : t('import.agentImport'))))))))
              : h('div', { className: 'dsb-empty' }, t('import.sourceEmpty'))))),
          sources && sources.some((source) => source.available) && sources.some((source) => !source.available)
            ? h('div', { className: 'dsb-desc' }, t('import.agentsMissing', {
              list: sources.filter((source) => !source.available).map((source) => source.label).join('、'),
            }))
            : null)

      const exportsTab = () => h(Card, { title: t('exports.title'), desc: exportFiles ? t('exports.bytes', { n: exportFiles.total, size: exportFiles.bytes }) : '' },
        h('div', { className: 'dsb-row' },
          h('button', { type: 'button', className: 'dsb-btn', disabled: busy !== '', onClick: loadExports }, t('exports.refresh')),
          h('span', { className: 'dsb-desc', style: { wordBreak: 'break-all' } }, exportFiles ? exportFiles.dir : '')),
        !exportFiles || exportFiles.files.length === 0
          ? h('div', { className: 'dsb-empty' }, t('exports.empty'))
          : h('div', { className: 'dsb-list' },
            exportFiles.files.map((file) => h('div', { className: 'dsb-item', key: file.path },
              h('div', { className: 'dsb-item-main' },
                h('div', { className: 'dsb-item-title' }, file.title || file.name),
                h('div', { className: 'dsb-item-meta' },
                  file.format + ' · ' + file.size + (file.mtime ? ' · ' + formatTime(file.mtime) : ''))),
              file.importable
                ? h('button', {
                  type: 'button',
                  className: 'dsb-btn sm dsb-primary',
                  disabled: busy !== '',
                  onClick: () => { setTab('import'); setPath(file.path); openImportPreview(file.path) },
                }, t('exports.importAction'))
                : h(Tag, null, t('exports.notImportable'))))))

      const auditTab = () => h(Card, { title: t('audit.title'), desc: t('audit.desc') },
        h('div', { className: 'dsb-row' },
          h('label', { className: 'dsb-desc', style: { margin: 0 } }, t('audit.strategy')),
          h('select', { className: 'dsb-select', value: strategy, onChange: (event) => { setStrategy(event.target.value); setPlan(null) } },
            h('option', { value: 'keep-original' }, t('audit.keepOriginal')),
            h('option', { value: 'keep-earliest' }, t('audit.keepEarliest')),
            h('option', { value: 'keep-newest' }, t('audit.keepNewestFirst'))),
          h('button', { type: 'button', className: 'dsb-btn', disabled: busy !== '', onClick: runAudit },
            busy === 'audit' ? t('audit.busy') : t('audit.action')),
          h('button', { type: 'button', className: 'dsb-btn', disabled: busy !== '', onClick: previewDedupe },
            busy === 'plan' ? t('audit.busy') : t('audit.previewAction')),
          h('button', { type: 'button', className: 'dsb-btn dsb-danger', disabled: busy !== '', onClick: askDedupe },
            busy === 'resolve' ? t('audit.busy') : t('audit.applyAction'))),

        plan
          ? (plan.groups === 0
            ? h('div', { className: 'dsb-result ok' }, t('audit.noPlan'))
            : h('div', null,
              h('div', { className: 'dsb-result warn' }, t('audit.planTitle', {
                keep: plan.plan.length, drop: plan.wouldTrash, n: plan.scanned,
              })),
              plan.plan.slice(0, 20).map((entry) => h('div', { className: 'dsb-group', key: entry.fingerprint },
                h('b', null, '#' + entry.fingerprint.slice(0, 10)),
                h('div', { className: 'dsb-item-meta' }, '✓ ' + entry.keep.id + ' · ' + (entry.keep.title || '(无标题)')),
                entry.drop.map((session) => h('div', { key: session.id, className: 'dsb-item-meta' },
                  '✗ ' + session.id + ' · ' + (session.title || '(无标题)')))))))
          : null,

        audit
          ? audit.duplicates.length === 0
            ? h('div', { className: 'dsb-result ok' }, t('audit.none', { n: audit.scanned }))
            : h('div', null,
              h('div', { className: 'dsb-result warn' }, t('audit.found', {
                g: audit.duplicates.length, r: audit.redundantSessions, n: audit.scanned,
              })),
              audit.duplicates.slice(0, 20).map((group) => h('div', { className: 'dsb-group', key: group.fingerprint },
                h('b', null, '#' + group.fingerprint.slice(0, 10)),
                group.sessions.map((session) => h('div', { key: session.id, className: 'dsb-item-meta' },
                  session.id + ' · ' + (session.title || '(无标题)') + (session.imported ? ' · imported' : ''))),
                h('div', { className: 'dsb-row' },
                  h('button', {
                    type: 'button',
                    className: 'dsb-btn sm dsb-danger',
                    disabled: busy !== '',
                    onClick: () => askTrash(group.sessions.slice(1).map((session) => session.id)),
                  }, t('audit.keepNewest'))))))
          : null)

      const cleanupTab = () => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Card, { title: t('cleanup.uploads'), desc: t('cleanup.uploadsDesc') },
          h('div', { className: 'dsb-row' },
            h('button', { type: 'button', className: 'dsb-btn', disabled: busy !== '', onClick: cleanUploads }, t('cleanup.cleanUploads')),
            h('span', { className: 'dsb-desc' }, uploads ? (uploads.dir + ' · ' + uploads.files.length + ' 个文件') : '')),
          !uploads || uploads.files.length === 0
            ? h('div', { className: 'dsb-empty' }, t('cleanup.uploadsEmpty'))
            : h('div', { className: 'dsb-list' },
              uploads.files.slice(-20).reverse().map((file) => h('div', { className: 'dsb-item', key: file.path },
                h('div', { className: 'dsb-item-main' },
                  h('div', { className: 'dsb-item-title' }, file.name),
                  h('div', { className: 'dsb-item-meta' }, shortPath(file.path, 80))))))),

        h(Card, { title: t('cleanup.trash'), desc: t('cleanup.trashDesc') },
          h('div', { className: 'dsb-row' },
            h('button', { type: 'button', className: 'dsb-btn', disabled: busy !== '', onClick: loadTrash }, t('sessions.refresh')),
            h('button', { type: 'button', className: 'dsb-btn dsb-danger', disabled: busy !== '' || !trash || trash.batches.length === 0, onClick: emptyTrash }, t('cleanup.emptyTrash'))),
          !trash || trash.batches.length === 0
            ? h('div', { className: 'dsb-empty' }, t('cleanup.trashEmpty'))
            : trash.batches.map((batch) => h('div', { className: 'dsb-group', key: batch.id },
              h('div', { className: 'dsb-row' },
                h('b', null, batch.id),
                h('span', { className: 'dsb-desc' }, batch.sessions.length + ' 个会话'),
                h('button', {
                  type: 'button',
                  className: 'dsb-btn sm',
                  disabled: busy !== '',
                  onClick: () => restoreBatch(batch),
                }, t('cleanup.restore'))),
              batch.sessions.map((session) => h('div', { key: session.sessionId, className: 'dsb-item-meta' },
                session.sessionId + (session.size ? ' · ' + session.size : '')))))))

      const BODY = {
        sessions: sessionsTab,
        import: importTab,
        exports: exportsTab,
        audit: auditTab,
        cleanup: cleanupTab,
      }

      const runConfirm = async () => {
        const current = confirm
        setConfirm(null)
        if (!current) return
        if (current.kind === 'trash') await doTrash(current.ids)
        else await doDedupe()
      }

      const closeMove = () => setMove({ open: false, sessionId: '', cwd: '', title: '' })
      const projectRows = projects
        .filter((project) => project.cwd && project.cwd !== move.cwd)
        .slice(0, 30)
        .map((project) => h('div', { key: project.cwd, className: 'dsb-item' },
          h('div', { className: 'dsb-item-main' },
            h('div', { className: 'dsb-item-title', title: project.cwd }, shortPath(project.cwd, 58)),
            h('div', { className: 'dsb-item-meta' }, project.sessions + ' 个会话')),
          h('button', {
            type: 'button',
            className: 'dsb-btn sm',
            onClick: () => setMove({ ...move, cwd: project.cwd }),
          }, t('move.pick'))))

      return h('div', { className: 'dsb-root' },
        h('style', { 'data-dsb-style': 'page' }, CSS),
        h('div', { className: 'dsb-head' },
          h('h2', null, t('panel.title')),
          h('p', null, t('section.subtitle'))),
        h('div', { className: 'dsb-tabs' },
          TABS.map((item) => h('button', {
            key: item.id,
            type: 'button',
            className: 'dsb-tab' + (tab === item.id ? ' on' : ''),
            onClick: () => setTab(item.id),
          }, item.label))),
        h('div', { className: 'dsb-resultbar' }, Result({ state: result })),
        confirm
          ? h('div', {
            className: 'dsb-result warn',
            style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
          },
          h('span', { className: 'dsb-grow' }, confirm.text),
          h('button', { type: 'button', className: 'dsb-btn sm dsb-danger', onClick: runConfirm }, t('common.confirm')),
          h('button', { type: 'button', className: 'dsb-btn sm', onClick: () => setConfirm(null) }, t('common.cancel')))
          : null,
        h('div', { className: 'dsb-body' },
          (BODY[tab] || sessionsTab)()),
        h(PreviewDrawer, {
          open: preview.open,
          loading: preview.loading,
          data: preview.data,
          title: preview.title,
          t,
          onClose: () => setPreview({ open: false, loading: false, data: null, title: '' }),
        }),

        move.open
          ? h('div', {
            className: 'dsb-overlay center',
            onClick: closeMove,
          },
          h('div', { className: 'dsb-dialog', onClick: (event) => event.stopPropagation() },
            h('h3', null, t('move.title')),
            h('div', { className: 'dsb-desc' }, move.title),
            h('input', {
              className: 'dsb-input',
              value: move.cwd,
              placeholder: '/Users/me/work/project',
              spellCheck: false,
              onChange: (event) => setMove({ ...move, cwd: event.target.value }),
            }),
            h('div', { className: 'dsb-desc' }, t('move.hint')),
            projectRows.length > 0
              ? h('div', null,
                h('div', { className: 'dsb-desc', style: { marginTop: '4px' } }, t('move.projects')),
                h('div', { className: 'dsb-list', style: { marginTop: '6px', maxHeight: '220px', overflowY: 'auto' } }, projectRows))
              : null,
            h('div', { className: 'dsb-row', style: { justifyContent: 'flex-end' } },
              h('button', { type: 'button', className: 'dsb-btn', onClick: closeMove }, t('move.cancel')),
              h('button', {
                type: 'button',
                className: 'dsb-btn dsb-primary',
                disabled: busy !== '' || !move.cwd.trim(),
                onClick: doMove,
              }, busy === 'move' ? t('move.busy') : t('move.action')))))
        : null)
    }

    // ── 设置页里的精简入口 ──────────────────────────────────────────────────

    function SettingsPage() {
      useLocaleVersion()
      const t = translate
      const [imports, setImports] = React.useState([])
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        post('/api-session-bridge/list')
          .then((data) => setImports(Array.isArray(data.imports) ? data.imports : []))
          .catch((err) => setError(String((err && err.message) || err)))
      }, [])

      const openPanel = () => {
        try {
          if (ctxLayout && typeof ctxLayout.selectPanel === 'function') ctxLayout.selectPanel(PANEL_ID)
        } catch {
          // 没有 layout 服务：让用户走侧栏图标
        }
      }

      return h('div', { className: 'dsb-root', style: { height: 'auto', padding: '4px 2px 24px' } },
        h('style', { 'data-dsb-style': 'settings' }, CSS),
        h('div', { className: 'dsb-head' },
          h('h2', null, t('section.title')),
          h('p', null, t('section.subtitle'))),
        error ? h('div', { className: 'dsb-result error' }, error) : null,
        h('div', { className: 'dsb-row' },
          h('button', { type: 'button', className: 'dsb-btn dsb-primary', onClick: openPanel }, t('section.open'))),
        h(Card, { title: t('history.title') },
          imports.length === 0
            ? h('div', { className: 'dsb-empty' }, t('history.empty'))
            : h('div', { className: 'dsb-list' },
              imports.slice(0, 30).map((entry) => h('div', { className: 'dsb-item', key: entry.fingerprint },
                h('div', { className: 'dsb-item-main' },
                  h('div', { className: 'dsb-item-title' }, entry.title || entry.sourceName || entry.sessionId),
                  h('div', { className: 'dsb-item-meta' },
                    entry.sessionId + ' · ' + formatTime(entry.importedAt) + ' · ' + entry.messages + ' 条消息')),
                h(Tag, { kind: entry.alive ? 'ok' : 'gone' }, entry.alive ? t('history.alive') : t('history.gone')))))))
    }

    // 侧栏入口图标：书包/桥的极简线稿，避免依赖宿主的图标包。
    function PanelIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('path', { d: 'M3 8.5c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5' }),
      h('path', { d: 'M3 8.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5' }),
      h('path', { d: 'M3 11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5' }))
    }

    // 侧栏动作：会话行 hover 时的「移动到另一个 project」。
    // 不打开管理页，直接在行上弹出目标选择；所有点击都 stopPropagation，
    // 否则会冒泡到行本身把会话切换掉。
    function RowMoveButton(props) {
      useLocaleVersion()
      const [open, setOpen] = React.useState(false)
      const [cwd, setCwd] = React.useState('')
      const [projects, setProjects] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      const stop = (event) => { if (event && typeof event.stopPropagation === 'function') event.stopPropagation() }

      const openDialog = async (event) => {
        stop(event)
        setNote('')
        setOpen(true)
        setCwd('')
        try {
          const [projectData, listData] = await Promise.all([
            post('/api-session-bridge/projects'),
            post('/api-session-bridge/list'),
          ])
          setProjects(Array.isArray(projectData.projects) ? projectData.projects : [])
          const current = (Array.isArray(listData.sessions) ? listData.sessions : [])
            .find((session) => session.id === props.sessionId)
          if (current && current.cwd) setCwd(current.cwd)
        } catch (error) {
          setNote(String((error && error.message) || error))
        }
      }

      const close = (event) => {
        stop(event)
        setOpen(false)
        setNote('')
      }

      const run = async (event) => {
        stop(event)
        const target = cwd.trim()
        if (!target) return
        setBusy(true)
        setNote('')
        try {
          await post('/api-session-bridge/session/move', { sessionId: props.sessionId, cwd: target })
          setNote(translate('move.success', { cwd: target }))
          setTimeout(() => { setOpen(false); setNote('') }, 900)
        } catch (error) {
          setNote(String((error && error.message) || error))
        } finally {
          setBusy(false)
        }
      }

      const iconStyle = {
        width: '22px', height: '22px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', borderRadius: '6px', background: 'transparent', cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary, #5b6570)', fontSize: '13px', lineHeight: 1, padding: 0,
      }

      return h('span', { style: { display: 'inline-flex' } },
        h('button', {
          type: 'button',
          title: translate('move.rowTitle') + ' · ' + (props.displayTitle || props.sessionId || ''),
          onClick: openDialog,
          style: iconStyle,
        }, '⇥'),
        open
          ? h('div', {
            style: {
              position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
            onClick: close,
          },
          h('div', {
            style: {
              width: 'min(520px, 92vw)', maxHeight: '82vh', overflowY: 'auto', padding: '16px',
              display: 'flex', flexDirection: 'column', gap: '10px', borderRadius: '14px',
              background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #1f2328)',
              border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
            },
            onClick: stop,
          },
          h('div', { style: { fontSize: '14px', fontWeight: 600 } }, translate('move.rowTitle')),
          props.displayTitle
            ? h('div', { style: { fontSize: '12px', opacity: .7 } }, props.displayTitle)
            : null,
          cwd
            ? h('div', { style: { fontSize: '12px', opacity: .7 } }, translate('move.current', { cwd }))
            : null,
          h('input', {
            style: {
              height: '32px', padding: '0 10px', borderRadius: '8px', fontSize: '13px',
              border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
              background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit',
            },
            value: cwd,
            placeholder: translate('move.pathPlaceholder'),
            spellCheck: false,
            onClick: stop,
            onChange: (event) => setCwd(event.target.value),
          }),
          projects.length > 0
            ? h('div', {
              style: {
                display: 'flex', flexDirection: 'column', maxHeight: '240px', overflowY: 'auto',
                border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', borderRadius: '10px',
              },
            },
            projects
              .filter((project) => project.cwd && project.cwd !== cwd)
              .slice(0, 30)
              .map((project) => h('div', {
                key: project.cwd,
                style: {
                  display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 10px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', fontSize: '12px',
                },
              },
              h('span', {
                title: project.cwd,
                style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, shortPath(project.cwd, 52)),
              h('span', { style: { opacity: .6, fontSize: '11px' } }, String(project.sessions)),
              h('button', {
                type: 'button',
                onClick: (event) => { stop(event); setCwd(project.cwd) },
                style: {
                  height: '24px', padding: '0 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px',
                  border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
                  background: 'var(--dsw-alias-bg-layer-2, #f2f3f5)', color: 'inherit',
                },
              }, translate('move.pick')))))
            : null,
          note ? h('div', { style: { fontSize: '12px' } }, note) : null,
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h('button', {
              type: 'button',
              onClick: close,
              style: {
                height: '30px', padding: '0 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px',
                border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
                background: 'var(--dsw-alias-bg-layer-2, #f2f3f5)', color: 'inherit',
              },
            }, translate('move.cancel')),
            h('button', {
              type: 'button',
              disabled: busy || !cwd.trim(),
              onClick: run,
              style: {
                height: '30px', padding: '0 14px', borderRadius: '8px', fontSize: '13px',
                cursor: busy || !cwd.trim() ? 'default' : 'pointer',
                border: '1px solid var(--dsw-alias-label-primary, #1f2328)',
                background: 'var(--dsw-alias-label-primary, #1f2328)',
                color: 'var(--dsw-alias-bg-base, #fff)',
                opacity: busy || !cwd.trim() ? .55 : 1,
              },
            }, busy ? translate('move.busy') : translate('move.action')))))
        : null)
    }

    // 侧栏动作：会话行 hover 时一键把这条会话导出成 bundle。
    function RowExportButton(props) {
      useLocaleVersion()
      const [state, setState] = React.useState('idle')
      const onClick = async (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        if (state === 'busy') return
        setState('busy')
        try {
          await post('/api-session-bridge/export', { sessionId: props.sessionId, format: 'bundle' })
          setState('done')
          setTimeout(() => setState('idle'), 1600)
        } catch {
          setState('error')
          setTimeout(() => setState('idle'), 2400)
        }
      }
      const label = state === 'done' ? '✓' : state === 'error' ? '!' : '↓'
      return h('button', {
        type: 'button',
        title: translate('export.action') + ' · ' + (props.displayTitle || props.sessionId || ''),
        onClick,
        style: {
          width: '22px', height: '22px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', borderRadius: '6px', background: 'transparent', cursor: 'pointer',
          color: state === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
          fontSize: '13px', lineHeight: 1, padding: 0,
        },
      }, label)
    }

    let ctxLayout = null

    function apply(ctx) {
      try {
        const locale = ctx.get('locale')
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          localeSvc = locale
          ctx.effect(() => locale.register(LOCALE_NS, { zh: DICT.zh, en: DICT.en }))
        }
      } catch {
        // locale 服务缺席：退回内置中文文案
      }

      // layout 服务可能晚于本插件就绪，所以在需要时再取一次（见 openPanel）
      const grabLayout = () => {
        try {
          const layout = ctx.get('layout')
          if (layout && typeof layout.selectPanel === 'function') ctxLayout = layout
        } catch {
          // 没有 layout 服务：用户走侧栏图标
        }
      }
      grabLayout()
      ctx.effect(() => {
        const timer = setTimeout(grabLayout, 1000)
        return () => clearTimeout(timer)
      })

      // 全屏管理页：key 与侧栏面板 id 相同，宿主据此把两者绑在一起
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
      }, SessionBridgePage))

      // 侧栏独立入口
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label: () => translate('sidebar.label'),
        locale: LOCALE_NS,
      }, PanelIcon))

      // 设置页入口（精简版）
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: PANEL_ID,
        order: 22,
        label: () => translate('section.title'),
      }, SettingsPage))

      // 会话行 hover 的一键导出
      ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action',
        id: 'session-bridge.export',
        order: 300,
      }, RowExportButton))

      // 会话行 hover 的「移动到另一个 project」
      ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action',
        id: 'session-bridge.move',
        order: 301,
      }, RowMoveButton))
    }

    return { name: 'dsh-session-bridge', inject: ['slots', 'locale'], apply }
  },
})
