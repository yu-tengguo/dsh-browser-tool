// Interaction test: type into form fields, submit, verify result. Attaches to
// the persistent Chrome started on DSH_CDP_PORT (default 9333).
const base = `http://127.0.0.1:${process.env.DSH_CDP_PORT || "9333"}`;

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
  if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}
async function waitComplete(page, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await evalJs(page, "document.readyState === 'complete'")) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("load timeout");
}

const created = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json();
const page = new Cdp(created.webSocketDebuggerUrl);
await page.open();
await page.send("Page.enable");

await page.send("Page.navigate", { url: "https://httpbin.org/forms/post" });
await waitComplete(page);

// 1) type into textarea by CSS selector
const typed = await evalJs(page, `(() => {
  const el = document.querySelector('textarea[name="comments"]');
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, '内置浏览器测试 comment 中文');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`);
console.log("[type] textarea =", typed);

// 2) type into input[name=custname]
await evalJs(page, `(() => {
  const el = document.querySelector('input[name="custname"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '张三');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`);

// 3) check a radio + submit via form.requestSubmit()
await evalJs(page, `(() => {
  const radio = document.querySelector('input[name="custtype"][value="business"]');
  if (radio) radio.click();
  const form = document.querySelector('form');
  if (form) form.requestSubmit();
  return true;
})()`);

await new Promise((r) => setTimeout(r, 2500));
await waitComplete(page, 15000).catch(() => {});
const result = await evalJs(page, `JSON.stringify({ url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 900) })`);
console.log("[submit-result]", result);
page.close();
console.log("[done]");
