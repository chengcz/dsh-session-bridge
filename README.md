# dsh-session-bridge · 会话桥

把 DSH 会话历史**导出成文件**，再**从文件导入**为可继续的会话；导入以**内容指纹**为键，
同一段对话不会被导入第二遍。自带**侧栏图形管理界面**（会话 / 导入 / 导出文件 / 重复检查 /
清理五个页签），也能把本机 **Claude Code、Codex** 的历史导入进来。

> 这是为修复 `dsh-chat-import` 的重复导入问题而写的独立插件（新包，不改旧包）。
> 旧包可以继续保留用于它的 29 种外部来源解析；本插件负责 DSH 侧的历史导出 / 导入与去重。

## 为什么旧插件会重复导入

在作者机器上的实测证据（`~/.dsh`）：

| 观测 | 数值 |
| --- | --- |
| `imports.json` 里的导入记录 | 654 条 |
| 会话投影缓存中的会话 | 735 个 |
| 其中 `import-import-*` | 477 个 |
| 其中 `import-import-import-*` | 230 个 |

原因：旧插件把「DSH 会话」也当成一种导入来源。它自己导入生成的会话（`import-<src>`）随后
被扫描器再次列出、再次导入，于是同一个 id 前缀被叠加成 `import-import-…`；旧插件的
「源未变」判定以**源路径 + stat** 为键，换了路径（或换了代次 / WAL 边车变化）就判不出
「这其实是同一段对话」，于是不断新建副本。

修复思路：判重不看路径、不看 stat、不看会话 id，而是看**模型真正看到的内容**——按角色
归一化后的文本、推理、工具调用名与参数、工具结果，算 SHA-256 内容指纹。无论这份对话是
bundle、interchange 文档、JSONL，还是旧插件刚导入生成的会话，指纹都一样，因此：

- 同一份文件重复导入 → 直接拦下，返回 `duplicateOf`；
- 导出后再导入、跨机器导入 → 只有第一次成功；
- 不提供「扫描 DSH 会话目录并全部导入」的入口，从源头上断掉 import-of-import 链路；
- `force: true` 才另存副本，并在结果里点名 `forcedCopyOf`。

## 功能

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 管理界面 | 侧栏的会话桥图标（`sidebar.panellist`）→ 全屏页；设置 → 会话桥 里有直达按钮 | 会话 / 导入 / 导出文件 / 重复检查 / 清理 五个页签，见下节 |
| 导出会话 | 管理界面「会话」页 / 会话行 hover 的 `↓` / 工具 `session_history_export` / `/history-export` | 默认事件级无损的 `.dshbundle.json`（可原样导回）；也可导出 Markdown 阅读版或原始 JSONL。**批量**：勾选后「导出选中」，或「导出全部已导入」；工具用 `all:true` / `sessionIds:[…]` |
| 会话预览 | 管理界面「会话」页的「预览」 | 不导出文件就能看消息数、工具调用数、事件数、cwd 与前若干条对话 |
| 按 project 分组 | 管理界面「会话」页 / 「导入 → 扫描来源」 | 会话按 **cwd（project）** 分组显示，组头带该组数量与「全选」；他源列表也按原 project 分组 |
| 移动会话归属 | 管理界面「会话」页每行的「移动」 | 把会话挪到另一个 project：分组目录搬迁 + header 的 `cwd` + 投影缓存三处同步，失败自动回滚 |
| 从文件导入 | 管理界面「导入」页 / 工具 `session_history_import` / `/history-import` | 支持 `.dshbundle.json`（本插件与 dsh-chat-import 的备份）、interchange v1 JSON、未压缩的 DSH 会话 JSONL；可先「先预览」再导入。**批量**：路径框一行一个、「选择文件…」可多选，或工具传 `paths:[…]`；逐条判重、逐条报结果 |
| 从其他 Agent 导入 | 管理界面「导入」→「扫描来源」 | 读本机 **Claude Code、Codex、zcode、opencode、mimocode、kilocode、Goose、Zed、Vibe** 的会话记录，转成可继续的 DSH 会话。**批量**：勾选（可按来源全选）后「导入选中」 |
| 导出文件浏览 | 管理界面「导出文件」页 | 列出导出目录里的文件（格式、大小、时间），bundle / JSONL 可一键送进导入流程 |
| 重复检查 | 管理界面「重复检查」页 / 工具 `session_history_audit` | 只读：按内容指纹分组报告冗余；每组可单独处理。**批量**：选保留策略 →「预览影响」摊开计划 →「全部处理」一次把每组多余的那些移入回收站 |
| 清理 | 管理界面「清理」页 | 待导入暂存件清理、回收站恢复 / 清空 |
| 导入历史 | 设置 → 会话桥「最近导入」 | 指纹、目标会话、来源文件、是否仍在 |

## 图形管理界面

侧栏面板列表里多了一个「会话桥」图标，点开后是全屏管理页。五个页签：

- **会话**：按 **project（cwd）分组**显示，组头有该组数量和「全选」；搜索（标题 / id）、筛选
  （全部 / 只看导入的 / 只看非导入的）、全选与勾选、批量导出（格式可选）、批量移入回收站、
  单条预览 / 导出 / **移动**；「导出全部已导入」不勾选也能一次全导。
- **导入**：① 文件——路径框**一行一个**，「选择文件…」支持**多选**，点「批量导入」逐条导入并
  逐条给出结果（已导入 / 重复 / 失败，单条失败不影响其余）；也可先「先预览」看会导入多少条、
  是否与已有会话重复。② 其他 Agent——「扫描来源」列出本机 Claude Code / Codex 的会话（标题、
  消息数、大小、时间、cwd），可勾选（按来源全选）后「导入选中」批量导入，或单条预览 / 导入。
- **导出文件**：默认导出目录（或指定的目录）里的文件清单，bundle / JSONL 一键跳转导入。
- **重复检查**：先跑指纹分组；选「保留策略」（优先原始 / 创建最早 / 创建最新）→「预览影响」
  摊开「留谁、删谁」→「全部处理」一次把每组多余的移入回收站。也可以逐个组单独处理。
- **清理**：暂存上传件（「选择文件…」的原始字节）与回收站（按批次恢复或清空）。

批量的语义统一是**逐条独立判定**：一条失败或判重不会中断其余，结果列表逐条给出状态与原因。

界面上所有数据都来自宿主半的 `POST /api-session-bridge/*`，与工具 / 斜杠命令共用同一个
`core`——所以界面里看到的判重结论，和工具执行的判重结论是同一个。

## 从其他 Agent 导入

「导入 → 扫描来源」读取下列 Agent 的历史（全部**只读**，不改对方任何文件）：

| 来源 | 位置 | 读取方式 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<项目>/<sessionId>.jsonl` | 逐行 `user` / `assistant`；`thinking` → 推理、`tool_use` → 工具调用、`tool_result` 回填到对应 step |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `response_item` 的 message / reasoning / function_call / function_call_output |
| zcode | `~/.zcode/cli/db/db.sqlite` | SQLite `session` / `message` / `part` 三表；`part.type` 为 `text` / `reasoning` / `tool`（`state.output` → 工具结果） |
| opencode | `~/.local/share/opencode/opencode.db` | 同 zcode 一族的结构 |
| mimocode | `~/.local/share/mimocode/mimocode.db` | 同上（`session` 表无 `model` 列也能读） |
| kilocode | `~/.local/share/kilo/kilo.db` | 同上 |
| Goose | `<data>/sessions/sessions.db`（macOS 在 `~/Library/Application Support/Block/goose`） | `sessions` 索引 + `messages.content_json` 块数组；`toolRequest` / `toolResponse` 配对 |
| Zed | `<data>/threads/threads.db`（macOS 在 `~/Library/Application Support/Zed`） | `threads.data` 是 **zstd** 压缩的线程 JSON，用 `node:zlib` 解压 |
| Mistral Vibe | `~/.vibe/logs/session/<session>/messages.jsonl` + `meta.json` | 逐行消息 + 元数据里的标题 / cwd |

所有来源都会先转成 interchange v1 文档，再交给和「从文件导入」完全相同的导入管道——因此
**同样受内容指纹保护**，同一段对话导入两次会被拦下。工具注入的假用户消息（`AGENTS.md`、
`<local-command-caveat>`、`<external_*>` 等）会跳过，不会污染标题与首个提问。

**尚未支持**（目录结构与解析复杂，建议先在原工具里导出成 JSON / JSONL 再用「从文件导入」）：
Cursor、Gemini CLI、Crush、Trae、Hermes、TeleAgent、Kimi、Grok。要加新来源只需在
`lib/agents.js` 的来源表里补一条读库/读文件函数。

## 回收站与清理

删除会话是**软删除**：会话目录与投影缓存被 `move` 到
`$DSH_HOME/dsh-session-bridge/trash/<时间戳>/`，并写一份 `manifest.json` 记录原路径，
「清理」页可以按批次原样恢复。正在被宿主打开的会话会被拒绝移动（返回原因，不静默失败）。

## 导入后的 project 归属

导入时会**沿用源会话自己的工作目录**（Claude Code 的 `cwd`、zcode 库里的 `session.directory`、
Codex 的 `meta.cwd`…），所以会话会直接落在对应的 project 分组里，不会全堆到一个「默认」项目下。

如果归属不对（例如源项目路径已经不存在、或者想把历史归档到别处），在「会话」页点该行的
**移动**，选一个已有 project 或直接填目标绝对路径。移动做三件事，且保持一致：

1. 把整个会话目录搬到 `$DSH_HOME/sessions/<新 cwd 的 slug>/<sessionId>/`；
2. 改写会话文件首行 header 的 `cwd`（压缩的仍按原编码写回，事件本体不重排）；
3. 同步投影缓存里的 `workingDirectory`（旧行 `seq` 递增），侧栏按新 project 显示。

搬目录失败会原样搬回；目标位置已有同名会话会直接拒绝（不覆盖）。正在使用的会话不允许移动。

> 移动/删除后侧栏可能仍显示旧位置，直到宿主重新加载会话列表（重启 DSH 生效）。


## 与旧插件的关系

- **不修改** `dsh-chat-import`：它是一个 2.9 万行的多来源解析器，把它的判重换掉会牵连 29 种
  来源的增量语义。本插件是独立的包，只接管「DSH 会话 ↔ 文件」这一段。
- 两者共用 interchange v1 / `.dshbundle.json` 的字段约定，旧插件的备份可以直接在本插件里
  导入（反之亦然）。
- 若仍要用旧插件导入外部 Agent（Claude / Codex / ChatGPT…），建议避开它的 `dsh` / `dsh4`
  来源——那正是「把自己导入的会话再导入一遍」的入口；DSH 会话之间的迁移用本插件。

## 文件格式

导出（`.dshbundle.json`）：

```jsonc
{
  "bundle": "dsh-session-bridge",
  "format": "dsh-session-v1",
  "version": 1,
  "exportedAt": 1767224650000,
  "source": { "sessionId": "...", "title": "...", "createdAt": 0, "cwd": "...", "formatVersion": 4, "events": 0 },
  "fingerprint": "<内容指纹 hex>",
  "log": "<首行 header + 逐行事件的会话日志>",
  "sha256": { "log": "<hex>", "bundle": "<hex>" }
}
```

导入时校验两层 sha256（截断 / 篡改会被拒绝），并把事件归一到宿主当前的会话格式代次
（V3 工具结果包装 ↔ V4 一级 tool 消息、`source.kind` 生产者名、`surfaceOp` 替换字段拼写）。

导入还接受：

- `interchange: "dsh-chat-import"` 的 v1 文档（`turns` IR）——会合成一份合法的 DSH 会话日志
  （system head、环境变更声明、工具调用在同一 step 内闭合、`stream: []`）；
- 未压缩的 DSH 会话 JSONL（`session.v4.jsonl` 一类，首行 header）。

## 数据与隐私

- 索引：`$DSH_HOME/dsh-session-bridge/index.json`（只有指纹、会话 id、来源文件名、计数，不含对话正文）。
- 默认导出目录：`$DSH_HOME/dsh-session-bridge/exports/`。
- 浏览器「选择文件…」的字节先暂存到 `$DSH_HOME/dsh-session-bridge/uploads/`，再从那里导入；
  导入成功或失败都保留原文件（「清理」页可一键清）。
- 回收站：`$DSH_HOME/dsh-session-bridge/trash/<时间戳>/`（会话目录 + 投影缓存 + `manifest.json`），
  恢复靠 manifest，清空才真正释放。
- 他源扫描缓存：`$DSH_HOME/dsh-session-bridge/agents-cache.json`（会话路径、标题、消息数、
  mtime+size 作为失效键；不含对话正文）。扫描只读对方目录，不写 Claude Code / Codex 的任何文件。

## 安装（本地目录）

```bash
dsh plugin --profile <profile> add /path/to/dsh-session-bridge
# 或在 Harness 里用 plugin_manager install_bundle，target 指向本目录
```

## 开发自检

```bash
node scripts/smoke.mjs       # 合成 → 指纹 → bundle 往返 → 篡改检测 → Markdown
node scripts/host-sim.mjs    # 假宿主：判重 / force 副本 / 导出落点 / 工具返回值 / 审计 / 索引跨实例可见
node scripts/manage-sim.mjs  # 管理界面后端：预览 / 导入前预览 / 导出清单 / 批量导出 / 回收站往返 / 暂存清理 / 他源导入
node scripts/client-sim.mjs  # 客户端：四个挂载点都注册、能渲染；文案键中英文齐全
```

### 验证记录

**2026-10-31（首版，设置页形态）**

- `smoke.mjs`：V3 与 V4 两种事件形状得到同一指纹；bundle 往返指纹不变；篡改 `log` 被拒。
- `host-sim.mjs`：源会话判重 → `force` 建副本 → 再导入按指纹拦截；工具返回值可无损 JSON
  往返；审计把「源 + 副本」分到同一组、跳过空会话；第二个实例立刻看见第一个实例写的账本。
- 真机（desktop profile）：
  - 导出 `import-import-01a000b7…`（137 事件 / 55 消息 / 34 工具调用）→ 再导入被拦
    （`源会话内容一致`）→ `force` 生成 `bridge-session-bridge-test` → 再导入被拦
    （`内容指纹一致`）。
  - interchange v1 文档导入 → 事件不变量全部成立：`seq` 连续、首个 surface 事件是
    `system/message`、`tool/result` 与其 `tool/call` 同 step、V4 一级 tool 消息、`stream: []`。
  - 路由 `/list` `/export` `/export-all` `/import` `/upload` `/audit` 全部 200。

**2026-11-01（图形管理界面 + 批量导入导出 + 其他 Agent 导入）**

- `manage-sim.mjs`（临时 `DSH_HOME` + 假宿主，全绿）：
  - 会话预览 6 条消息；导入前预览正确报出 `source-session` 重复。
  - 导出清单列出 bundle（`importable: true`，带 sessionId）；批量导出 Markdown 成功。
  - 回收站：移入后会话文件确实不在原位 → 列表可见 → 恢复后原样回到原位 → 再删一次 → 清空。
  - 暂存上传件清理；Claude Code fixture 解析 2 轮 / 6 消息 / 1 次工具调用 → 导入成功 →
    再次导入被判重拦下（`duplicate`）。
- `client-sim.mjs`：`main`、`sidebar.panellist`、`settings.section`、
  `sidebar.workspaces.session.row.action` 四个挂载点全部注册；管理页与设置页可渲染；
  侧栏入口渲染 svg、行内动作渲染 button；90 个文案键中英文齐全。
- 宿主约定核对（`app.asar` 内）：`main` 是 keyed slot，按 `key` 与侧栏面板 id 匹配，
  且 `ui-layout` 对 `main` 的 entries 做订阅，运行期新注册的面板会被保留；
  `sidebar.panellist` 的条目组件收到 `{ size, active }`。
- 真机其他 Agent 扫描（本机）：Claude Code 200 个会话、Codex 5 个会话；标题与消息数已按
  真实文件核对（工具注入的 `AGENTS.md` / `<local-command-caveat>` 不再当标题）。
- 批量能力（同一轮补测）：
  - 批量文件导入：2 个新 interchange 文件 → `imported 2 / duplicate 0 / failed 0`；再导一次 →
    `duplicate 2`；坏文件混在中间 → 该条 `failed`、其余照常。
  - 批量他源导入：2 条 Claude 日志 → 1 条新导入、1 条判重；逐条返回结果。
  - 批量去重：先造一组重复 → `dryRun` 得到 `groups 1 / wouldTrash 1` 且回收站为空（确认只算不动）
    → 执行后 `duplicateGroups` 归 0。
  - 工具面批量：`session_history_import` 传 `paths:[…]` 返回 `status: 'batch'`，且返回值可无损
    JSON 往返。
  - 假宿主改为**以磁盘为准**（list 过滤已移走的会话、create 时落盘），否则「删了还在」这类
    结论会被内存假象掩盖。
- 来源扩展（同轮）：本机真实扫描 Claude Code 200 / Codex 5 / **zcode 5** 个会话；zcode 真实库
  解析「移除 outcome_extractor…」会话（52 条消息）得到 15 轮、63 次工具调用，耗时 4ms；
  用最小 zcode fixture（自建 session/message/part 三表）验证 `preview → 导入 → 二次导入判重`
  全链，导入结果 3 条消息 / 1 次工具调用且工具名可预览；并断言导入后的会话 `cwd` 等于
  zcode 库里的 `session.directory`（落到源项目）。
- 排查：zcode 导入后**内容显示不出来**（工具输出一片空白、轮次错乱）。两个根因：
  1. `lib/synthesize.js` 里 `tool/result` 的 `content` 只接受**块数组**，而各来源读取器给的是
     字符串（zcode 的 `state.output`、Claude 的 `tool_result`、Codex 的 `output`）→
     `Array.isArray` 判空 → **工具结果全丢**。影响范围不止 zcode，是所有他源导入。
     修复：`toolResultBlocks()` 数组 / 字符串 / JSON 都认。
  2. zcode 用 `message.data.synthetic === true` + `visibility: 'model-only'` 标记注入消息
     （工具目录、TodoWrite 提醒），1266 条/库。之前只靠文本前缀猜，漏掉了它们，于是每条注入
     都变成一轮「用户提问」。修复：按 `synthetic` / `model-only` 过滤，part 级 synthetic 也跳过。
  修复后实测（真实库）：`sess_ead6b179…` 从 15 轮降到 **4 轮真实对话**、63 个工具结果
  **0 个为空**；`session_0235b2051b74…` 1 轮 / 32 个结果全部有内容、注入 0 条。
- UI 按钮排查（同轮）：
  - 「移入回收站」「全部处理」原先依赖 `window.confirm`。宿主环境里它可能被禁用并恒定返回
    false，表现就是**点了按钮毫无反应**。改为应用内确认条（页面顶部出现「确定把 N 个会话
    移入回收站？」+ 确认 / 取消），不再依赖原生对话框。
  - 会话行按钮在窄面板下互相挤压（`.dsb-item` 不换行）→ 允许换行、主内容给最小宽度。
  - 操作结果原先在滚动区顶部，操作后滚出视野，看起来像「点了没反应」→ 结果与确认条移出
    滚动区、常驻可见。
  - 「导出选中 / 导出全部已导入」语义修正：前者没勾选就不可点（不再悄悄导全部），后者明确
    导出全部已导入。
  - 扫描提速：列来源原本整份读会话文件（200 个 Claude 会话上百 MB，首次几十秒，期间按钮
    全是灰的）→ 只读文件头 256KB。首次扫描从数十秒降到 **21ms**（缓存清空后实测）。
  - **按钮「有框没字」**（截图确认：按钮尺寸正常、文字看不见）：主因是主按钮硬编码
    `color:#fff`，而宿主品牌色 `--dsw-alias-brand-primary` 在**深色主题下本身就是近白色**，
    配套的 `brand-text` 也是近白 → 白底白字。修复：主按钮改用「前景色当底、背景色当字」
    （`label-primary` / `bg-base`）这对天然互补的变量，任何主题都会反色可见；禁用态不再靠 `opacity`
    整体变淡（会连文字一起糊掉），改为显式的浅底 + 中灰字；`primary`/`danger` 这类通用类名
    加 `dsb-` 前缀，避免与宿主全局类同名；所有 `var()` 加兜底色，`-webkit-text-fill-color`
    显式设为 `currentColor`（宿主部分按钮用它把文字变透明）。
    截图复核：深色主题下 `brand-primary` 实测为近白色，「扫描来源」「导入这个文件」这类
    启用态主按钮正是白底白字；换成互补对后两者都可见。
- 同轮修掉的另一个隐患：会话文件是**多帧 zstd 顺序拼接**，`zstdDecompressSync` 只解第一帧
  （恰好是 header）。移动会话时若按「解压→改 header→重压」处理，会把后面所有事件写丢。
  现在逐帧解压、全量重压，并在测试里用两帧文件验证事件不丢。
- project 分组与移动（同轮）：
  - 本机真实 `$DSH_HOME` 上 `listProjects()` 列出 **14 个 project**（bioagent 370 个会话最多），
    耗时 8ms；cwd 是从会话 header 读回来的，不是从目录名反推。
  - `moveSession` 端到端：目录从旧 slug 搬到新 slug、header 的 `cwd` 改写后回读校验、事件行数
    不变、投影缓存 `workingDirectory.val` 跟随且 `seq` 递增；目标位置已有同名会话时**拒绝并
    保持原位**（不覆盖）。
- 像素级渲染仍**未**在真实窗口验证（GUI 需要 `dsh web` 打印的带 token URL，命令行无法取得
  token）；请以重启 DSH 后侧栏是否出现「会话桥」图标为准。

## 已知边界

- 不导入 `.zstd` 压缩的会话日志（需要额外解压依赖）：请先导出成 bundle 或未压缩 JSONL。
- 导入的是**新会话**，不会续写到已有会话；同一段对话续聊请直接在 DSH 里打开原会话。
- 重复审计默认只扫 120 个会话（已导入的优先），不会读整库几百个大日志。
- 其他 Agent 目前支持 **Claude Code、Codex、zcode、opencode、mimocode、kilocode、Goose、Zed、
  Vibe**；Cursor / Gemini CLI / Crush / Trae / Hermes / TeleAgent / Kimi / Grok 尚未实现
  （旧插件 `dsh-chat-import` 仍可处理它们，但请避开它的 `dsh` / `dsh4` 来源）。
- zcode / opencode 一族的库如果是 WAL 模式且原程序正在写入，读到的是已提交的快照；
  库被独占锁定时会报「打不开库」，关掉原程序再扫即可。
- 他源扫描单文件上限 48 MB，列表默认按修改时间取最近 40 条（总数仍会显示）。
- 回收站是**移动**不是删除：清空后才真正释放磁盘；移动后侧栏可能仍显示旧会话，直到宿主
  重新加载会话列表。
- 批量没有并发：文件 / 他源导入与去重都是顺序执行（逐条报错比并发快更重要），几百个会话的
  批处理会明显慢，界面上状态会一直停在「进行中」。
- 去重的「保留策略」只决定组内留哪一条，不会跨组比较；判重范围仍是审计的默认 120 个会话，
  要处理更多请先调大审计上限（工具 `session_history_audit` 的 `limit`）。

## License

本项目以 **MIT** 发布，全文见 [LICENSE](LICENSE)。

第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：

- `lib/synthesize.js` 的事件合成不变量与字段拼写**改编自**
  [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)（MIT，Copyright (c) 2026
  Nwflower, Scarlett）的 `lib/convert/events.mjs` / `lib/convert/shape.mjs`，属衍生作品，
  遵循同一 MIT 许可；
- `lib/agent-sources/` 下的 opencode 族 / Goose / Zed 读取器在阅读其对应源码后**独立重写**，
  同样在那里保留了原许可与版权声明。

其余代码为独立实现；各 Agent 的库结构、数据目录与字段名属于事实性信息。
