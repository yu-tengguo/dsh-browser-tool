# 安装指南（Installation Guide）

把 `browser.mjs` 挂到 DSH 的 agent 预设上，新会话的工具列表里就会出现
`browser_navigate` / `browser_snapshot` / `browser_act` / `browser_screenshot` / `browser_close`。

> 前提：本机装有 Chrome 或 Edge（插件默认自动检测；也可以用 `chromePath` / 环境变量 `CHROME_PATH` 指定）。

## 方式零：一键安装脚本（最快）

仓库根目录运行（Node ≥ 22）：

```bash
node install.mjs
```

脚本自动完成：定位 `$DSH_HOME` → 创建 `~/.dsh/.agent-presets/standard-browser` → 复制 `browser.mjs`
→ 以产品 `standard` 组合为基底写入 `agent.cordis.yml` 并挂载 `builtin-browser` → 生成 `preset.yml`
→ 在 `settings.yaml` 写入默认预设（若你已自定义过 default 则不覆盖）。幂等，可重复执行。

> 若自动探测不到产品 standard 组合（报 WARNING 并降级为仅含浏览器工具的极简预设），
> 可带 `DSH_PACKAGE_DIR=<dsh安装目录>` 重跑，或按下方手动方式合并。

## 方式一：新建用户预设（推荐，可设为默认）

1. 创建预设目录（Windows 示例）：

   ```powershell
   $preset = "$env:USERPROFILE\.dsh\.agent-presets\standard-browser"
   New-Item -ItemType Directory -Force $preset
   Copy-Item .\browser.mjs $preset\browser.mjs
   ```

   macOS / Linux 请把 `$env:USERPROFILE\.dsh` 换成 `~/.dsh`。

2. 复制一份你常用预设的组合文件作为基底（例如产品自带的 `standard`）：

   ```powershell
   # 找到 dsh 安装目录里的标准预设
   $dsh = npm root -g   # 或 dsh 实际安装路径
   Copy-Item "$dsh\@deepseek-ai\dsh\config\agent-presets\standard\agent.cordis.yml" "$preset\agent.cordis.yml"
   ```

   并在该文件**末尾追加**一行：

   ```yaml
   - id: builtin-browser
     name: ./browser.mjs
     config:
       headless: true
   ```

3. 写显示名 `preset.yml`：

   ```yaml
   name: 标准模式 · 内置浏览器
   description: 标准模式的完整能力，并内置浏览器工具。
   order: 2
   ```

4. （可选）把该预设设为默认，新会话自动生效：

   ```yaml
   # 追加到 ~/.dsh/settings.yaml
   agent-presets:
     default: standard-browser
   ```

5. 重启 `dsh web`，新建会话，选择预设「标准模式 · 内置浏览器」。

> 注意：DSH 中**同名预设以系统内置为准**（first-root-wins），所以请用新目录名（如
> `standard-browser`），不要覆盖系统 `standard` 目录。

## 方式二：挂到已存在的自定义预设

如果你已有自己的用户预设（例如 `~/.dsh/.agent-presets/my-preset/`）：

```powershell
Copy-Item .\browser.mjs "~/.dsh/.agent-presets/my-preset\browser.mjs"
```

然后在该预设的 `agent.cordis.yml` 末尾追加：

```yaml
- id: builtin-browser
  name: ./browser.mjs
  config:
    chromePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'  # 可选
    headless: true
```

重启并新开会话即可。

## 验证

新会话里直接说：

> 打开 https://example.com 并把内容读给我

预期：agent 调用 `browser_navigate` / `browser_snapshot`，而不是让你装 skill。
首次调用会拉起一个 headless Chrome（约 1–2 秒），cookie 保存在 `~/.dsh/browser-profile`（重启保留，删除即重置）。

## 常见配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `chromePath` | 自动检测 | Chrome/Edge 可执行文件路径；或设环境变量 `CHROME_PATH` |
| `headless` | `true` | `false` 时显示浏览器窗口（人工配合验证码登录） |
| `noSandbox` | `false` | 追加 `--no-sandbox`（仅开发/CI） |
| `timeoutMs` | `25000` | 页面加载等待上限 |
| `profileDir` | `$DSH_HOME/browser-profile` | 持久化登录态；删除目录即重置 |
| `screenshotDir` | `$DSH_HOME/browser-shots` | 截图输出目录 |

调试：设 `DSH_BROWSER_DEBUG_BASE=http://127.0.0.1:9333` 可附加到已运行的 Chrome 而非新启动。

## 卸载 / 回滚

```powershell
Remove-Item -Recurse "$env:USERPROFILE\.dsh\.agent-presets\standard-browser"
# 并删除 settings.yaml 中的 agent-presets.default（如已设置）
```
