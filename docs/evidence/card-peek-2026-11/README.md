# 首页会话卡长按展开最近消息 · Before / After

用户先在 Tailscale 原型里逐条确认了卡片高度、放大内容、上下手势和选中文字修正，再批准落到真实 PWA。
这组图是真实 `web/app.js` + `web/style.css` 的 Chromium 截图，不是设计稿。

## 结论

- **Before**（`origin/main` @ `02eb814`）：首页长按一张会话卡没有任何预览；只有卡片自身的最后一条摘要。
- **After**（本分支，视觉代码 @ `8576106`；展开实现见 `59eefc5`，后续 `8576106` 只加内联改名排除并把 `session/page` 尾部窗口从 32 提到 64，不改变视觉）：按住 0.38 秒，卡片从列表原位长到接近满屏，标题和最近 8 条用户/助手文字消息一起放大；保持按住上滑打开、下滑关闭，中间松手取消。轻点、⋯ 菜单和内联改名仍保持原行为。

## 文件

| 文件 | 说明 |
|---|---|
| `before-390.png` | 390×844 浅色，`origin/main`，同一合成会话，静止状态 |
| `after-390.png` | 390×844 浅色，本分支，按住第一张卡 0.38 秒后的展开状态 |
| `after-open-armed-390.png` | 390×844 浅色，继续上滑越过阈值，HUD 进入「松开即生效」 |
| `after-320.png` | 320×568 窄屏检查，卡片高 440，无横向溢出 |
| `after-390-dark.png` | 390×844 深色主题的同一展开状态 |

## 方法

- 运行环境：本机 Chromium（Playwright），390×844 / DPR 2 / 浅色，`colorScheme: light`；320 与深色图使用同一套。
- **宿主**：本地 stub 服务器提供真实的 `web/` 静态壳，并合成三个接口：`session/list`（两张虚构会话）、`session/page`（虚构对话，`peek-1` 为运行中、`peek-2` 为已完成）、`workspace/archiveSession`（返回被归档的 sid）；`/api/remote.mux` 只保持连接。没有读取任何真实会话、工作区或消息。
- **Before**：页面仍由真实壳加载，但 `/m/app.js` 与 `/m/style.css` 由 Playwright route 换成 `origin/main` 的静态文件；同一 fixture、同一视口、同一浅色主题，截静止列表。
- **After**：同一壳和 fixture 使用本分支静态文件；CDP 触摸按住第一张卡 750ms 后截展开态，再上滑 100px 截 armed 态。
- fixture 会话/消息全部为合成内容；界面里的标题、日期、工作区名、Agent 名称和文案只用于截图，不对应真实数据。

## 验证

在真实 app 代码 + fixture 宿主上实际跑过：

- 长按 700ms：`#peek-layer` 显示，卡片 370×716 @ (10,64)，8 条气泡，两个 HUD 均在 safe-area 内；无选区。
- 上滑 100px 松手：hash 变为 `#/s/peek-1`，chat 视图激活；下滑 100px 松手：`workspace/archiveSession` 被调用，卡片从列表移除并出现「已收起」toast；中间松手：卡片缩回原位、列表不变。
- 快速轻点：仍直接打开会话；⋯ 菜单仍打开；新主线的卡片内联改名输入框仍可编辑（`user-select: text`，见下方选区修正）。
- 列表日期头（用户反馈里被选中的「昨天」）与卡片内容 `user-select: none`，展开层同样；chat 正文保持可选择。
- 320×568：展开卡片 300×440，无横向溢出；深色主题正常。
- 全程零 `pageerror`；`node --check web/app.js`、`node test/smoke.mjs` 通过。

## 限制

- 这是 fixture 宿主上的真实前端截图，不是对真实 DSH 数据或网络延迟的复采；真实 `session/page` 的 64 事件尾部窗口在本机 fixture 中返回 8 条消息，接口失败时会回退到卡片已有的 `lastPrompt/lastPreview` 摘要。
- iOS 原生长按选区和系统菜单不会出现在 Chromium 截图里。用户报告的「拖最下面卡片选中昨天」是在真机 iOS 上发生的；分支用列表/展开层的 `user-select: none`、`selectionchange` 清空和 `selectstart` 拦截修复，但真机复测仍待做。
- 320 窄屏首条可见消息会被顶部渐隐切掉一部分（与原型一致）；没有为此隐藏整条消息。
