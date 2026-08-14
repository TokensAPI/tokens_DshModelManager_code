---
summary: '宿主接入：图片在 Codex、Claude Code、Pi、OpenCode 中如何抵达模型'
read_when:
  - 在某个具体的编码 agent 里安装配置 modlens
  - 粘贴的图片没有抵达模型
  - 了解 recover-paste 在各 harness 里分别做什么
---

# 宿主接入

[English](harness-setup.md) | 中文

粘贴的图片最终落在哪里，每个 harness 都不一样，modlens 在每个 harness 里走的路线也不同。`recover-paste` 会检测自己运行在哪个 harness 里（先看进程祖先，再看环境变量指纹），只读取该 harness 的存储。

## Codex

粘贴的图片会落成真实的临时文件，消息里带着形如 `<image name=[Image #1] path="/tmp/xxxx.png">` 的标签。skill 直接从标签里读出路径。`recover-paste` 检测到 Codex 后会拒绝执行，并把你指回这个标签。

纯文本模型有一个坑：一旦 `models.json` 声明了 `input_modalities: ["text"]`，Codex TUI 会直接拦下 Ctrl+V 粘贴。改为把文件拖进终端、手动输入路径，或使用 `codex exec -i image.png "..."`。

## Claude Code、Pi、OpenCode

这三家都不像 Codex 那样递给模型一个可用的临时文件路径（较新的 Claude Code 版本确实会把粘贴写进自己的 `~/.claude/image-cache/`，但只在终端入口以路径行的形式注入），不过三者都会在网关剥离图片之前，把用户消息完整存在本地：

| Harness | 存储位置 | 说明 |
| :-- | :-- | :-- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | 图片以 base64 存储。注入的 `CLAUDE_CODE_SESSION_ID` 可精确定位当前 session |
| Pi | `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` | 结构与 Claude Code 相同 |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite，图片以 data URL 存储（通过 `node:sqlite` 读取） |

在 Claude Code 里通过 `ANTHROPIC_BASE_URL` 接入纯文本模型时，粘贴的图片要么变成一个不带路径的 `[Unsupported Image]` 占位符（宽松的网关），要么直接让请求报错（[#62009](https://github.com/anthropics/claude-code/issues/62009)）。图片字节并没有丢，`recover-paste` 取回的就是它。

## skill 的存放位置

| Harness | skill 读取位置 |
| :-- | :-- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi、OpenCode | `~/.agents/skills/` |

这些位置都支持符号链接，把 skill 目录链接一次，每个 agent 用的就都是最新版本。

## 平台支持

macOS 和 Linux 完整支持，并在 CI 上以 Node 22 和 24 验证。

Windows 跑同一套 CI 矩阵。那里没有 `ps`，检测会跳过进程祖先这一步，退回到上面的环境变量指纹，所以一个什么指纹都不设的 harness 会被判为未检出（用 `--harness` 或 `MODLENS_HARNESS` 强制指定）。OpenCode 的粘贴恢复在 Windows 上有覆盖，包括 [#11](https://github.com/liustack/modlens/issues/11) 里的路径分隔符归一化：opencode 记录的 `session.directory` 用正斜杠，而那里的 `path.resolve` 返回反斜杠，匹配前两边都会归一化。JSONL 存储（Claude Code、Pi）以 `os.homedir()` 和各 harness 自己的磁盘 slug 为键，在 POSIX 上验证。外部引擎（Antigravity CLI、Claude CLI）只在有 Windows 版本的平台上运行。

## 网关配置

OpenCode 接 DeepSeek：执行 `opencode auth login`，选择 DeepSeek 并粘贴 key（会存进 `~/.local/share/opencode/auth.json`），然后在 `~/.config/opencode/opencode.jsonc` 里把默认模型设为 `deepseek/deepseek-v4-flash`。Pi 从 `~/.pi/agent/auth.json` 读取它的 key。

## DeepSeek Harness（dsh）

dsh 与其他 harness 不同：modlens 以原生工具的形式接入，而不是靠提示词触发的 skill。本包自身就是一个 dsh bundle，一条命令即可装进某个 profile：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @liustack/modlens@latest
```

这会注册一个 `read_image` 工具，它的 schema 随每次请求抵达模型（不靠触发启发式），运行同一个包里自带的 modlens CLI，并把结构化证据作为工具的标准 JSON 输出返回。引擎、复用授权和 guard 规则仍在 `~/.modlens/config.json` 里，与其他所有 harness 共享。dsh 还在开发者预览阶段，插件接口可能变化。这个插件刻意保持很小的接触面（原生工具注册、视觉变体所用的 llm 适配层、附件读取器，以及一个 agent 执行前钩子），其中任何一处变动，它都会大声报错而不是无声退化。

### 粘贴转路径（paste-to-path，web profile）

过去在 dsh Web UI 里，**纯文本模型**下粘贴图片会死在图片准入检查这一步。插件现在带了一个浏览器端半边（由 dsh 的客户端插件系统自动加载），恰好在这种情况下接管粘贴：图片字节发到插件在 dsh web 服务器上的 `/modlens/paste` 路由（仅回环地址，校验 magic byte，上限 25 MB），落成一个私有临时文件，输入框收到的则是纯文本的文件路径。这与 Pi、OpenCode、Claude Code 递给模型的形态一致，也正是 modlens skill 和 `read_image` 工具的首要触发条件。消息里不带图片附件，准入检查根本不会触发。

接管是有条件的，且裁决权在 host 一侧：浏览器半边先向插件路由询问当前选中的模型是否纯文本，host 用 provider 注册表里声明的模型元数据（`inputModalities`）回答，而不是靠名称猜。`(modlens vision)` 变体和任何声明支持图片输入的模型都保留原生粘贴流程（变体在发请求时转换且保留缩略图，视觉模型自己读图），host 认不出的模型同样不接管：在 host 确认该接管之前，粘贴一律走原生路径。在插件配置行里设 `pasteToPath: false` 可整体关掉这个功能，路由不存在时浏览器半边会彻底停手。
