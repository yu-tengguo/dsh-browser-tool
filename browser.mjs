/**
 * builtin-browser — 内置浏览器工具（zero-dependency CDP over local Chrome/Edge）。
 *
 * Registers native agent tools: browser_navigate / browser_snapshot /
 * browser_act / browser_screenshot / browser_close. No skill, no external
 * browser automation tooling required: this plugin drives a real Chromium
 * (system Chrome or Edge) over the Chrome DevTools Protocol using only Node
 * built-ins and the global fetch/WebSocket (Node >= 22).
 *
 * Loaded by a dsh agent preset row:
 *   - id: builtin-browser
 *     name: ./browser.mjs
 *     config:
 *       chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
 *       headless: true
 *
 * Dev/test note: set DSH_BROWSER_DEBUG_BASE=http://127.0.0.1:<port> to attach
 * to an already-running Chrome instead of launching one (used by the
 * workspace test harness).
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export const name = "builtin-browser";
export const inject = ["tools"];

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickChrome(preferred) {
  if (preferred && existsSync(preferred)) return preferred;
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error("No Chrome/Edge executable found. Set config.chromePath or CHROME_PATH.");
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolvePort(port));
    });
  });
}

/** Minimal CDP client over the page WebSocket. */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.alive = false;
    this.ws.addEventListener("open", () => { this.alive = true; }, { once: true });
    this.ws.addEventListener("close", () => { this.alive = false; }, { once: true });
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) bad(new Error(`${msg.error.message} (${msg.error.code})`));
        else ok(msg.result);
      }
    });
  }
  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolveOpen, reject) => {
      const onOpen = () => { cleanup(); resolveOpen(); };
      const onError = () => { cleanup(); reject(new Error(`CDP websocket error for ${this.wsUrl}`)); };
      const cleanup = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
      };
      this.ws.addEventListener("open", onOpen, { once: true });
      this.ws.addEventListener("error", onError, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

/** In-page evaluation helper. */
async function evalJs(page, expression) {
  const r = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "unknown";
    throw new Error(`page script failed: ${String(detail).slice(0, 500)}`);
  }
  return r.result?.value;
}

/** A real-browser manager: one Chrome, per-agent page targets, serialized ops. */
class BrowserManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.base = null;
    this.pages = new Map(); // agentKey -> { targetId, page }
    this.chain = Promise.resolve();
    this.disposed = false;
    this._cleanupDirs = [];
  }

  _queue(fn) {
    const run = this.chain.then(() => (this.disposed ? Promise.reject(new Error("browser disposed")) : fn()));
    this.chain = run.catch(() => {});
    return run;
  }

  async ensureLaunched() {
    if (this.base) return;
    if (this.cfg.remoteDebugBase) {
      this.base = String(this.cfg.remoteDebugBase).replace(/\/$/, "");
      await this._waitEndpoint(15000);
      return;
    }
    const chromePath = pickChrome(this.cfg.chromePath);
    const port = await freePort();
    const userData = this.cfg.profileDir && String(this.cfg.profileDir).length > 0
      ? String(this.cfg.profileDir)
      : await mkdtemp(join(tmpdir(), "dsh-browser-"));
    if (!this.cfg.profileDir) this._cleanupDirs.push(userData);
    const args = [
      this.cfg.headless === false ? "" : "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--mute-audio",
      "--hide-scrollbars",
      "--remote-allow-origins=*",
      "--window-size=1365,900",
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ].filter(Boolean);
    if (this.cfg.noSandbox || process.env.DSH_BROWSER_NO_SANDBOX === "1") args.push("--no-sandbox");
    this.child = spawn(chromePath, args, { stdio: ["ignore", "ignore", "ignore"] });
    this.child.on("exit", () => { this.child = null; this.base = null; this.pages.clear(); });
    this.base = `http://127.0.0.1:${port}`;
    await this._waitEndpoint(25000);
    if (!this.child) throw new Error("Chrome exited during startup");
  }

  async _waitEndpoint(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${this.base}/json/version`);
        if (r.ok) return;
      } catch (e) { lastErr = e; }
      await sleep(250);
    }
    throw new Error(`Chrome DevTools endpoint ${this.base} not reachable: ${lastErr?.message ?? "timeout"}`);
  }

  async _targets() {
    const r = await fetch(`${this.base}/json/list`);
    if (!r.ok) throw new Error(`CDP list failed: HTTP ${r.status}`);
    return await r.json();
  }

  async _createTarget() {
    const r = await fetch(`${this.base}/json/new?about:blank`, { method: "PUT" });
    if (!r.ok) throw new Error(`CDP new target failed: HTTP ${r.status}`);
    return await r.json();
  }

  /** Get (creating if needed) the page target bound to one agent key. */
  async pageFor(key) {
    if (this.disposed) throw new Error("browser disposed");
    const entry = this.pages.get(key);
    if (entry) {
      if (entry.page.alive) return entry;
      // ws dropped: try to re-attach to the same target id
      try {
        const targets = await this._targets();
        const found = targets.find((t) => t.type === "page" && t.id === entry.targetId);
        if (found) {
          const page = new Cdp(found.webSocketDebuggerUrl);
          await page.open();
          await page.send("Page.enable");
          this.pages.set(key, { targetId: found.id, page });
          return this.pages.get(key);
        }
      } catch { /* fall through to create */ }
    }
    const target = await this._createTarget();
    const page = new Cdp(target.webSocketDebuggerUrl);
    await page.open();
    await page.send("Page.enable");
    const created = { targetId: target.id, page };
    this.pages.set(key, created);
    return created;
  }

  async waitReady(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let ready = "unknown";
    while (Date.now() < deadline) {
      try {
        ready = await evalJs(page, "document.readyState");
      } catch { /* page mid-navigation */ }
      if (ready === "complete") break;
      await sleep(250);
    }
    // small settle grace for late JS mutating the DOM
    await sleep(300);
    return ready;
  }

  async pageState(page) {
    return await evalJs(page, `(() => {
      const bodyText = (document.body && document.body.innerText) || "";
      return JSON.stringify({
        url: location.href,
        title: (document.title || "").trim(),
        ready: document.readyState,
        textLen: bodyText.length
      });
    })()`).then((s) => JSON.parse(s)).catch(() => ({ url: "", title: "", ready: "?", textLen: 0 }));
  }

  async switchToNewTabIfAny(key, entry, prevUrl) {
    await sleep(1200);
    try {
      const targets = await this._targets();
      const candidates = targets.filter(
        (t) => t.type === "page" && t.id !== entry.targetId && !/^(about:|chrome:)/.test(t.url) && t.url.startsWith("http"),
      );
      if (candidates.length === 0) return false;
      const current = await this.pageState(entry.page);
      // Only switch when the click did not navigate the current tab itself.
      if (current.url !== prevUrl && current.url.startsWith("http")) return false;
      const picked = candidates[candidates.length - 1];
      const page = new Cdp(picked.webSocketDebuggerUrl);
      await page.open();
      await page.send("Page.enable");
      this.pages.set(key, { targetId: picked.id, page });
      return true;
    } catch { return false; }
  }

  async dispose() {
    this.disposed = true;
    for (const entry of this.pages.values()) { try { entry.page.close(); } catch {} }
    this.pages.clear();
    const child = this.child;
    this.child = null;
    this.base = null;
    if (child) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          child.kill("SIGKILL");
        }
      } catch { try { child.kill(); } catch {} }
    }
    for (const dir of this._cleanupDirs) { try { await rm(dir, { recursive: true, force: true }); } catch {} }
    this._cleanupDirs = [];
  }
}

// ── tool schemas ─────────────────────────────────────────────────────────────

const textOutput = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  render: (_args, value) => [{ type: "text", text: value.text }],
};

function params(spec) {
  const properties = {};
  const required = [];
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type };
    if (meta.description) prop.description = meta.description;
    if (meta.type === "array") prop.items = meta.items || {};
    if (meta.enum) prop.enum = meta.enum;
    properties[key] = prop;
    if (meta.required) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

// In-page script building blocks -------------------------------------------------

const FIND_SCRIPT = `(matchText, kind) => {
  const text = (matchText || "").toString().trim();
  if (!text) return null;
  const wanted = text.toLowerCase();
  const esc = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const nodes = kind === "input"
    ? Array.from(document.querySelectorAll("input, textarea, select"))
    : kind === "form"
      ? Array.from(document.querySelectorAll("button, input[type=button], input[type=submit], [role=button], a, [onclick]"))
      : Array.from(document.querySelectorAll("input, textarea, select, button, a, [role=button], [onclick]"));
  for (const el of nodes) {
    const label = esc(el.innerText) || esc(el.value) || esc(el.placeholder) || esc(el.getAttribute("aria-label")) || esc(el.name);
    if (label && label.includes(wanted)) return el;
  }
  return null;
}`;

const SEL_FOR_SCRIPT = `(el) => {
  if (!el || !el.tagName) return "";
  if (el.id) return "#" + CSS.escape(el.id);
  if (el.name && /^(INPUT|SELECT|TEXTAREA|FORM)$/.test(el.tagName)) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name).replace(/"/g, '\\\\"') + '"]';
  const path = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName !== "BODY" && node.tagName !== "HTML") {
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    path.unshift(part);
    node = parent;
  }
  return path.join(" > ");
}`;

/** Find an element by explicit CSS selector or by visible text match. */
const LOCATE_SCRIPT = `(selector, match, kind) => {
  if (selector && typeof selector === "string" && selector.trim()) {
    try {
      const list = document.querySelectorAll(selector.trim());
      if (list.length === 0) return { error: "selector matched nothing: " + selector.trim() };
      return { el: list[0] };
    } catch (e) { return { error: "bad selector: " + e.message }; }
  }
  if (match && typeof match === "string" && match.trim()) {
    const found = (${FIND_SCRIPT})(match, kind);
    if (found) return { el: found };
    return { error: "no clickable/input element whose visible text, placeholder, or name contains: " + match };
  }
  return { error: "provide either selector or match" };
}`;

// ── plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx, cfg = {}) {
  const config = {
    chromePath: cfg.chromePath ?? "",
    headless: cfg.headless ?? true,
    noSandbox: cfg.noSandbox ?? false,
    timeoutMs: cfg.timeoutMs ?? 25000,
    screenshotDir: cfg.screenshotDir ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "browser-shots"),
    profileDir: cfg.profileDir ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "browser-profile"),
    remoteDebugBase: cfg.remoteDebugBase ?? process.env.DSH_BROWSER_DEBUG_BASE ?? "",
  };
  const browser = new BrowserManager(config);

  ctx.tools.register({
    name: "browser_navigate",
    description: [
      "Open a URL in the built-in real browser (Chromium via Chrome/Edge) and wait for the page to render.",
      "Use this instead of plain HTTP fetching when a page needs JavaScript, sets anti-bot checks, or has complex layouts — the result is the fully rendered page.",
      "Returns current URL, title, load state, and the first characters of readable text.",
      "Sessions get their own tab; the browser and any login state persist across calls in this process.",
      "Example: browser_navigate({\"url\":\"https://example.com\"}).",
    ].join("\n"),
    parameters: params({
      url: { type: "string", required: true, description: "The HTTP(S) URL to open." },
      waitMs: { type: "number", required: false, description: "Extra settle time (ms) after load before returning. Default 0." },
    }),
    output: textOutput,
    async execute(args, exec) {
      const key = String((exec && (exec.agent?.id ?? exec.agent ?? exec.session?.id)) || "shared");
      try {
        return await browser._queue(async () => {
          await browser.ensureLaunched();
          const entry = await browser.pageFor(key);
          await entry.page.send("Page.navigate", { url: String(args.url) });
          const ready = await browser.waitReady(entry.page, config.timeoutMs);
          if (args.waitMs) await sleep(Math.min(Number(args.waitMs) || 0, 60000));
          const st = await browser.pageState(entry.page);
          let head = "";
          try {
            head = await evalJs(entry.page, `(() => { const t = (document.body && document.body.innerText) || ""; return t.slice(0, 1500); })()`);
          } catch {}
          const lines = [`Opened ${st.url}`, `Title: ${st.title}`, `Load state: ${st.ready}`, `Text length: ${st.textLen}`];
          if (head.trim()) lines.push("\n" + head.trim());
          return { text: lines.join("\n") };
        });
      } catch (e) {
        return { text: `browser_navigate failed: ${e?.message ?? String(e)}` };
      }
    },
  });

  ctx.tools.register({
    name: "browser_snapshot",
    description: [
      "Read the current page of the built-in browser.",
      "mode 'text' (default): rendered readable text (auto-handles UTF-8/中文; no mojibake) with page title and URL.",
      "mode 'interactives': list clickable/input elements with an index and CSS selector so you can drive them with browser_act.",
      "mode 'both': text first, then a compact interactive-element index.",
      "Use maxChars to cap returned text (default 6000).",
      "Example: browser_snapshot({\"mode\":\"text\",\"maxChars\":8000}).",
    ].join("\n"),
    parameters: params({
      mode: { type: "string", enum: ["text", "interactives", "both"], required: false, description: "What to read. Default 'text'." },
      maxChars: { type: "number", required: false, description: "Cap on returned text chars (default 6000)." },
    }),
    output: textOutput,
    async execute(args, exec) {
      const key = String((exec && (exec.agent?.id ?? exec.agent ?? exec.session?.id)) || "shared");
      const mode = args.mode || "text";
      const maxChars = Math.max(500, Math.min(Number(args.maxChars) || 6000, 60000));
      try {
        return await browser._queue(async () => {
          await browser.ensureLaunched();
          const entry = await browser.pageFor(key);
          const st = await browser.pageState(entry.page);
          const out = [`URL: ${st.url}`, `Title: ${st.title}`, `Load state: ${st.ready}`, `Text length: ${st.textLen}`, ""];
          if (mode === "text" || mode === "both") {
            const body = await evalJs(entry.page, `(() => { const t = (document.body && document.body.innerText) || ""; return JSON.stringify({ full: t.length, part: t.slice(0, ${maxChars + 200}) }); })()`).then((s) => JSON.parse(s));
            out.push("────── rendered text ──────");
            out.push(body.part);
            if (body.full > maxChars + 200) out.push(`\n… (text truncated; full length ${body.full} chars — pass maxChars up to 60000 to read more)`);
          }
          if (mode === "interactives" || mode === "both") {
            const index = await evalJs(entry.page, `(() => {
              const cap = 150;
              const entries = [];
              const seen = new Set();
              const labelOf = (el) => {
                const raw = (el.innerText || "").replace(/\\s+/g, " ").trim()
                  || el.getAttribute("aria-label") || el.placeholder || el.value || el.name || el.textContent;
                return String(raw || el.tagName.toLowerCase()).slice(0, 60);
              };
              const push = (el, kind) => {
                if (entries.length >= cap || seen.has(el)) return;
                seen.add(el);
                const sel = (${SEL_FOR_SCRIPT})(el);
                entries.push("#" + entries.length + " [" + kind + "] " + labelOf(el) + "  →  " + sel);
              };
              for (const el of document.querySelectorAll("a")) push(el, "link");
              for (const el of document.querySelectorAll("button, input[type=button], input[type=submit], input[type=checkbox], input[type=radio], [role=button], [onclick]")) push(el, "click");
              for (const el of document.querySelectorAll("input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select")) push(el, "input");
              return entries.join("\\n") || "(no interactive elements found)";
            })()`);
            out.push("────── interactive elements (browser_act by #index, match text, or selector) ──────");
            out.push(String(index));
          }
          return { text: out.join("\n") };
        });
      } catch (e) {
        return { text: `browser_snapshot failed: ${e?.message ?? String(e)}` };
      }
    },
  });

  ctx.tools.register({
    name: "browser_act",
    description: [
      "Perform an action on the built-in browser's current page, then report the resulting page state.",
      "actions:",
      "  click    — click an element. Find it by CSS `selector`, or by `match` (visible text / placeholder / name).",
      "  type     — set text in an input/textarea (or contenteditable). Needs `selector` or `match`, plus `text`.",
      "  submit   — submit the enclosing form of `selector`/`match` (or the whole page form).",
      "  select   — pick an <option> by its text/value in a <select> found via `selector`/`match`.",
      "  back     — history back.   forward — history forward.   refresh — reload the page.",
      "  eval     — run arbitrary page JavaScript given in `js` and return its value (JSON-stringified).",
      "match uses the FIRST element whose visible text, placeholder, aria-label, or name contains the string.",
      "After click, if a new tab opened it is adopted automatically.",
      "Examples: browser_act({\"action\":\"type\",\"match\":\"手机号\",\"text\":\"13800000000\"}); browser_act({\"action\":\"click\",\"match\":\"登录\"}).",
    ].join("\n"),
    parameters: params({
      action: { type: "string", enum: ["click", "type", "submit", "select", "back", "forward", "refresh", "eval"], required: true, description: "What to do." },
      selector: { type: "string", required: false, description: "CSS selector of the target element." },
      match: { type: "string", required: false, description: "Visible text/placeholder/name to locate the target element." },
      text: { type: "string", required: false, description: "Text to type (for 'type') or option value/text (for 'select')." },
      js: { type: "string", required: false, description: "JavaScript expression to evaluate (for 'eval')." },
      waitMs: { type: "number", required: false, description: "Extra wait (ms) after the action (default 800)." },
    }),
    output: textOutput,
    async execute(args, exec) {
      const key = String((exec && (exec.agent?.id ?? exec.agent ?? exec.session?.id)) || "shared");
      const action = String(args.action || "");
      const wait = Math.min(Number(args.waitMs) ?? 800, 60000);
      try {
        return await browser._queue(async () => {
          await browser.ensureLaunched();
          const entry = await browser.pageFor(key);
          const page = entry.page;

          if (action === "back") {
            const h = await page.send("Page.getNavigationHistory");
            const idx = h.currentIndex - 1;
            if (idx >= 0) await page.send("Page.navigateToHistoryEntry", { entryId: h.entries[idx].id });
          } else if (action === "forward") {
            const h = await page.send("Page.getNavigationHistory");
            const idx = h.currentIndex + 1;
            if (idx < h.entries.length) await page.send("Page.navigateToHistoryEntry", { entryId: h.entries[idx].id });
          } else if (action === "refresh") {
            await page.send("Page.reload", { ignoreCache: true });
          } else if (action === "eval") {
            if (!args.js || typeof args.js !== "string") return { text: "eval requires the `js` parameter." };
            const raw = await evalJs(page, args.js);
            let shown;
            try { shown = typeof raw === "string" ? raw : JSON.stringify(raw); } catch { shown = String(raw); }
            return { text: String(shown ?? "undefined").slice(0, 12000) };
          } else if (action === "click") {
            const prev = await browser.pageState(page);
            const locatedRaw = await evalJs(page, `(() => { const r = (${LOCATE_SCRIPT})(${JSON.stringify(args.selector ?? "")}, ${JSON.stringify(args.match ?? "")}, "form"); if (r.error) return JSON.stringify(r); r.el.click(); return JSON.stringify({ ok: true }); })()`);
            const located = typeof locatedRaw === "string" ? JSON.parse(locatedRaw) : locatedRaw;
            if (located?.error) return { text: `click failed: ${located.error}` };
            await browser.switchToNewTabIfAny(key, entry, prev.url);
          } else if (action === "type") {
            if (args.text === undefined) return { text: "type requires the `text` parameter." };
            const locatedRaw = await evalJs(page, `(() => {
              const r = (${LOCATE_SCRIPT})(${JSON.stringify(args.selector ?? "")}, ${JSON.stringify(args.match ?? "")}, "input");
              if (r.error) return JSON.stringify(r);
              const el = r.el;
              el.focus();
              const text = ${JSON.stringify(String(args.text))};
              const tag = el.tagName;
              let setter = null;
              try {
                if (tag === "TEXTAREA") setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                else if (el.isContentEditable) { el.textContent = text; }
                else setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
              } catch {}
              if (setter) setter.call(el, text);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return JSON.stringify({ ok: true, tag, value: (el.value !== undefined ? el.value : el.textContent) });
            })()`);
            const locatedT = typeof locatedRaw === "string" ? JSON.parse(locatedRaw) : locatedRaw;
            if (locatedT?.error) return { text: `type failed: ${locatedT.error}` };
          } else if (action === "submit") {
            const locatedRaw = await evalJs(page, `(() => {
              const r = (${LOCATE_SCRIPT})(${JSON.stringify(args.selector ?? "")}, ${JSON.stringify(args.match ?? "")}, "form");
              if (r.error) return JSON.stringify(r);
              const form = r.el.tagName === "FORM" ? r.el : r.el.closest("form");
              if (!form) return JSON.stringify({ error: "element is not inside a <form>" });
              if (typeof form.requestSubmit === "function") form.requestSubmit();
              else form.submit();
              return JSON.stringify({ ok: true });
            })()`);
            const locatedS = typeof locatedRaw === "string" ? JSON.parse(locatedRaw) : locatedRaw;
            if (locatedS?.error) return { text: `submit failed: ${locatedS.error}` };
          } else if (action === "select") {
            if (args.text === undefined) return { text: "select requires the `text` (option value or label) parameter." };
            const locatedRaw = await evalJs(page, `(() => {
              const r = (${LOCATE_SCRIPT})(${JSON.stringify(args.selector ?? "")}, ${JSON.stringify(args.match ?? "")}, "input");
              if (r.error) return JSON.stringify(r);
              const sel = r.el.tagName === "SELECT" ? r.el : r.el.querySelector("select");
              if (!sel) return JSON.stringify({ error: "no <select> found at target" });
              const wanted = ${JSON.stringify(String(args.text))};
              const opt = Array.from(sel.options).find((o) => o.value === wanted || o.text.trim() === wanted);
              if (!opt) return JSON.stringify({ error: "option not found: " + wanted });
              sel.value = opt.value;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
              return JSON.stringify({ ok: true, value: opt.value, label: opt.text });
            })()`);
            const locatedSel = typeof locatedRaw === "string" ? JSON.parse(locatedRaw) : locatedRaw;
            if (locatedSel?.error) return { text: `select failed: ${locatedSel.error}` };
          } else {
            return { text: `unknown action: ${action}. Use click|type|submit|select|back|forward|refresh|eval.` };
          }

          await browser.waitReady(page, config.timeoutMs);
          if (wait) await sleep(wait);
          const st = await browser.pageState(page);
          let head = "";
          try {
            head = await evalJs(page, `(() => { const t = (document.body && document.body.innerText) || ""; return t.slice(0, 600); })()`);
          } catch {}
          const lines = [`action ${action} done`, `URL: ${st.url}`, `Title: ${st.title}`, `Load state: ${st.ready}`];
          if (head.trim()) lines.push("\n" + head.trim());
          return { text: lines.join("\n") };
        });
      } catch (e) {
        return { text: `browser_act failed: ${e?.message ?? String(e)}` };
      }
    },
  });

  ctx.tools.register({
    name: "browser_screenshot",
    description: [
      "Capture a screenshot of the built-in browser's current page (PNG) and save it to disk.",
      "Returns the saved file path; read it afterwards with read_image to see the actual pixels.",
      "fullPage true captures the whole scrollable page (can be a large file); default is the visible viewport.",
      "path overrides where the PNG is written (absolute path; else written under the screenshot dir).",
    ].join("\n"),
    parameters: params({
      fullPage: { type: "boolean", required: false, description: "Capture the whole page. Default false." },
      path: { type: "string", required: false, description: "Absolute output path override." },
    }),
    output: textOutput,
    async execute(args, exec) {
      const key = String((exec && (exec.agent?.id ?? exec.agent ?? exec.session?.id)) || "shared");
      try {
        return await browser._queue(async () => {
          await browser.ensureLaunched();
          const entry = await browser.pageFor(key);
          let clip;
          if (args.fullPage) {
            const size = await evalJs(entry.page, `JSON.stringify((() => {
              const d = document.documentElement, b = document.body;
              return { w: Math.max(d.scrollWidth, b.scrollWidth, d.clientWidth), h: Math.max(d.scrollHeight, b.scrollHeight, d.clientHeight) };
            })())`).then((s) => JSON.parse(s));
            clip = { x: 0, y: 0, width: size.w, height: size.h, scale: 1 };
          }
          const shot = await entry.page.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: !!args.fullPage,
            ...(clip ? { clip } : {}),
          });
          const buf = Buffer.from(shot.data, "base64");
          const outDir = resolve(config.screenshotDir);
          await mkdir(outDir, { recursive: true });
          const outPath = args.path && typeof args.path === "string" && args.path.trim()
            ? resolve(String(args.path).trim())
            : join(outDir, `shot-${Date.now()}.png`);
          await writeFile(outPath, buf);
          const st = await browser.pageState(entry.page);
          return { text: `Screenshot saved (${buf.length} bytes): ${outPath}\nPage: ${st.url}\nTitle: ${st.title}\nRead it with read_image.` };
        });
      } catch (e) {
        return { text: `browser_screenshot failed: ${e?.message ?? String(e)}` };
      }
    },
  });

  ctx.tools.register({
    name: "browser_close",
    description: "Shut down the built-in browser and free its resources. The browser starts again automatically on the next browser_* call.",
    parameters: params({}),
    output: textOutput,
    async execute() {
      try {
        await browser._queue(() => browser.dispose());
        return { text: "Built-in browser closed. Next browser_* call will relaunch it." };
      } catch (e) {
        return { text: `browser_close failed: ${e?.message ?? String(e)}` };
      }
    },
  });

  if (typeof ctx.effect === "function") {
    ctx.effect(function* () {
      yield async () => { await browser.dispose(); };
    }, "builtin-browser cleanup");
  }

  return browser;
}
