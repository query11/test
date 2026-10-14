# Claude Token Meter

一个油猴（Tampermonkey / Violentmonkey）用户脚本，在 claude.ai（包括 Claude Code 网页端 `claude.ai/code`）右下角浮动显示：

- **实时速度**（tok/s，2 秒滑动窗口）+ 速度曲线、峰值速度
- **本次 / 上次回复**的输出 token 数和平均速度（从第一个 token 开始计时，不含首 token 延迟）
- 当前会话累计的 **输入 / 输出 / 缓存读取 / 缓存写入 / 合计** token
- **当前上下文**大小（最近一条消息的 输入 + 缓存读 + 缓存写）
- `result` 事件里报告的费用（如果有）

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey。
2. 新建脚本，把 `claude-token-meter.user.js` 的内容整个粘进去保存。
3. 刷新 claude.ai 页面。

面板可以拖动标题栏移动，`–` 折叠（折叠时标题栏显示实时速度），`↺` 清零，`dbg` 开启调试日志。

## 原理

脚本在页面加载最早阶段挂钩 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`，只旁听数据、不修改请求。
从流过的 JSON / SSE / NDJSON 里识别：

| 事件 | 用途 |
| --- | --- |
| `message_start` / `message_delta` 的 `usage` | 精确 token 用量 |
| `content_block_delta` 的增量文本 | 实时速度（按字符估算，收到精确值后自动校准） |
| `type: "assistant"` 的 `message.usage` | 每条消息用量，按 `message.id` 去重 |
| `type: "result"` 的 `total_cost_usd` | 费用 |

一次性加载的历史记录（同一次响应里有多条消息，或时间戳超过 60 秒）只计入用量，不计入速度。切换会话时自动清零。

## 如果数字不动

claude.ai 前端的内部接口没有公开文档，可能和脚本假设的格式不同。排查方法：

1. 点 `dbg`，打开 DevTools 控制台，发一条消息，看有没有 `[token-meter]` 日志：
   - 有 `fetch` / `websocket` 行但没有事件类型行 → 数据格式不同（或是二进制），把一段原始数据贴出来即可适配；
   - 一行都没有 → 数据走了脚本没挂钩的通道。
2. 控制台里 `__ctm.state` 可以查看内部状态，`__ctm.ingest('<json 文本>')` 可以手动喂数据测试。

如果网页端只在每条消息结束后才下发完整结果（不逐字流式），“实时速度”会退化为按消息粒度更新。
