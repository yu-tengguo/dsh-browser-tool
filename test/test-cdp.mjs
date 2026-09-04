// Minimal CDP smoke test: launch local Chrome headless, create a page target,
// navigate, read rendered text, take a screenshot. Zero third-party deps.
// Uses Node built-ins + global fetch/WebSocket (Node >= 22).

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor(url, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await probe();
      if (res) return res;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}: ${lastErr?.message ?? "no response"}`);
}

class Cdp {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.seq = 0; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evalJs(page, expression) {
  const r = await page.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  }
  return r.result?.value;
}

async function main() {
  const url = process.argv[2] || "https://example.com";
  const attachPort = process.env.DSH_CDP_PORT || "9333";
  const base = `http://127.0.0.1:${attachPort}`;

  // create a fresh page target (PUT required on modern Chrome)
  const created = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json();
  console.log("[ok] created target", created.id, created.webSocketDebuggerUrl);

  const page = new Cdp(created.webSocketDebuggerUrl);
  await page.open();
  await page.send("Page.enable");

  await page.send("Page.navigate", { url });
  await waitFor("load", 25000, async () => {
    const ready = await evalJs(page, "document.readyState");
    return ready === "complete" ? true : null;
  });

  const info = await evalJs(page, `JSON.stringify({
    url: location.href,
    title: document.title,
    ready: document.readyState,
    textLen: (document.body ? document.body.innerText : "").length,
    textHead: (document.body ? document.body.innerText : "").slice(0, 400)
  })`);
  console.log("[page]", info);

  const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const outDir = "C:\\Users\\ddnin\\Documents\\nacos\\browser-tool";
  mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}\\smoke-shot.png`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  console.log("[ok] screenshot bytes", Buffer.from(shot.data, "base64").length, "->", outPath);

  page.close();
  console.log("[done]");
}

main().catch((e) => { console.error("FAIL:", e); process.exitCode = 1; });
