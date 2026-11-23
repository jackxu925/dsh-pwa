# 首页会话卡片底部 chip 右对齐 · Before / After

同一真实 PWA 页面壳、390×844、3× 像素密度、浅色主题；两次截图用同一组合成示例会话、同一滚动位置。
**Before** = `origin/main` 的 `web/`（`94f73e8`，本分支的基线；本分支只改 `web/style.css` 一处布局）；
**After** = 本分支。
会话标题、摘要和工作区名均为截图用示例（页面壳、`sessionCard()` 渲染函数和卡片 DOM/样式都是真实应用，
内容为合成），不含任何真实会话内容。

| 文件 | 说明 |
|---|---|
| `before-390.png` | 基线：底部一行只有工作区 chip 靠右（`margin-left:auto`），状态徽标贴左 | 
| `after-390.png` | 本分支：状态徽标 / Agent 预设 / 工作区 chip 整体贴右 | 
| `before-after-390.png` | 同场景左右拼图 |
| `narrow-320-dark.png` | 窄屏回归（320×568 深色，After）：徽标不被压成两行、工作区 chip 收缩省略、无横向溢出 |

## 测量（390×844，浅色；单位 px）

| 元素 | Before | After |
|---|---|---|
| 运行中卡片：状态徽标右边缘 | 92.5 | 195.3 |
| 运行中卡片：Agent 预设右边缘 | 201.6 | 253 |
| 运行中卡片：工作区 chip 右边缘 | 323 | 323 |
| 等待审批卡片：状态徽标右边缘 | 104 | 253 |
| 右上角时间右边缘 | 323 | 323 |
| 卡片内横向溢出 | 0 | 0 |

After 中底部一行整体贴近右边缘（与右上角时间同一条竖线）；单 chip 的卡片位置不变。

## 复现方式

宿主是真实的 `dsh web`（`/m` 静态面 + 真实 API/WS）。用 Playwright 只替换 `/m/style.css`
（Before 取 `origin/main` 的静态文件、After 取本分支），列表在页面内用应用真实的 `sessionCard()`
渲染一组合成会话；页面其它部分（标题栏、连接状态、分段控件、卡片 DOM/样式/交互）都是真实应用。

## 功能检查（同一套 Chromium 环境）

- 390×844 浅色：运行中 / 等待审批 / 空闲三张卡片底部一行右对齐，徽标、预设、chip 依次相隔 8px；
  徽标右边缘与工作区 chip 之间不再横跨整张卡片；卡片 `scrollWidth == clientWidth`。
- 320×568 深色（最窄常见宽度 + 三 chip 同现 + 超长工作区名）：行内 `scrollWidth == clientWidth`
  （224/224），徽标保持单行，工作区 chip 截断为 `an-extremel…`；无 pageerror。
- `node --check web/app.js`、`node test/smoke.mjs` 通过（见 PR）。

限制：只在 Chromium 手机模拟中截图，未在 iPhone/Android 真机复采。改动为纯 CSS 右对齐（无手势/交互逻辑），
风险限于布局。
