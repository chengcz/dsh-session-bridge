# Third-party notices

## dsh-chat-import

- Source: https://github.com/Nwflower/dsh-chat-import
- License: MIT
- Copyright (c) 2026 Nwflower
- Copyright (c) 2026 Scarlett

What is used, and how:

| 位置 | 关系 |
| --- | --- |
| `lib/synthesize.js` | 事件合成的不变量与字段拼写**改编自**其 `lib/convert/events.mjs` / `lib/convert/shape.mjs`（衍生） |
| `lib/agent-sources/opencode-family.js` | 参考了其 `lib/sources/opencode.mjs` 的表结构与字段映射，实现为独立重写 |
| `lib/agent-sources/goose.js` | 参考了其 `lib/sources/goose.mjs` 的块词汇与列名，实现为独立重写 |
| `lib/agent-sources/zed.js` | 参考了其 `lib/sources/zed.mjs` 的线程解码方式，实现为独立重写 |

同族读取器的库结构（`session` / `message` / `part` 三表）与各 Agent 的数据目录属于事实性
信息，不构成表达性内容的复制；但上述文件是在阅读其源码后编写的，因此在此保留其许可与版权
声明。本仓库其余代码为独立实现。

### MIT License (dsh-chat-import)

```
MIT License

Copyright (c) 2026 Nwflower
Copyright (c) 2026 Scarlett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
