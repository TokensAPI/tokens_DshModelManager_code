<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens" />
</p>

<h1 align="center">ModLens</h1>

<p align="center"><b>为纯文本模型补上视觉能力，粘贴的图片也能直接识别。</b></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="docs/troubleshooting.md">故障排查</a> ·
  <a href="skills/modlens/references/configure.md">配置</a> ·
  <a href="skills/modlens/references/output-schema.md">输出契约</a> ·
  <a href="docs/security.md">安全</a> ·
  <a href="https://github.com/liustack/modsearch">ModSearch（联网）</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/liustack/modlens/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/liustack/modlens/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@liustack/modlens?style=flat-square" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

```text
把这句话发给你的 AI：按 https://github.com/liustack/modlens 的 INSTALL.md 安装并配置 modlens skill
```

DeepSeek-V4-Flash 这类纯文本模型没有视觉能力，无法处理截图和图片。ModLens 把图片交给真正的视觉引擎，返回模型可以引用的结构化证据：图中文字逐句转录，版面按阅读顺序划分区块，读不准的部分明确标出。它还解决了一个别家没有解决的问题：**直接粘贴进对话的图片也能识别**，无需先保存成文件再提供路径。

## 亮点

- **粘贴的图片可恢复。** 粘贴的图片不会落成文件，其他视觉方案因此无法处理。ModLens 从宿主的本地会话存储中将它恢复出来。
- **返回证据，而非印象。** 全文转录、按阅读顺序划分的版面区块、实体与关系列表，模型引用的是具体内容。
- **不确定性明确标注。** 读不准的内容进入 `uncertainty` 字段。像素坐标和置信度这两类视觉模型最常编造的数据已被移除。
- **不更换模型。** 选择 DeepSeek 是为了价格和推理能力，这个选择不需要改变。
- **免费起步。** 默认引擎 Antigravity CLI 无需 key。配一个免费的 Gemini key 可将识别耗时降至 5 到 10 秒。
- **一次安装，多端可用。** Claude Code、Codex、Pi、OpenCode 均经真机验证。

## 安装

把下面这句话发给你的 AI，它会完成安装、配置和验证，并把结果告诉你：

> 按 https://github.com/liustack/modlens 的 INSTALL.md 安装并配置 modlens skill，完成后运行体检并把结果告诉我。

推荐引擎是免费的 Gemini key：到 [Google AI Studio](https://aistudio.google.com) 领取（约三分钟，无需信用卡），把 key 发给你的 AI 让它配置。

想完全免注册就用 Antigravity CLI。**唯一需要亲手做的一步**是它的浏览器登录：你的 AI 装好之后，运行 `agy` 完成登录即可。

## 用法

安装 skill 后无需记忆命令：粘贴图片或给出图片路径，提问即可，skill 自动触发。手动使用：

```bash
modlens -i screenshot.png                      # 本地图片
modlens -i https://example.com/chart.png       # 远程图片
modlens -i chart.png --prompt "重点看数据轴"    # 指定关注点
modlens recover-paste                          # 将刚粘贴的图片恢复为文件
```

输出是结构固定的 JSON：

```json
{
  "image": "/path/to/screenshot.png",
  "provider": "gemini-api",
  "result": {
    "summary": "四个节点的工作流图，箭头带标注。",
    "ocr": { "full_text": "/shaping\nBEFORE YOU BUILD\n...", "lines": [] },
    "layout": { "regions": [{ "reading_order": 1, "type": "title", "text": "/shaping" }] },
    "uncertainty": []
  },
  "meta": {
    "generatedAt": "2026-08-06T12:00:00.000Z",
    "model": "gemini-3.6-flash",
    "conversationId": null,
    "durationSeconds": 6.4,
    "usage": { "promptTokenCount": 1234, "candidatesTokenCount": 567 }
  }
}
```

`meta` 记录结果的产生过程：生成时间（`generatedAt`）、使用的 `model`、provider 返回的 `conversationId`（无则为 null）、实际耗时 `durationSeconds`，以及 provider 报告的原始 `usage`（结构随 provider 而异，无则为 null）。

## 实测

以下均为原样记录，驱动的都是纯文本的 DeepSeek-V4-Flash。

Codex 桌面 App 中识别一张推文截图。配文、互动数据（2.9K 回复、270K 点赞、5M 浏览）以及图片的 alt 文字全部读出。分辨率不足的部分明确说明无法确认，没有编造。

![纯文本 DeepSeek 通过 ModLens 读出推文截图的全部细节](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.png)

一次粘贴三张图。模型依次读取，包括对设计意图的判断。

![一次粘贴三张图，逐张读取](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-batch.png)

压力测试：128 个模型的散点图。图表类型、双轴定义、对数刻度全部识别，并从密集点群中准确读出高亮点的位置（成本约 $0.028，智能指数 50）。密集图表是视觉模型最容易出错的场景。

![128 个模型的散点图，精确读出高亮点的坐标](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-chart.png)

粘贴链路的端到端记录：接入 DeepSeek 的 Claude Code，两张图直接粘贴进对话。界面中只显示占位符，skill 从会话存储恢复两张图片并逐一读出，包括 PPT 封面的配色色值。

![接入 DeepSeek 的 Claude Code 中，粘贴的两张图被恢复并逐张读出](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-claude-paste-recovery.png)

## 工作原理

![纯文本模型经 modlens skill 把图片交给视觉引擎，返回结构化 JSON 证据](https://raw.githubusercontent.com/liustack/modlens/main/assets/flow.zh.png)

四个步骤：

1. 图片出现时 skill 触发：一个路径、一个 URL，或纯文本模型粘贴后留下的占位符。
2. skill 运行 `modlens` 命令，将图片交给视觉引擎。五个引擎可选，默认为免费的 Antigravity CLI。
3. 引擎的识别结果被强制装入固定的 JSON 结构：转录、版面、语义、不确定项。不符合结构的输出直接报错，不做修补。
4. 模型引用证据作答。

粘贴恢复是其他方案没有的能力。粘贴由客户端内部处理：图片进入对话框后立即被编码发送，外部工具无法接触，因此其他方案只能要求先保存文件。但在字节发出之前，宿主已将其原样写入本地会话记录，`recover-paste` 从那里恢复：Claude Code 和 Pi 使用 JSONL，OpenCode 使用 SQLite，Codex 的粘贴本身就有临时文件，无需恢复。细节见[宿主接入](docs/harness-setup.md)。

| | 更换多模态模型 | 其他视觉方案（MCP server 等） | ModLens |
| :-- | :-- | :-- | :-- |
| 现有模型 | 需要更换 | 保留 | 保留 |
| 粘贴进对话的图片 | 取决于模型支持 | 无法处理 | 恢复后识别 |
| 返回内容 | 模型自身的理解 | 通常为一段描述 | 全文转录、版面区块、实体关系 |
| 读不准的部分 | 可能编造 | 可能编造 | 进入 `uncertainty` |
| 成本 | 多模态模型价格 | 多按 API 计费 | agy 免费额度或免费 Gemini key |

限制如下：agy 免费额度按周发放，重度使用会耗尽（免费 Gemini key 可替代）。会话存储格式是各宿主的内部实现，没有兼容承诺。恢复方式失效时，将图片文件拖入终端始终可用。

## CLI 参数

`modlens analyze`（默认命令）：

| 参数 | 含义 | 默认值 |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | 要识别的图片（必填） | |
| `-p, --provider <name>` | 视觉 provider | `antigravity-cli` |
| `-m, --model <name>` | provider 模型 | 按 provider（见下） |
| `-o, --output <path>` | 同时将 JSON 写入文件 | |
| `--prompt <text>` | 额外关注点 | |
| `--timeout <ms>` | provider 超时 | `180000` |
| `--provider-bin <path>` | provider 可执行文件路径 | `agy` / `claude` |
| `--workdir <path>` | provider 的工作目录 | 每次运行新建的隔离目录 |

`-m` 的默认模型取决于 provider：

| Provider | 默认模型 |
| :-- | :-- |
| `antigravity-cli`（默认） | `gemini-3.6-flash-low` |
| `gemini-api` | `gemini-3.6-flash` |
| `anthropic` | `claude-haiku-4-5-20251001` |
| `claude-cli` | `haiku` |
| `openai` | 无默认，必须指定 `-m` |

`modlens recover-paste`：

| 参数 | 含义 | 默认值 |
| :-- | :-- | :-- |
| `--count <n>` | 恢复最近几张粘贴的图片 | `1` |
| `--out-dir <path>` | 恢复文件的输出目录 | 每次运行新建的私有目录 `<tmpdir>/modlens-paste-*` |
| `--session <id>` | 精确指定 session id | 自动检测 |
| `--transcript <path>` | 显式指定 `.jsonl` 或 `.db`（优先于 `--session`） | |
| `--harness <name>` | 限定存储范围：`claude-code`、`pi`、`opencode`、`none` | 自动检测 |
| `--cwd <path>` | 图片粘贴时所在的项目目录 | 当前目录 |

五个 provider：`antigravity-cli`（默认，无需 key）、`gemini-api`（最快的免费路线）、`openai`（任何 OpenAI 兼容多模态端点）、`anthropic`（Claude API）、`claude-cli`（使用现有 Claude 订阅）。另有两个子命令：`modlens config <init|set|show>` 管理配置，`modlens doctor` 输出本机诊断（Node 版本、各 provider 就绪状态、最终选用的 provider 及原因、检测到的宿主），不消耗额度、不发起网络请求，`--json` 输出可供程序消费。

## 文档

| 文档 | 适用场景 |
| :-- | :-- |
| [故障排查](docs/troubleshooting.md) | 命令报错，查成因和解法 |
| [配置手册](skills/modlens/references/configure.md) | 配置 key、切换 provider、排查配置 |
| [输出契约](skills/modlens/references/output-schema.md) | 解析 JSON 或构建下游工具 |
| [宿主接入](docs/harness-setup.md) | 在 Codex、Claude Code、Pi、OpenCode 中配置 |
| [安全说明](docs/security.md) | 恢复文件的权限、图片内容作为不可信输入 |
| [更新日志](CHANGELOG.md) | 查询版本变更 |
| [AGENTS.md](AGENTS.md) | 修改本项目代码 |

## 参与方式

本仓库不接受 PR。项目由作者独立维护，所有代码经作者本人审阅，这是它可靠性的前提。两种有效的参与方式：

- **[提交 issue](https://github.com/liustack/modlens/issues)。** bug、建议、难以理解的报错或文档都欢迎。issue 会被认真阅读，并影响后续开发方向。
- **Fork。** MIT 协议下你的副本完全归你，修改和发布不受限制。

## 关注公众号

AI 工具、实践与想法，第一时间推送。微信扫码，或搜索「liustack」关注：

<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/wechat-qrcode.png" width="420" alt="微信公众号 liustack" />
</p>

⭐ 如果它对你有用，请给 [ModLens](https://github.com/liustack/modlens) 一个 star，这是其他开发者找到它的方式。

## 免责声明

本项目依下方 MIT 协议按现状提供。作者不对任何特定用途（含商业使用）提供保证或背书。上游引擎（Antigravity CLI，Gemini、OpenAI、Anthropic 的 API，以及任何 OpenAI 兼容端点）的使用受各自条款和额度约束，由使用者负责。

## License

MIT
