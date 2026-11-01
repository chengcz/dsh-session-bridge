// index.js — Host 半：装配 core，并按服务可用性注册工具 / 命令 / HTTP 路由
//
// tools / commands / webServer 都是可选 host 服务：声明成 inject 会让插件在缺服务的组合里
// 整体失活；这里用 ctx.inject 延迟挂载，服务缺席时其余能力照常工作。
import { SessionBridgeCore } from './lib/core.js'
import { registerCommands } from './lib/commands.js'
import { registerRoutes } from './lib/routes.js'
import { registerTools } from './lib/tools.js'

export const name = 'dsh-session-bridge'

export function apply(ctx, config) {
  const core = new SessionBridgeCore(ctx, config && typeof config === 'object' ? config : {})

  ctx.inject(['tools'], (toolCtx) => {
    registerTools(toolCtx, core)
  })

  registerCommands(ctx, core)

  ctx.inject(['webServer'], (webCtx) => {
    registerRoutes(webCtx.webServer, core)
  })
}
