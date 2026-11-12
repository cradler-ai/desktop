# Cradler Desktop

Cradler Desktop is an AI extension manager for people who are not developers. Paste a GitHub link, an install command or a config snippet, and it installs the skills, MCP servers and plugins inside into Claude, Cursor, Codex and other apps. Everything you have installed can be health-checked, fixed with one click and edited in place.

[中文](README.md) · Website: [cradler.ai/desktop](https://cradler.ai/desktop)

Cradler Desktop is the free, open-source desktop app from [Cradler](https://cradler.ai). macOS only for now (Apple silicon and Intel). Early version (0.1).

## Download

Get the `.dmg` from [Releases](https://github.com/cradler-ai/desktop/releases/latest), open it and drag Cradler Desktop into Applications. The app is signed and notarized by Apple, so it opens with a double-click.

## Why

Open-source skills and MCP servers are hard to install if you have never used a terminal. When they don't work you rarely find out why: maybe the app needed a restart, maybe a key is missing, maybe the command was written wrong. Cradler Desktop does all of that for you, without a terminal and without editing JSON.

## What it does

**Install**

- Paste a GitHub repository, an install command (`npx …`, `uvx …`, `claude mcp add …`), a JSON / TOML config or an install link. It detects the skills, MCP servers and plugins inside.
- Keys and folders you need to provide are listed as simple fields.
- Pick the apps to install into and click once. It tests the connection afterwards and offers a restart button for apps that need one.

**Installed**

- One list of every MCP server (including project-level and plugin-provided ones), skill folder and Claude plugin across your apps.
- Flags servers whose config differs between apps.
- Turn plugins on or off; move skills to the Trash.

**Health check**

- Actually starts or connects to every MCP server and explains errors in plain words.
- Fix buttons for what can be fixed: split a command that was written together with its arguments, fill in a key, switch to auto-download (npx / uvx), change the address, install Node.js or uv, remove a dead entry. You see the change first, confirm, it is written back and checked again.
- Checks the runtime (Node.js, uv, Python, Docker) and the syntax of config files.

**Edit**

- Edit skill files (SKILL.md and others), a single MCP server (as a form) or a whole config file (syntax-checked before saving) inside the app.

The interface follows the system language: Chinese on Chinese systems, English everywhere else.

## Supported apps

| App | Local MCP | Remote MCP | Skill | Plugin |
| --- | --- | --- | --- | --- |
| Claude Code | Automatic | Automatic | Automatic | Automatic |
| Claude Desktop | Automatic (incl. .mcpb) | One manual step | Guided upload | One manual step |
| Cursor | Automatic | Automatic | Not supported | Not supported |
| Codex | Automatic | Automatic | Automatic | Not supported |
| Gemini CLI | Automatic | Automatic | Not supported | Not supported |
| ChatGPT | Not supported | One manual step | Not supported | Not supported |
| Cherry Studio | Guided paste | Guided paste | Not supported | Not supported |

Installed and Health check read the configs of Claude Code, Claude Desktop, Cursor, Codex and Gemini CLI.

## Safety

- Detected commands are never executed. They are taken apart and shown to you first.
- Every config write is backed up to `~/Library/Application Support/ai.cradler.desktop/backups/` and then replaced atomically. Only a fixed set of config files and existing skill files can be written.
- Claude Code's config is changed through the official `claude mcp` commands.
- Keys are masked in the interface.
- No analytics. It only goes online to read a GitHub repository you pasted, download a skill you install, look up packages on npm / PyPI, connect to MCP servers you configured during a health check, and install Node.js or uv when you click that button.

## Run from source

Requires macOS, Node.js 22+, pnpm 10 and Rust (stable).

```bash
pnpm install
pnpm dev         # start the desktop app
pnpm test        # unit tests
pnpm typecheck
```

Build: `pnpm --filter @cradler-desktop/desktop tauri build`. Your own builds are unsigned: the first time, open them from System Settings → Privacy & Security → Open Anyway.

## Layout

- `packages/core`: detection, inventory, diagnosis and repair logic. Plain TypeScript with no Node or Tauri dependency.
- `apps/desktop`: Tauri 2 + React desktop app. The Rust side reads and writes files, starts MCP servers for checks and calls official CLIs.
- `docs/PRODUCT.md`: positioning and design principles (Chinese).

## Not done yet

- Windows and Linux
- Syncing an MCP server from one app to others
- More interface languages

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
