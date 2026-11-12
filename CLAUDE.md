# Cradler Desktop（AI 扩展管家）

产品定位、用户痛点和设计原则见 `docs/PRODUCT.md`，改功能前先读。

## 结构

- `packages/core`：识别引擎（纯 TypeScript，不依赖 Node 或 Tauri，浏览器里也能跑）。入口 `detect(input)`。
- `apps/desktop`：Tauri 2 + React 桌面应用，直接 import `@cradler-desktop/core`。

## 命令（一律用 pnpm）

- `pnpm test`：单元测试（离线）
- `GITHUB_TOKEN=$(gh auth token) pnpm eval:repos`：拿真实 GitHub 仓库实测识别结果，改了识别规则后必须跑一遍对比
- `pnpm dev`：启动桌面应用

## 约定

- 面向普通人的文字（警告、说明、按钮）口语化，不出现 stdio / transport 这类术语。
- 界面文字一律走 `t()`，不要写死：核心文案在 `packages/core/src/i18n.ts`，界面文案在 `apps/desktop/src/messages.ts`，中英两份都要加。Rust 只返回错误代码（`code|detail`），由 `nativeError()` 翻译。
- 界面：黑白分明 + 原生毛玻璃（各层半透明白，别用不透明底色盖住玻璃；黑字、黑色主按钮），颜色只给状态用；大圆角、无描边、无投影、无分割线、无 emoji；不要左侧强调竖线。
- 识别出的命令绝不直接执行；写配置只能经过 Rust 的 `write_config`（白名单 + 先备份 + 原子替换）；改 Claude Code 配置走官方 `claude mcp` 命令。
- 动画只能动位置，不能从透明度 0 开始：后台窗口的动画会被系统冻结，内容会卡在看不见的那一帧。
- 调试截图可用 `?page=installed|health`、`?q=<输入>`、`?run=1`、`?focus=1` 这些启动参数（改 tauri.conf.json 的 devUrl，用完改回去）。

## 发布新版本（macOS）

1. 改版本号：`apps/desktop/src-tauri/tauri.conf.json` 和 `Cargo.toml`，以及 cradler.ai 网站 `src/app/[locale]/desktop/page.tsx` 里的 `VERSION`。
2. 打包并签名（通用版）：`APPLE_SIGNING_IDENTITY="Developer ID Application: Wenjun LI (8224WGCM69)" pnpm --filter @cradler-desktop/desktop tauri build --target universal-apple-darwin --bundles app`
3. 公证：`ditto -c -k --keepParent "Cradler Desktop.app" app.zip`，`xcrun notarytool submit app.zip --keychain-profile ShotShelf --wait`，再 `xcrun stapler staple "Cradler Desktop.app"`。凭据存在只有 Mac 解锁时才能读的钥匙串里：锁屏时会报 "No Keychain password item found"，`security` 命令也看不到它，以 `notarytool history` 的结果为准。
4. 做 dmg：把 app 和指向 `/Applications` 的链接放进一个文件夹，`hdiutil create -volname "Cradler Desktop" -srcfolder <文件夹> -format UDZO Cradler-Desktop.dmg`，`codesign --timestamp --sign <同上身份>`，再公证、staple 一次 dmg。
5. `gh release create vX.Y.Z Cradler-Desktop.dmg --repo cradler-ai/desktop`。**文件名必须保持 `Cradler-Desktop.dmg`**：网站下载按钮指向 `releases/latest/download/Cradler-Desktop.dmg`。
