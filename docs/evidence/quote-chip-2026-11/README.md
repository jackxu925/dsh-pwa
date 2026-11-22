# 选区「引用」钮遮挡修复 · Before / After

同一真实 PWA 壳、390×844、3× 像素密度、浅色主题；两次截图用同一段选区、同一滚动位置。
**Before** = `origin/main` 的 `web/`（`314b1fc`；之后的 `54b59c7` 只改发布 workflow，`web/` 未变，基线仍成立）；**After** = 本分支。
会话文案为截图用示例（真实 PWA 的 DOM/样式/按钮逻辑，内容为合成），不含真实会话内容。

| 文件 | 说明 |
|---|---|
| `before-top-390.png` | 选中顶部一段文字（选区 86–128）。旧逻辑把「引用」钮放在选区下方 8px（136–168）。iOS 原生选择菜单就画在选区上下这一小段里，按钮会被盖住。 |
| `after-top-390.png` | 同一选区。触屏上按钮停靠在输入区上沿（751–783，输入区顶 792.6，留 10px），远离选区。 |
| `before-bottom-390.png` | 选中最底部一段文字（选区 688.5–730.5，钮 739–771）。 |
| `after-bottom-390.png` | 同一选区，按钮同样停靠输入区上沿（751–783）。 |
| `before-after-top-390.png` | 顶部选区场景的 Before/After 拼图。 |

## 复现方式

宿主仍是真实的 `dsh web` PWA；在同一会话里把消息区换成一段合成的示例文案（保留应用自己的
消息节点、气泡样式和 meta 行），再只在浏览器里把 `/m/app.js`、`/m/style.css` 换成待测版本
（Before 用 main 的静态文件，After 用本分支的静态文件）。这样两边除被测代码外完全一致。

## 关于系统原生菜单

iOS/Android 原生选择菜单由系统绘制在 WebView 之上，Chromium 截图里画不出来，本机也没有可用的
iPhone 镜像/屏幕录制权限，所以截图只覆盖应用自己的按钮位置，不包含系统菜单本身。修复依据的是
系统的固定行为：菜单只会出现在选区上方或下方的一小段内（空间不足时翻到另一侧，见
[BlockNote #2122](https://github.com/TypeCellOS/BlockNote/issues/2122)），而 Before 的按钮就贴在
这段里（下方 8px）；After 把它停靠到输入区上沿，离选区隔着整段对话内容，两个方向都够不到。
真机（iOS Safari / Android Chrome）最终确认仍建议做一次。

## 功能检查（同一套 Chromium 环境）

- 触屏媒体查询命中（`(any-pointer: coarse)` = true），按钮停靠输入区上沿；鼠标环境不命中，仍贴着选区（桌面行为不变）。
- 触摸 `tap()` 与鼠标 `click()` 都能触发；点按钮后引用面板打开、`#quote-full` 是精确的选中片段；引用 chips 条出现 1 条；按钮收起、选区清空。
- `node --check web/app.js`、`node test/smoke.mjs` 通过；零 pageerror。
