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

DeepSeek-V4-Flash 这类纯文本模型没有视觉能力，无法处理截图和图片。ModLens 把图片交给真正的视觉引擎，返回模型可以引用的结构化证据：图中文字逐句转录，版面按阅读顺序划分区块，读不准的部分明确标出。它还解决了一个别家没有解决的问题：**直接粘贴进对话的图片也能识别**，无需先保存成文件再提供路径。

## 亮点

- **返回证据，而非印象。** 全文转录、按阅读顺序划分的版面区块、实体与关系列表，模型引用的是具体内容。
- **免费起步。** 默认引擎 Antigravity CLI 无需 key。配一个免费的 Gemini key 可将识别耗时降至 5 到 10 秒。
- **一次安装，多端可用。** Claude Code、Codex、Pi、OpenCode 均经真机验证。

## 安装

**第一步，准备一个视觉引擎（唯一需要你亲手做的）。** 推荐免费的 Gemini key：到 [Google AI Studio](https://aistudio.google.com) 领取，约三分钟，无需信用卡。

想完全免注册就改装 Antigravity CLI，在浏览器完成本人登录：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                                                           # 浏览器完成登录后退出
```

**第二步，剩下的交给你的 AI。** 把这句话发给它，用 Gemini key 的话把 key 一起发：

> 按 https://github.com/liustack/modlens 的 INSTALL.md 安装并配置 modlens skill，完成后运行体检并把结果告诉我。

## 用法

装好之后不需要记任何命令。正常聊天，粘贴图片或给出图片路径，提问即可，skill 自动触发：图片交给视觉引擎，答案基于读到的内容返回。

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

## 文档

| 文档 | 适用场景 |
| :-- | :-- |
| [CLI 手册](skills/modlens/references/cli.md) | skill 所驱动的 CLI：参数、配置与体检 |
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

## 插入硬广一条

关注微信公众号「liustack」：AI 工具、实践与想法，第一时间推送。微信扫码，或搜一搜「liustack」：

<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/wechat-qrcode.png" width="420" alt="微信公众号 liustack" />
</p>

⭐ 如果它对你有用，请给 [ModLens](https://github.com/liustack/modlens) 一个 star，这是其他开发者找到它的方式。

## 免责声明

本项目依下方 MIT 协议按现状提供。作者不对任何特定用途（含商业使用）提供保证或背书。上游引擎（Antigravity CLI，Gemini、OpenAI、Anthropic 的 API，以及任何 OpenAI 兼容端点）的使用受各自条款和额度约束，由使用者负责。

## License

MIT
