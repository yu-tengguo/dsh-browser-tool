# dsh-browser-tool

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) agent 打造的**零依赖「内置浏览器」工具集**。
注册一组原生 agent 工具（`browser_navigate` / `browser_snapshot` / `browser_act` / `browser_screenshot` / `browser_close`），
通过 Chrome DevTools Protocol (CDP) 驱动本机真实的 Chrome/Edge——打开网页、读取渲染后内容（中文 UTF-8 无乱码）、
点击、输入、提交表单、登录，**不再需要任何 web-access 类 skill 或浏览器自动化工具**。

> A zero-dependency **built-in browser toolset** for DeepSeek Harness agents.
> Native agent tools over CDP driving your local Chrome/Edge — no web-access skills, no npm installs, no browser downloads.
>
> 简体中文为主 · English version at the bottom / 英文版见文末

---

## 中文说明

### 为什么需要它

DSH 自带 `web_search`，但产品配置常把纯 HTTP 的 `web_fetch` 关掉；而需要 JavaScript 渲染、带反爬、
布局复杂的页面（百度百科、小红书、微博、Amazon…）必须用真实浏览器。每次都要先加载联网 skill 很绕。
本插件把真实浏览器直接放进挂载它的会话的**默认工具目录**里。

### 工作原理

- `browser.mjs` 是一个 cordis 插件文件，由 DSH agent 预设行（`name: ./browser.mjs`）挂载。
- 只依赖 **Node 内置模块** + 全局 `fetch`/`WebSocket`（Node ≥ 22），无需 npm install、无需下载 Playwright。
- 首次调用时启动 headless Chrome/Edge（`--remote-debugging-port` 占用空闲端口），并用 CDP 驱动：
  - `Page.navigate` / `Runtime.evaluate` / `Page.captureScreenshot` / 历史记录跳转
  - 文本通过 `document.body.innerText` 读取，编码问题交给浏览器自己处理
  - 输入走原生 value setter + `input`/`change` 事件；表单用 `requestSubmit()` 提交
- 每个 agent/会话独立标签页；cookie 持久化在 profile 目录，重启 GUI 后登录态仍在。

### 安装

完整分步指南见 **[docs/install.md](docs/install.md)**（新建预设 / 挂已有预设 / 设为默认 / 卸载）。

**一键安装**（Node ≥ 22；自动定位 `$DSH_HOME`、创建 `standard-browser` 预设、复制插件、写入默认设置；幂等可重复执行）：

```bash
node install.mjs
```

手动快速开始：

1. 把 `browser.mjs` 复制到你的用户预设目录，如 `~/.dsh/.agent-presets/standard-browser/`；
2. 在该预设的 `agent.cordis.yml` **末尾追加**：

```yaml
- id: builtin-browser
  name: ./browser.mjs
  config:
    chromePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'  # 可选，默认自动检测 Chrome/Edge
    headless: true
```

3. 重启 `dsh web` 并用该预设新开会话。

> 提示：可在 DSH 用户设置里设为默认预设：
> `agent-presets: { default: standard-browser }`

### 工具一览

| 工具 | 作用 |
| --- | --- |
| `browser_navigate(url, waitMs?)` | 打开 URL 并等待渲染；返回标题与开头文本 |
| `browser_snapshot(mode?, maxChars?)` | 读取当前页：`text`（渲染文本）\| `interactives`（可点击/输入元素索引）\| `both` |
| `browser_act(action, selector?, match?, text?, js?, waitMs?)` | `click` / `type` / `submit` / `select` / `back` / `forward` / `refresh` / `eval` |
| `browser_screenshot(fullPage?, path?)` | 截图存为 PNG 并返回路径（用 `read_image` 查看，需图像模型） |
| `browser_close()` | 关闭浏览器（下次调用自动重启） |

元素定位支持 CSS `selector`，也支持按可见文本 / placeholder / `name` 模糊匹配 `match`（取首个匹配）。
点击打开的新标签页会被自动接管。

### 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `chromePath` | 自动检测 | Chrome/Edge 路径（也可设 `CHROME_PATH`） |
| `headless` | `true` | `false` 时显示窗口（便于人工配合验证码登录） |
| `noSandbox` | `false` | 追加 `--no-sandbox`（仅开发/CI） |
| `timeoutMs` | `25000` | 单次导航等待上限 |
| `profileDir` | `$DSH_HOME/browser-profile` | 持久化 cookie/登录态；删除目录即重置 |
| `screenshotDir` | `$DSH_HOME/browser-shots` | 截图输出目录 |

调试：设 `DSH_BROWSER_DEBUG_BASE=http://127.0.0.1:9333` 可附加到已运行的 Chrome 而非新启动。

### 开发与测试

- `browser.mjs` — 插件本体（单文件、无依赖）
- `test/` — 冒烟测试：`test-plugin.mjs` 用 mock 的 cordis `ctx` 直接执行真实工具函数。
  先手动启动调试 Chrome：`chrome --headless --no-sandbox --remote-debugging-port=9333 about:blank`

### 已知限制

- 严格反爬页（滑块、图形验证码）仍可能拦截 headless；复杂登录可 `headless: false` 有头运行、人工配合。
- 截图需要支持图像输入的模型用 `read_image` 查看；纯文本模型请用 `browser_snapshot` 读页面。

### 许可证

MIT

---

## English / 英文版

A **zero-dependency built-in browser toolset** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
agents. It registers native tools (`browser_navigate`, `browser_snapshot`, `browser_act`, `browser_screenshot`,
`browser_close`) that drive a real local Chrome/Edge over the Chrome DevTools Protocol — so agents can open pages,
read rendered content (UTF-8 safe), click, type, submit forms and log in **without web-access skills or extra tooling**.

### Why

DSH ships `web_search` but deployments often disable plain-HTTP `web_fetch`. JavaScript-rendered, anti-bot and
complex pages (Baidu Baike, XHS, Weibo, Amazon, …) need a real browser. This plugin puts one into the agent's
**default tool catalog** for the sessions that mount it.

### How it works

- `browser.mjs` is a cordis plugin file mounted by a DSH agent preset row (`name: ./browser.mjs`).
- Imports **only Node built-ins** plus global `fetch`/`WebSocket` (Node ≥ 22) — no npm install, no Playwright download.
- On first use it launches a headless Chrome/Edge on a free port and speaks CDP to it
  (`Page.navigate`, `Runtime.evaluate`, `Page.captureScreenshot`, history entries).
- Text comes from `document.body.innerText`; typing uses the native value setter + `input`/`change` events;
  forms submit via `requestSubmit()`.
- Each agent/session gets its own tab; cookies persist in a profile dir so logins survive GUI restarts.

### Install

Step-by-step guide: **[docs/install.md](docs/install.md)** (new preset / existing preset / default preset / uninstall).

**One-command installer** (Node ≥ 22; locates `$DSH_HOME`, creates the `standard-browser` preset,
copies the plugin and sets it as the default; idempotent):

```bash
node install.mjs
```

Manual quick start:

1. Copy `browser.mjs` into a user agent preset directory, e.g. `~/.dsh/.agent-presets/standard-browser/`.
2. Append to that preset's `agent.cordis.yml`:

```yaml
- id: builtin-browser
  name: ./browser.mjs
  config:
    chromePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'  # optional; auto-detects Chrome/Edge
    headless: true
```

3. Restart the DSH web UI and start a new session using that preset.

> Tip: make it the default preset via the DSH user settings:
> `agent-presets: { default: standard-browser }`

### Tools

| Tool | Purpose |
| --- | --- |
| `browser_navigate(url, waitMs?)` | Open a URL and wait for rendering; returns title + leading text |
| `browser_snapshot(mode?, maxChars?)` | Read the page: `text` \| `interactives` (clickable/input index) \| `both` |
| `browser_act(action, selector?, match?, text?, js?, waitMs?)` | `click` / `type` / `submit` / `select` / `back` / `forward` / `refresh` / `eval` |
| `browser_screenshot(fullPage?, path?)` | Save a PNG and return its path (view with `read_image` on an image-capable model) |
| `browser_close()` | Shut the browser down (auto-restarts on the next call) |

Elements can be targeted by CSS `selector` or by a visible-text/placeholder/`name` fuzzy `match` (first match wins).
Tabs opened by a click are adopted automatically.

### Configuration

| Config | Default | Meaning |
| --- | --- | --- |
| `chromePath` | auto-detect | Path to Chrome/Edge (or set `CHROME_PATH`) |
| `headless` | `true` | `false` for a visible window (human-assisted CAPTCHA logins) |
| `noSandbox` | `false` | Add `--no-sandbox` (dev/CI only) |
| `timeoutMs` | `25000` | Per-navigation timeout |
| `profileDir` | `$DSH_HOME/browser-profile` | Persistent cookies/login state; delete to reset |
| `screenshotDir` | `$DSH_HOME/browser-shots` | Where screenshots are written |

Dev/test: set `DSH_BROWSER_DEBUG_BASE=http://127.0.0.1:9333` to attach to an already-running Chrome instead of launching one.

### Development

- `browser.mjs` — the plugin (single file, no dependencies)
- `test/` — smoke tests running the real tool functions against a debug Chrome
  (`test-plugin.mjs` uses a mocked cordis `ctx`; start Chrome with
  `--headless --no-sandbox --remote-debugging-port=9333 about:blank` first)

### Limitations

- Strict anti-bot pages (sliders, image CAPTCHAs) may still challenge headless automation; run headed
  (`headless: false`) for human-assisted logins.
- Screenshots require an image-capable model to view via `read_image`; text models use `browser_snapshot`.

### License

MIT
