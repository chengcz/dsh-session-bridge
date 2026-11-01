// scripts/move-session.mjs — 命令行移动会话到另一个 project（离线兜底，不经宿主）
//
// 用法：
//   node scripts/move-session.mjs --list                列出候选 project
//   node scripts/move-session.mjs <sessionId> <目标绝对路径>
//
// 建议先关闭该会话：这个脚本在宿主外运行，拿不到持久化的按 id 写锁，
// 若会话正在写盘，可能和宿主抢同一个文件。GUI / 工具路径会做这项检查。
import { listProjects, moveSessionToProject } from '../lib/session-move.js'

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log('用法:')
  console.log('  node scripts/move-session.mjs --list')
  console.log('  node scripts/move-session.mjs <sessionId> <目标绝对路径>')
  process.exit(0)
}

if (args[0] === '--list') {
  const projects = await listProjects({})
  console.log('project 候选（会话数）：')
  for (const project of projects) console.log('  ' + String(project.sessions).padStart(4) + '  ' + project.cwd)
  process.exit(0)
}

const [sessionId, cwd] = args
if (!sessionId || !cwd) {
  console.error('缺少参数：node scripts/move-session.mjs <sessionId> <目标绝对路径>')
  process.exit(1)
}

try {
  const out = await moveSessionToProject({ ctx: null }, sessionId, cwd)
  console.log(JSON.stringify(out, null, 2))
} catch (error) {
  console.error('移动失败：' + String((error && error.message) || error))
  process.exit(1)
}
