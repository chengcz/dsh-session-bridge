// lib/index-store.js — 导入/导出索引（重复导入判定的账本）
//
// 账本只记「内容指纹 → 会话」与「导出流水」，不复制会话内容。导入前先查它：同一指纹已经
// 有活着的会话就拒绝再建一份——即使源文件被改名、挪了路径，甚至它就是上一次导入生成的
// 那份 DSH 会话日志（这正是 dsh-chat-import 里 import-import-* 链路的来源）。
// 索引丢失也不致命：调用方另有一层「目标 id 已存在 + 内容指纹相同」的兜底判定。
//
// 缓存按文件 mtime+size 失效：同一宿主里可能有多个插件实例（重载前后、多个窗口）在写同一
// 份账本，内存缓存不能假定自己是唯一写者——否则一次外部写入会让判重悄悄退化成兜底路径。
import { readJsonIfExists, writeFileAtomic, indexFile, statOrNull } from './util.js'

const MAX_EXPORTS = 200

function emptyIndex() {
  return { version: 1, imports: {}, exports: [] }
}

export class IndexStore {
  constructor() {
    this.cache = null
    this.stamp = null
    this.queue = Promise.resolve()
  }

  async load() {
    const info = await statOrNull(indexFile())
    const stamp = info ? info.mtimeMs + ':' + info.size : 'missing'
    if (this.cache && this.stamp === stamp) return this.cache
    const doc = await readJsonIfExists(indexFile())
    const index = emptyIndex()
    if (doc && typeof doc === 'object') {
      if (doc.imports && typeof doc.imports === 'object') index.imports = doc.imports
      if (Array.isArray(doc.exports)) index.exports = doc.exports.slice(-MAX_EXPORTS)
      if (Number.isSafeInteger(doc.version)) index.version = doc.version
    }
    this.cache = index
    this.stamp = stamp
    return index
  }

  /** 串行化读改写：并发导入/导出不会互相覆盖账本。 */
  async mutate(fn) {
    const run = this.queue.then(async () => {
      const index = await this.load()
      const result = await fn(index)
      await writeFileAtomic(indexFile(), JSON.stringify(index, null, 2) + '\n')
      // 写后作废时间戳：下一次 load() 重新 stat，读到别的实例的写入
      this.stamp = null
      return result
    })
    this.queue = run.catch(() => {})
    return run
  }

  async findImport(fingerprint) {
    const index = await this.load()
    return index.imports[fingerprint] || null
  }

  async recordImport(entry) {
    return this.mutate((index) => {
      index.imports[entry.fingerprint] = entry
      return entry
    })
  }

  async forgetImport(fingerprint) {
    return this.mutate((index) => {
      const existing = index.imports[fingerprint]
      delete index.imports[fingerprint]
      return existing || null
    })
  }

  async recordExport(entry) {
    return this.mutate((index) => {
      index.exports.push(entry)
      if (index.exports.length > MAX_EXPORTS) index.exports = index.exports.slice(-MAX_EXPORTS)
      return entry
    })
  }

  async listImports() {
    const index = await this.load()
    return Object.values(index.imports).sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0))
  }

  async listExports() {
    const index = await this.load()
    return index.exports.slice().reverse()
  }
}
