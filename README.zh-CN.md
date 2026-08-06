<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens" />
</p>

<h1 align="center">ModLens</h1>

<p align="center"><b>给纯文本模型装上视力，而且你直接粘贴就行。</b></p>

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

```bash
npx -y skills add liustack/modlens                # 装 skill
npx @liustack/modlens -i screenshot.png           # 或者直接当 CLI 用
```

DeepSeek-V4-Flash 这类模型便宜、快、能打，唯独看不见图。你甩过去一张报错截图，它一片漆黑。ModLens 把图交给真正的视觉引擎，带回你的模型能引用的证据：图里的字一句不落地转录，版面切好，读不准的地方明说。而且**你直接粘贴就行**：别的方案都要你先存成文件再报路径，ModLens 直接从会话存储里把粘贴的图捞回来。

## 亮点

- **粘贴就能用。** 粘贴的图从来不会落成文件，所以别的识图外挂都接不住。ModLens 换了条路，从 harness 的本地会话存储里捞。
- **给的是证据，不是印象。** 全文转录、版面按阅读顺序切块、实体和关系单列。模型引用的是具体内容，不是大概感觉。
- **读不准就说读不准。** 拿不准的地方进 `uncertainty`。像素坐标和置信度分数这两样视觉模型最爱编的字段，v2 直接删了。
- **模型不用换。** 你选 DeepSeek 图的是价格和推理，不是视力，这个选择不用动。
- **零 key 起步。** 默认引擎 Antigravity CLI 不要 key；领个免费 Gemini key，识图缩到 5 到 10 秒。
- **一次装好，处处能用。** Claude Code、Codex、Pi、OpenCode 都在真机上验证过。

## 安装

```bash
npx -y skills add liustack/modlens
```

或者跟你的 agent 说一句「安装这个 skill https://github.com/liustack/modlens」。

再给它一个视觉引擎。推荐 **[AI Studio](https://aistudio.google.com) 的免费 Gemini key**（三分钟，不要信用卡，识图 5 到 10 秒）：

```bash
modlens config set gemini-api.apiKey <key>
modlens config set provider gemini-api
```

不想注册就用 **Antigravity CLI**，零 key，代价是慢（15 到 40 秒）且免费额度紧：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # 浏览器登录后退出
```

需要 Node 22.13+，macOS 或 Linux。

## 用法

装完 skill 就不用记命令：粘一张图或甩个图片路径，问什么都行，skill 自己触发。手动用：

```bash
modlens -i screenshot.png                      # 本地图片
modlens -i https://example.com/chart.png       # 远程图片
modlens -i chart.png --prompt "重点看数据轴"    # 指定关注点
modlens recover-paste                          # 把刚粘贴的图捞成文件
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

`meta` 记录这份结果是怎么来的：生成时间（`generatedAt`）、用的 `model`、provider 给的 `conversationId`（没有就是 null）、实际耗时 `durationSeconds`、以及 provider 报告的原始 `usage`（结构随 provider 而定，没有就是 null）。

## 实测

以下全是原样实录，驱动的都是纯文本的 DeepSeek-V4-Flash。

Codex 桌面 App 里丢一张推文截图。配文、互动数据（2.9K 回复、270K 点赞、5M 浏览），连图片的 alt 文字都没放过。分辨率不够的地方它老实说读不清，不硬编。

![纯文本 DeepSeek 通过 ModLens 读出推文截图的全部细节](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.png)

一次粘三张图。模型自己排队逐张读，连设计意图都点出来了。

![一次丢三张图，逐张读取](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-batch.png)

压力测试：128 个模型的散点图。它认出了图表类型、双轴定义、对数刻度，还把高亮的那个点从点堆里精准拎出来（成本约 $0.028，智能指数 50）。密集图表是识图模型最容易露怯的地方。

![128 个模型的散点图，精确读出高亮点的坐标](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-chart.png)

粘贴链路的端到端实录：接了 DeepSeek 的 Claude Code，两张图直接粘进对话。界面里只剩占位符，skill 从会话存储把两张图都捞回来读了，连 PPT 封面的配色色值都读出来了。

![接了 DeepSeek 的 Claude Code 里粘贴的两张图被捞回并逐张读出](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-claude-paste-recovery.png)

## 它是怎么干活的

![纯文本模型经 modlens skill 把图片交给视觉引擎，回来的是结构化 JSON 证据](https://raw.githubusercontent.com/liustack/modlens/main/assets/flow.zh.png)

没有魔法，四步：

1. 图片出现时 skill 触发：一个路径、一个 URL，或者纯文本模型粘贴后剩下的那个占位符。
2. skill 跑 `modlens` 命令，把图交给视觉引擎。五个引擎可选，默认是免费的 Antigravity CLI。
3. 引擎的识读结果被强制装进固定的 JSON 结构：转录、版面、语义、不确定项。不合规的输出直接拒收，绝不凑合。
4. 模型引用证据，回答问题。

粘贴这一手是别家都没有的。粘贴从头到尾在客户端内部完成：图一落进对话框就被编码发走，外部工具根本没机会碰到，所以别的方案只能教你存文件报路径。但字节发走之前，harness 已经把它原样写进了本地会话记录，`recover-paste` 就是去那里捞：Claude Code 和 Pi 存 JSONL，OpenCode 存 SQLite，Codex 的粘贴本来就落成临时文件所以不需要捞。细节见[宿主接入](docs/harness-setup.md)。

| | 换个多模态模型 | 其他识图外挂（MCP server 这类） | ModLens |
| :-- | :-- | :-- | :-- |
| 你选的模型 | 得换掉 | 不用换 | 不用换 |
| 粘贴进对话的图 | 模型支持才看得见 | 接不住 | 捞回来直接读 |
| 拿到手的是什么 | 模型自己的理解 | 通常一段描述 | 全文转录、版面区块、实体关系 |
| 读不准的地方 | 可能编 | 可能编 | 进 `uncertainty` |
| 花费 | 多模态模型的价格 | 多数按 API 计费 | agy 免费额度或免费 Gemini key |

短板一并摆这儿：agy 免费额度是周配额，重度用会撞墙（换免费 Gemini key 绕开）。会话存储格式是各家 harness 的内部实现，没有兼容承诺，哪天捞不动了，拖文件永远是保底。

## CLI 参数

`modlens analyze`（默认命令）：

| 参数 | 含义 | 默认值 |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | 要解析的图片（必填） | |
| `-p, --provider <name>` | 视觉 provider | `antigravity-cli` |
| `-m, --model <name>` | provider 模型 | 按 provider（见下） |
| `-o, --output <path>` | 同时把 JSON 写入文件 | |
| `--prompt <text>` | 额外关注点 | |
| `--timeout <ms>` | provider 超时 | `180000` |
| `--provider-bin <path>` | provider 可执行文件路径 | `agy` / `claude` |
| `--workdir <path>` | provider 的工作目录 | 图片所在目录 |

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
| `--count <n>` | 恢复最近几张粘贴的图 | `1` |
| `--out-dir <path>` | 恢复的图写到哪个目录 | 每次运行新建的私有目录 `<tmpdir>/modlens-paste-*` |
| `--session <id>` | 精确锁定的 session id | 自动检测 |
| `--transcript <path>` | 显式指定 `.jsonl` 或 `.db`（优先于 `--session`） | |
| `--harness <name>` | 强制存储范围：`claude-code`、`pi`、`opencode`、`none` | 自动检测 |
| `--cwd <path>` | 图片是在哪个项目目录粘贴的 | 当前目录 |

五个 provider 可选：`antigravity-cli`（默认，零 key）、`gemini-api`（最快的免费路线）、`openai`（任何 OpenAI 兼容多模态端点）、`anthropic`、`claude-cli`（吃你的 Claude 订阅）。另有 `modlens config <init|set|show>` 管配置。

## 文档

| 文档 | 什么时候看 |
| :-- | :-- |
| [故障排查](docs/troubleshooting.md) | 命令报错，想知道成因和解法 |
| [配置手册](skills/modlens/references/configure.md) | 配 key、换 provider、排查配置 |
| [输出契约](skills/modlens/references/output-schema.md) | 要解析 JSON 或写下游工具 |
| [宿主接入](docs/harness-setup.md) | 在 Codex、Claude Code、Pi、OpenCode 里配置 |
| [安全说明](docs/security.md) | 恢复文件的权限、图片内容作为不可信输入 |
| [更新日志](CHANGELOG.md) | 想知道某个版本改了什么 |
| [AGENTS.md](AGENTS.md) | 要改这个项目的代码 |

## 参与方式

本仓不收 PR。工具小，一双手维护，每一行代码都要作者自己背，这个闭环收紧了它才可靠。真正帮得上忙的两条路：

- **[提 issue](https://github.com/liustack/modlens/issues)。** bug、想法、看不懂的报错、读着别扭的文档都算。issue 一定会被读，也真的会影响接下来做什么。
- **Fork。** MIT 协议下你的副本完全归你：改名、魔改、发布都随意。

## 关注公众号

AI 工具、实践与想法，第一时间推送。微信扫码，或搜一搜「liustack」关注：

<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/wechat-qrcode.png" width="420" alt="微信公众号 liustack" />
</p>

⭐ 好用的话给 [ModLens](https://github.com/liustack/modlens) 点个 star，这是下一个开发者找到它的方式。

## 免责声明

本项目依下方 MIT 协议按现状提供。作者不对任何特定用途（含商业使用）提供保证或背书。上游引擎（Antigravity CLI，Gemini、OpenAI、Anthropic 的 API，以及任何 OpenAI 兼容端点）的使用受各自条款和额度约束，由使用者自行负责。

## License

MIT
