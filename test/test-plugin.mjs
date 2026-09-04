// Harness: load browser.mjs with a mocked cordis ctx, then execute its real
// tool functions against the persistent debug Chrome (DSH_BROWSER_DEBUG_BASE).
import { apply } from "./browser.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const defs = [];
const mockCtx = {
  tools: { register: (def) => defs.push(def) },
  effect: () => {},
  on: () => {},
  logger: { warn: () => {}, info: () => {} },
};
const browser = apply(mockCtx, {
  remoteDebugBase: "http://127.0.0.1:9333",
  profileDir: "",
  screenshotDir: "C:\\Users\\ddnin\\Documents\\nacos\\browser-tool\\shots",
  timeoutMs: 30000,
});

const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
const exec = { agent: { id: "harness-test" } };
let failures = 0;
function check(label, cond, extra = "") {
  console.log((cond ? "PASS" : "FAIL") + "  " + label + (extra ? "  | " + extra : ""));
  if (!cond) failures++;
}

const result = (name, args) => byName[name].execute(args || {}, exec);

// 1. navigate example.com
{
  const r = await result("browser_navigate", { url: "https://example.com" });
  check("navigate example.com", r.text.includes("Opened https://example.com/"), r.text.split("\n")[0]);
  check("navigate shows text", r.text.includes("Example Domain"));
}
// 2. snapshot text
{
  const r = await result("browser_snapshot", { mode: "text" });
  check("snapshot text", r.text.includes("Example Domain"));
}
// 3. snapshot interactives
{
  const r = await result("browser_snapshot", { mode: "interactives" });
  check("snapshot interactives lists link", /\[link\]/.test(r.text), r.text.split("\n").slice(0, 6).join(" | "));
}
// 4. navigate Chinese baike page (rendered, no mojibake)
{
  const r = await result("browser_navigate", { url: "https://baike.baidu.com/item/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD" });
  check("navigate baike", r.text.includes("Opened https://baike.baidu.com"), r.text.split("\n")[0]);
}
{
  const r = await result("browser_snapshot", { mode: "text", maxChars: 3000 });
  const hasChinese = /人工智能/.test(r.text) && !/鏂囨湰|鎶撳彇/.test(r.text);
  check("snapshot baike chinese utf8", hasChinese, r.text.slice(0, 120).split("\n")[2] ?? "");
}
// 5. screenshot
{
  const r = await result("browser_screenshot", {});
  const m = r.text.match(/Screenshot saved \(\d+ bytes\): (.+)/);
  check("screenshot saved", !!m && existsSync(m[1]), r.text.split("\n")[0]);
}
// 6. httpbin form: type + submit by match
{
  await result("browser_navigate", { url: "https://httpbin.org/forms/post" });
  let r = await result("browser_snapshot", { mode: "interactives" });
  check("httpbin interactives", /\[input\]/.test(r.text) && /custname|delivery/i.test(r.text));
  r = await result("browser_act", { action: "type", match: "custname", text: "张三" });
  check("type into custname", !r.text.includes("failed"), r.text.split("\n")[1] ?? "");
  r = await result("browser_act", { action: "submit", match: "Submit order" });
  check("submit form", !r.text.includes("failed"));
  r = await result("browser_snapshot", { mode: "text", maxChars: 1200 });
  check("submitted value visible", /张三|\\u5f20\\u4e09/.test(r.text), r.text.slice(0, 200));
}
// 7. eval action
{
  const r = await result("browser_act", { action: "eval", js: "location.hostname" });
  check("eval action", r.text.includes("httpbin.org"), r.text.slice(0, 80));
}
// 8. back action
{
  const before = await result("browser_act", { action: "eval", js: "location.href" });
  await result("browser_act", { action: "back" });
  const after = await result("browser_act", { action: "eval", js: "location.href" });
  check("back changes url", before.text !== after.text, `${before.text} -> ${after.text}`);
}
// 9. close & reuse (relaunch path is not exercised in attach mode)
{
  const r = await result("browser_close", {});
  check("close ok", /closed/i.test(r.text));
}

await browser.dispose();
console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
