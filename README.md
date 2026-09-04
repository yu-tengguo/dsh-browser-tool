# dsh-browser-tool

A **zero-dependency built-in browser toolset** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) agents.
It registers native agent tools (`browser_navigate` / `browser_snapshot` / `browser_act` / `browser_screenshot` / `browser_close`)
that drive a real local Chrome/Edge over the Chrome DevTools Protocol (CDP) — so agents can open pages, read rendered
content (UTF-8 safe, Chinese included), click, type, submit forms, and log in **without any web-access skill or
browser-automation tooling**.

> 内置浏览器工具：让 DSH agent 直接打开网页、读取渲染后内容、点击/输入/提交表单，不再需要 `web-access` / `web-scraper`
> 之类的联网 skill，也不需要任何 npm 依赖（复用系统 Chrome/Edge + CDP）。

## Why

DSH ships `web_search` but often disables the plain-HTTP `web_fetch`; JavaScript-rendered, anti-bot, and
complex-layout pages (Baidu Baike, XHS, Weibo, Amazon, …) need a real browser. Loading a skill every time is clumsy.
This plugin puts a real browser into the agent's **default tool catalog** for the sessions that mount it.

## How it works

- `browser.mjs` is a cordis plugin file mounted by a DSH agent preset row (`name: ./browser.mjs`).
- It imports **only Node built-ins** and the global `fetch`/`WebSocket` (Node ≥ 22) — no npm install, no Playwright download.
- On first use it launches a headless Chrome/Edge (`--remote-debugging-port` on a free port) and speaks CDP to it:
  - `Page.navigate` / `Runtime.evaluate` / `Page.captureScreenshot` / history entries
  - text is read via `document.body.innerText`, so character encodings are handled by the browser itself
  - typing uses the native value setter + `input`/`change` events; forms submit via `requestSubmit()`
- Each agent/session gets its own tab; cookies persist in a profile dir, so logins survive GUI restarts.

## Install into DSH

1. Copy `browser.mjs` into a user agent preset directory, e.g.
   `C:\Users\ddnin\.dsh\.agent-presets\standard-browser\` (alongside `agent.cordis.yml` + `preset.yml`).
2. Append a row to that preset's `agent.cordis.yml`:

```yaml
- id: builtin-browser
  name: ./browser.mjs
  config:
    chromePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'  # optional; auto-detects Chrome/Edge
    headless: true
```

3. Restart the DSH web UI and start a new session using that preset.

> Tip: make the preset the default by adding to the DSH user settings:
> `agent-presets: { default: standard-browser }`

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_navigate(url, waitMs?)` | Open a URL and wait for rendering; returns title + leading text |
| `browser_snapshot(mode?, maxChars?)` | Read the current page: `text` \| `interactives` (clickable/input index) \| `both` |
| `browser_act(action, selector?, match?, text?, js?, waitMs?)` | `click` / `type` / `submit` / `select` / `back` / `forward` / `refresh` / `eval` |
| `browser_screenshot(fullPage?, path?)` | Save a PNG and return its path (view with `read_image` on an image-capable model) |
| `browser_close()` | Shut the browser down (auto-restarts on the next call) |

Element targeting accepts a CSS `selector` **or** a visible-text/placeholder/`name` fuzzy `match`
(first match wins). New tabs opened by a click are adopted automatically.

## Configuration

| Config | Default | Meaning |
| --- | --- | --- |
| `chromePath` | auto-detect | Path to Chrome/Edge (or set `CHROME_PATH`) |
| `headless` | `true` | Set `false` for a visible window (useful for CAPTCHA-assisted logins) |
| `noSandbox` | `false` | Add `--no-sandbox` (dev/CI only) |
| `timeoutMs` | `25000` | Per-navigation timeout |
| `profileDir` | `$DSH_HOME/browser-profile` | Persistent cookies/login state; delete to reset |
| `screenshotDir` | `$DSH_HOME/browser-shots` | Where screenshots are written |

Dev/test: set `DSH_BROWSER_DEBUG_BASE=http://127.0.0.1:9333` to attach to an already-running Chrome instead of launching one.

## Development

- `browser.mjs` — the plugin (single file, no dependencies)
- `test/` — smoke tests that execute the real tool functions against a debug Chrome
  (`test-plugin.mjs` uses a mocked cordis `ctx`; start Chrome with
  `--headless --no-sandbox --remote-debugging-port=9333 about:blank` first)

## Limitations

- Strict anti-bot pages (sliders, image CAPTCHAs) may still challenge headless automation; run headed (`headless: false`)
  for human-assisted logins.
- Screenshots require an image-capable model to view via `read_image`; text models use `browser_snapshot`.

## License

MIT
