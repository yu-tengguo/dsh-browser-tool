#!/usr/bin/env node
/**
 * dsh-browser-tool — one-command installer for DeepSeek Harness (DSH).
 *
 * What it does:
 *   1. locates your DSH home  (env DSH_HOME, else ~/.dsh)
 *   2. creates the agent preset `standard-browser` under
 *      <DSH_HOME>/.agent-presets/standard-browser
 *   3. copies browser.mjs into it and appends the `builtin-browser` row to
 *      agent.cordis.yml — using your installed product `standard` preset as
 *      the base when it can be found, otherwise a browser-only minimal preset
 *      (loud warning)
 *   4. writes preset.yml (display name 「标准模式 · 内置浏览器」)
 *   5. optionally sets agent-presets.default = standard-browser in
 *      <DSH_HOME>/settings.yaml so NEW sessions pick it up automatically
 *      (never overrides an existing default you already chose)
 *
 * Prerequisites: Node >= 22, a local Chrome or Edge, and a DeepSeek Harness
 * deployment. No npm dependencies are installed and no browser is downloaded.
 *
 * Usage:
 *   node install.mjs                 # typical
 *   DSH_PACKAGE_DIR=... node install.mjs   # point at the dsh install dir if
 *                                          # auto-detection misses it
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SOURCE = join(HERE, "browser.mjs");
const PRESET_ID = "standard-browser";
const DISPLAY_NAME = "标准模式 · 内置浏览器";
const ROW_BLOCK = [
  "",
  "# builtin-browser — installed by dsh-browser-tool install.mjs",
  "- id: builtin-browser",
  "  name: ./browser.mjs",
  "  config:",
  "    headless: true",
  "",
].join("\n");
const SETTINGS_BLOCK = "agent-presets:\n  default: " + PRESET_ID + "\n";

const fail = (msg) => { console.error("\n[FAIL] " + msg); process.exit(1); };
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) fail("Node >= 22 is required (global fetch/WebSocket); you have " + process.versions.node);

// ── 1. DSH home ─────────────────────────────────────────────────────────────
const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const presetDir = join(dshHome, ".agent-presets", PRESET_ID);
console.log("[1/5] DSH home:", dshHome);

// ── 2. plugin file must exist next to this script ───────────────────────────
if (!existsSync(PLUGIN_SOURCE)) fail("browser.mjs not found next to install.mjs (" + PLUGIN_SOURCE + ")");

// ── 3. locate the installed product `standard` preset (base composition) ────
const COMPOSITION = "agent.cordis.yml";
function findProductStandard() {
  if (process.env.DSH_PACKAGE_DIR) {
    const p = join(process.env.DSH_PACKAGE_DIR, "config", "agent-presets", "standard", COMPOSITION);
    if (existsSync(p)) return p;
  }
  // npm global root: `npm root -g`
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15000 });
    if (!r.error && r.status === 0) {
      const p = join(String(r.stdout).trim(), "@deepseek-ai", "dsh", "config", "agent-presets", "standard", COMPOSITION);
      if (existsSync(p)) return p;
    }
  } catch { /* keep probing */ }
  // dsh launcher inside a node_modules/.bin → sibling @deepseek-ai/dsh
  try {
    const which = process.platform === "win32" ? spawnSync("where", ["dsh"], { encoding: "utf8", timeout: 10000 })
                                               : spawnSync("which", ["dsh"], { encoding: "utf8", timeout: 10000 });
    const line = String(which.stdout || "").split(/\r?\n/).find((l) => l.trim());
    if (line) {
      const binPath = resolve(line.trim());
      const nmIdx = binPath.indexOf(`${process.platform === "win32" ? "\\" : "/"}node_modules${process.platform === "win32" ? "\\" : "/"}${process.platform === "win32" ? "\\" : "/"}`);
      const nmDir = nmIdx >= 0 ? binPath.slice(0, nmIdx + 1) : null; // placeholder, refined below
      const candidates = [binPath];
      // climb from the launcher looking for node_modules/@deepseek-ai/dsh
      let dir = dirname(binPath);
      for (let i = 0; i < 6 && dir.length > 3; i++) {
        const p = join(dir, "@deepseek-ai", "dsh", "config", "agent-presets", "standard", COMPOSITION);
        if (existsSync(p)) return p;
        const up = resolve(dir, "..");
        if (up === dir) break;
        dir = up;
      }
      void nmDir; void candidates;
    }
  } catch { /* keep probing */ }
  return null;
}

const productBase = findProductStandard();
mkdirSync(presetDir, { recursive: true });
console.log("[2/5] preset dir:", presetDir);

// ── 4a. agent.cordis.yml: base + builtin-browser row ────────────────────────
const compositionPath = join(presetDir, COMPOSITION);
const hasRow = (content) => /(^|\n)\s*- id:\s*builtin-browser\s*\n/m.test(content);
if (existsSync(compositionPath)) {
  const existing = readFileSync(compositionPath, "utf8");
  if (hasRow(existing)) {
    console.log("[3/5] agent.cordis.yml already mounts builtin-browser — left untouched");
  } else {
    writeFileSync(compositionPath, existing.replace(/\s*$/, "\n") + "\n" + ROW_BLOCK.trimStart());
    console.log("[3/5] appended builtin-browser row to existing agent.cordis.yml");
  }
} else if (productBase) {
  const base = readFileSync(productBase, "utf8");
  writeFileSync(compositionPath, base.replace(/\s*$/, "\n") + "\n" + ROW_BLOCK.trimStart());
  console.log("[3/5] agent.cordis.yml created from product `standard` preset + builtin-browser");
} else {
  writeFileSync(compositionPath, ROW_BLOCK.trimStart());
  console.warn(
    "[3/5] WARNING: could not locate the installed product `standard` preset, so agent.cordis.yml\n" +
    "      contains ONLY the builtin-browser row. Sessions on this preset will have the browser\n" +
    "      tools but not the full Standard toolset. Set DSH_PACKAGE_DIR=<dsh install dir> and\n" +
    "      re-run, or merge your own preset manually (see docs/install.md)."
  );
}

// ── 4b. browser.mjs copy (back up any different existing copy) ──────────────
const pluginDest = join(presetDir, "browser.mjs");
const src = readFileSync(PLUGIN_SOURCE, "utf8");
if (existsSync(pluginDest) && readFileSync(pluginDest, "utf8") !== src) {
  const bak = pluginDest + ".bak-" + Date.now();
  renameSync(pluginDest, bak);
  console.log("[4/5] backed up previous browser.mjs ->", bak);
}
copyFileSync(PLUGIN_SOURCE, pluginDest);
console.log("[4/5] browser.mjs installed (", src.length, "bytes )");

// ── 4c. preset.yml ──────────────────────────────────────────────────────────
const presetYml = join(presetDir, "preset.yml");
if (!existsSync(presetYml)) {
  writeFileSync(presetYml, [
    "name: " + DISPLAY_NAME,
    "description: " + DISPLAY_NAME + "——完整标准模式能力并内置浏览器工具（browser_navigate / browser_snapshot / browser_act / browser_screenshot）。",
    "order: 2",
    "",
  ].join("\n"));
  console.log("[5/5] preset.yml created");
}

// ── 5. settings default (never override an existing agent-presets.default) ───
const settingsPath = join(dshHome, "settings.yaml");
if (!existsSync(settingsPath)) {
  writeFileSync(settingsPath, SETTINGS_BLOCK);
  console.log("[5/5] settings.yaml created with agent-presets.default =", PRESET_ID);
} else {
  const settings = readFileSync(settingsPath, "utf8");
  if (/^agent-presets:\s*$/m.test(settings)) {
    console.log("[5/5] settings.yaml already has an agent-presets section — default left as-is");
  } else {
    writeFileSync(settingsPath, settings.replace(/\s*$/, "\n") + "\n" + SETTINGS_BLOCK);
    console.log("[5/5] agent-presets.default =", PRESET_ID, "added to settings.yaml");
  }
}

// ── summary ─────────────────────────────────────────────────────────────────
const chromeHints = process.platform === "win32"
  ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
     "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
     "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
     "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
const chrome = chromeHints.find((p) => existsSync(p));
console.log("\nBrowser backend: " + (chrome ? chrome + " (found)" : "NOT FOUND — install Chrome/Edge or set chromePath/CHROME_PATH"));

console.log("\n✅ Install complete.");
console.log("Next steps:");
console.log("  1. Restart the dsh web UI (or start a NEW session).");
console.log("  2. The preset 「" + DISPLAY_NAME + "」 should be active by default.");
console.log("     If not, pick it in the preset dropdown of the new session.");
console.log("  3. Try: 打开 https://example.com 并读取内容");
console.log("Uninstall: remove the folder " + presetDir + " and drop the agent-presets section from " + settingsPath);
