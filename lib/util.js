// lib/util.js — 路径、哈希、原子写与展示格式的小工具（纯函数 + fs，无宿主依赖）
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, posix, win32 } from 'node:path'

/** DSH 数据根：宿主进程通常已设置 DSH_HOME；否则按默认布局回退。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env.trim() ? env.trim() : join(homedir(), '.dsh')
}

/** 本插件自己的数据目录（导入索引、暂存上传、默认导出目录都在这里）。 */
export function bridgeHome() {
  return join(dshHome(), 'dsh-session-bridge')
}

export function defaultExportDir() {
  return join(bridgeHome(), 'exports')
}

export function indexFile() {
  return join(bridgeHome(), 'index.json')
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function shortHash(text, length = 10) {
  return sha256(text).slice(0, length)
}

/** 读文本；文件不存在 / 读不了返回 null（调用方据此区分「空」与「缺失」）。 */
export async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

export async function readJsonIfExists(file) {
  const text = await readTextIfExists(file)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 原子写：同目录临时文件 + rename，避免半截文件被当成有效索引/导出。 */
export async function writeFileAtomic(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

export async function statOrNull(target) {
  try {
    return await stat(target)
  } catch {
    return null
  }
}

export async function listDirSafe(target) {
  try {
    return await readdir(target, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 用户输入的路径归一：展开 `~`，相对路径按 cwd 解析，去掉结尾分隔符。
 * 不检查存在性（调用方自行 stat）——但拒绝空串。
 */
export function normalizeInputPath(input, cwd = process.cwd()) {
  let p = String(input || '').trim()
  if (!p) return ''
  if (p === '~') p = homedir()
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2))
  if (!isAbsolute(p)) p = join(cwd, p)
  return p.replace(/[/\\]+$/, '') || p
}

/** 跨平台安全的文件名片段：去掉路径分隔符 / 控制字符 / 保留字符，限长。 */
export function safeFileName(name, fallback = 'session') {
  const raw = String(name || '')
  const base = basename(raw.replace(/\\/g, '/'))
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned
}

/** 会话 id 允许的字符（宿主 id 是品牌字符串，实际约束在 `/^[A-Za-z0-9._-]+$/`）。 */
export function slugifySessionId(text, fallback = 'session') {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return slug || fallback
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB'
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MiB'
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GiB'
}

export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 规范化 JSON：对象键排序、丢弃 undefined，供指纹与 bundle 自校验共用。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']'
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

/** 扩展名判定（大小写无关）。 */
export function extLower(file) {
  return extname(String(file || '')).toLowerCase()
}

/** 跨平台路径拼接（导出文件落点可能在另一台机器上被导入，只做字符串层面拼接）。 */
export function joinPath(dir, file) {
  if (dir.includes('\\') && !dir.includes('/')) return win32.join(dir, file)
  if (dir.includes('\\')) return dir.replace(/[\\/]+$/, '') + '\\' + file
  return posix.join(dir, file)
}
