<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens" />
</p>

<h1 align="center">ModLens</h1>

<p align="center"><b>为纯文本模型补上视觉能力，直接粘贴图片就能识别。</b></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="docs/troubleshooting.md">故障排查</a> ·
  <a href="skills/modlens/references/configure.md">配置</a> ·
  <a href="docs/output-schema.md">输出契约</a> ·
  <a href="docs/security.md">安全</a> ·
  <a href="https://github.com/liustack/modsearch">ModSearch（联网）</a>
</p>

<p align="center">
  <a href="https://x.com/liustack"><img src="https://img.shields.io/badge/follow-%40liustack-black?style=flat-square&logo=x&logoColor=white" alt="Follow @liustack on X"></a>
  <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@liustack/modlens?style=flat-square" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/Not%20backed%20by-Y%20Combinator-FF6600?style=flat-square&logo=ycombinator&logoColor=white" alt="Not backed by Y Combinator">
  <img src="https://img.shields.io/badge/users-unknown-lightgrey?style=flat-square" alt="Users unknown">
</p>

DeepSeek 和 GLM 没有视觉能力，无法进行图片识别。ModLens 借助外挂视觉引擎，为纯文本模型补上视觉能力。**ModLens 支持直接粘贴图片识别**，无需先保存成文件再提供路径。

## 交流

欢迎随时提[issue](https://github.com/liustack/modlens/issues/new/choose)。也欢迎来 X 上聊：**[@liustack](https://x.com/liustack)**，你用它做了什么、在哪个 harness 上跑、接下来该做什么，新版本也是那边先发。社群正在筹备中。

## 亮点

**🥇 全网第一个支持 DeepSeek Harness（dsh）的外挂视觉识别插件：**一条命令 `dsh plugin --profile web add @liustack/modlens`，dsh 背后的纯文本 DeepSeek 模型即可读图，原生 `read_image` 工具加粘贴图片自动识别。

**直接粘贴图片识别** 无需先保存成文件再提供路径。

- **零配置起手。** 复用 Claude Code、Codex、OpenCode、Pi 已配置，直接复用你本机的其他多模态模型。什么都没有？Antigravity CLI 是免 key 的免费通道，配一个免费 Gemini key 可将识别耗时降至 5 到 10 秒。
- **基于证据而非想象。** 全文转录、按阅读顺序划分的版面区块、实体与关系列表，模型引用的是具体内容。
- **一次安装，多端可用。** Claude Code、Codex、Pi、OpenCode 均经真机验证。

## 安装

**第一步，交给你的 AI。** 把这句话发给它：

> 按 https://github.com/liustack/modlens 的 INSTALL.md 安装并配置 modlens skill，完成后运行体检并把结果告诉我。

安装会先盘点你机器上已有的东西。Claude Code、Codex、OpenCode 或 Pi 里任何一个已有的登录态都可能就够了：modlens 复用前一定先征得你同意，体检报告会说清现状。

**第二步，只在体检两手空空时，才需要你配一个免费引擎。** 推荐免费的 Gemini api key（到 [Google AI Studio](https://aistudio.google.com) 领取，约三分钟，无需信用卡），配上后每次识别 5 到 10 秒。其他平台的免费 openai 兼容 key 也行。想完全免注册就装 Antigravity CLI，然后完成登录：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                                                           # 浏览器完成登录后退出
```

安装还会盘点本机其他 harness CLI（Codex、OpenCode、Pi）里可触达的视觉能力，并逐个询问是否允许 modlens 复用。获准的登录态与你自己配的引擎平级入池，每次复用都会在结果里标明花的是谁的额度。

## 用法

装好之后不需要记任何命令。正常聊天，粘贴图片或给出图片路径，提问即可，skill 自动触发：图片交给视觉引擎，答案基于读到的内容返回。

## 实测

以下均为原样记录，驱动的都是纯文本的 DeepSeek-V4-Flash。

Codex 桌面 App 中识别一张推文截图。作者、配文、照片内容（连两人的穿着都在内）、发帖时间和全部互动数据（540 万浏览、1.6K 回复、5.7K 转发、11.6 万点赞）逐项读出。

![纯文本 DeepSeek 通过 ModLens 读出推文截图的全部细节](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.jpg)

一次粘贴三张图。模型逐张读取，认出三张同属一个视觉家族，并分别描述每张插画的内容和风格。

![一次粘贴三张图，逐张读取](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-batch.jpg)

压力测试：128 个模型的对比散点图。双轴定义、对数刻度、按厂商的配色、高亮区域，以及虚线标注的每一个 DeepSeek 型号全部识别。密集图表是视觉方案最容易出错的场景。

![128 个模型的散点图完整读出：双轴、对数刻度与高亮区域](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-chart.jpg)

粘贴链路的端到端记录：接入 DeepSeek 的 Claude Code 终端里，粘贴的图片以路径而非像素到达，skill 自动触发，guard 确认当前模型确实没有视觉后才开读，PPT 封面幻灯的标题、版式、背景逐项读出，连文件名被截断这个不确定点都如实说明。

![接入 DeepSeek 的 Claude Code 会话中 skill 自动触发并读出粘贴的幻灯片](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-claude-paste-recovery.jpg)

## 文档

| 文档                                               | 适用场景                                   |
| :------------------------------------------------- | :----------------------------------------- |
| [安装手册](INSTALL.md)                             | 一步步安装 skill（为 agent 编写）          |
| [CLI 手册](docs/cli.md)                            | skill 所驱动的 CLI：参数、配置与体检       |
| [故障排查](docs/troubleshooting.md)                | 命令报错，查成因和解法                     |
| [配置手册](skills/modlens/references/configure.md) | 配置 key、切换 provider、排查配置          |
| [输出契约](docs/output-schema.md)                  | 解析 JSON 或构建下游工具                   |
| [宿主接入](docs/harness-setup.md)                  | 在 Codex、Claude Code、Pi、OpenCode 中配置 |
| [安全说明](docs/security.md)                       | 恢复文件的权限、图片内容作为不可信输入     |
| [更新日志](CHANGELOG.md)                           | 查询版本变更                               |

## 参与方式

本仓库不接受 PR。项目由作者独立维护，所有代码经作者本人审阅，这是它可靠性的前提。两种有效的参与方式：

- **[提交 issue](https://github.com/liustack/modlens/issues)。** bug、建议、难以理解的报错或文档都欢迎。issue 会被认真阅读，并影响后续开发方向。
- **Fork。** MIT 协议下你的副本完全归你，修改和发布不受限制。

## 插入一条硬广

关注微信公众号「liustack」：AI 创业机会、独立开发见解、AI 实战与工具，第一时间推送。微信扫码，或搜一搜「liustack」：

<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/wechat-qrcode.png" width="420" alt="微信公众号 liustack" />
</p>

⭐ 如果它对你有用，请给 [ModLens](https://github.com/liustack/modlens) 一个 star，这是其他开发者找到它的方式。

## Star History

<a href="https://www.star-history.com/?repos=liustack%2Fmodlens&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=liustack/modlens&type=date&theme=dark&legend=top-left&sealed_token=oQQAwrPffo9WRUsM6P4RnEu4ZdRART3ChPwIkavGtAfrMycGmLYdjuM2uJ4gjnoIyaF_MDwhOBkJlzmS8pT_W9IRDlsCqLafe7gwvw7Vcnr5MRTkczOasg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=liustack/modlens&type=date&legend=top-left&sealed_token=oQQAwrPffo9WRUsM6P4RnEu4ZdRART3ChPwIkavGtAfrMycGmLYdjuM2uJ4gjnoIyaF_MDwhOBkJlzmS8pT_W9IRDlsCqLafe7gwvw7Vcnr5MRTkczOasg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=liustack/modlens&type=date&legend=top-left&sealed_token=oQQAwrPffo9WRUsM6P4RnEu4ZdRART3ChPwIkavGtAfrMycGmLYdjuM2uJ4gjnoIyaF_MDwhOBkJlzmS8pT_W9IRDlsCqLafe7gwvw7Vcnr5MRTkczOasg" />
 </picture>
</a>

## 免责声明

本项目依下方 MIT 协议按现状提供。作者不对任何特定用途（含商业使用）提供保证或背书。上游引擎（Antigravity CLI，Gemini、OpenAI、Anthropic 的 API，以及任何 OpenAI 兼容端点）的使用受各自条款和额度约束，由使用者负责。

## License

MIT
