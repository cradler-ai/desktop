# AI Kit（扩展管家）

给普通人用的 AI 扩展管家：复制一个 GitHub 地址、一条安装命令或一段配置，就能把 skill、MCP 和插件装进 Claude、Cursor、Codex 等应用；装好的东西能体检、能一键修、能直接编辑。

[English](README.en.md)

目前只支持 macOS，处于早期版本（0.1）。

## 为什么做这个

拿到别人开源的 skill 或 MCP，往往不会装、怕装错；装完不能用也不知道为什么，后来才发现要重启应用；MCP 报错看不懂，更不知道怎么修。这个应用把这些事都替你做掉：你不用碰终端，也不用看 JSON。

## 能做什么

**安装**

- 粘贴 GitHub 仓库地址、安装命令（`npx …`、`uvx …`、`claude mcp add …`）、JSON / TOML 配置或安装链接，自动识别里面有哪些 skill、MCP 和插件。
- 需要你提供的密钥、文件夹会单独列出来让你填。
- 勾选要装进哪些应用，一键写入；装完自动测一次能不能连上，需要重启的应用直接给重启按钮。

**已安装**

- 汇总各应用里的 MCP（包括项目级的、插件自带的）、技能文件夹和 Claude 插件。
- 标出同一个 MCP 在不同应用里配置不一样的情况。
- 插件可以开关，技能可以移到废纸篓。

**体检**

- 逐个真正启动或连接每个 MCP，把报错翻译成大白话。
- 能修的直接给修复按钮：拆开写在一起的命令和参数、填写密钥、改成自动下载运行（npx / uvx）、修改地址、安装 Node.js 或 uv、删除失效的配置。先预览要改什么，确认后写回原处，再自动重新检查。
- 检查运行环境（Node.js、uv、Python、Docker）和配置文件的格式。

**编辑**

- 在应用里直接修改技能文件（SKILL.md 等）、单个 MCP（表单）、整个配置文件（保存前检查语法），保存即生效。

界面跟随系统语言：中文系统显示中文，其他语言显示英文。

## 支持的应用

| 应用 | 本地 MCP | 在线 MCP | Skill | 插件 |
| --- | --- | --- | --- | --- |
| Claude Code | 自动 | 自动 | 自动 | 自动 |
| Claude 桌面版 | 自动（含 .mcpb） | 按提示手动一步 | 按提示上传 | 按提示手动一步 |
| Cursor | 自动 | 自动 | 不支持 | 不支持 |
| Codex | 自动 | 自动 | 自动 | 不支持 |
| Gemini CLI | 自动 | 自动 | 不支持 | 不支持 |
| ChatGPT | 不支持 | 按提示手动一步 | 不支持 | 不支持 |
| Cherry Studio | 按提示粘贴 | 按提示粘贴 | 不支持 | 不支持 |

「已安装」和「体检」会读取 Claude Code、Claude 桌面版、Cursor、Codex、Gemini CLI 这五个应用的配置。

## 安全

- 识别出来的命令绝不直接执行，只拆开给你看清楚要装什么、装到哪。
- 写配置之前先备份到 `~/Library/Application Support/app.mcpmanager.desktop/backups/`，再整体替换；只允许写固定的几份配置文件和已有的技能文件。
- Claude Code 的配置通过官方的 `claude mcp` 命令修改，不直接改它的文件。
- 密钥在界面上默认打码。
- 没有任何统计上报。只有这些时候会联网：读取你粘贴的 GitHub 仓库、下载要装的 skill、去 npm / PyPI 查询包是否存在、体检时连接你自己配置的 MCP 服务、你点了安装 Node.js 或 uv。

## 从源码运行

需要 macOS、Node.js 22 或更新、pnpm 10、Rust（stable）。

```bash
pnpm install
pnpm dev         # 启动桌面应用
pnpm test        # 单元测试
pnpm typecheck   # 类型检查
```

打包：`pnpm --filter @mcp-manager/desktop tauri build`（目前没有签名，第一次打开需要右键选「打开」）。

## 目录结构

- `packages/core`：识别、清点、诊断、修复的核心逻辑，纯 TypeScript，不依赖 Node 或 Tauri。
- `apps/desktop`：Tauri 2 + React 桌面应用；Rust 部分负责读写文件、启动 MCP 做检查、调用官方命令。
- `docs/PRODUCT.md`：产品定位和设计原则。

## 还没做

- Windows 和 Linux
- 签名和公证
- 把一个应用里的 MCP 同步到其他应用
- 更多界面语言

欢迎提 issue 和 PR。

## 许可证

[MIT](LICENSE)
