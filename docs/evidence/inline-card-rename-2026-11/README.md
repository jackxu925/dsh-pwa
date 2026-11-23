# 首页卡片 ⋯ → 改名：内联编辑 · Before / After

同一真实 PWA 页面壳、同一组合成会话、390×844、2× 像素密度、浅色主题、同一滚动位置。
**Before** = `origin/main` 的 `web/`（`8d1dbfa`，本分支基线）；**After** = 本分支（`v1.22.1`）。
页面壳、卡片 DOM、`sessionCard()` 渲染与交互都是应用自己的代码；会话内容为合成示例，不含真实会话。场景：点第一张卡的 ⋯ → 点「改名」。

| 文件 | 说明 |
|---|---|
| `before-390-light.png` | 基线：改名打开二级操作单，输入框上方还排着「分叉 / 归档」 |
| `after-390-light.png` | 本分支：标题行就地变成输入框 + 保存 / 取消，无二级单子 |
| `before-after-390-light.png` | 同场景左右拼图（带标注） |
| `after-390-dark.png` | 深色回归（390×844） |
| `after-320-dark.png` | 最窄常见宽度回归（320×568 深色） |
| `after-390-light-saved.png` | 保存后：标题更新、toast「已重命名 ✓」、列表恢复 |

同一 Chromium 环境（stub 合成会话；`session/rename` 只记录请求并回包）实测：菜单 4 行；改名不出现二级单子、输入框聚焦全选；
✓ / Enter / 触摸保存、标题就地更新；✕ / Esc / 点卡片外 / 切 tab 取消且不发请求；编辑期间注入后台投影帧不打断草稿；
保存失败保留编辑态与草稿；320×568 深色下输入框与按钮完整可见、无横向溢出；零 pageerror，`node --check web/app.js`、`node test/smoke.mjs` 通过。

限制：截图只在 Chromium 手机模拟中采集，未在 iPhone / Android 真机复采；iOS 键盘依赖菜单点击同一手势内的同步 `focus()`。
