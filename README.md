<p align="center">
  <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens" />
</p>

<h1 align="center">ModLens</h1>

<p align="center"><b>Give a text-only model sight, and just paste the image.</b></p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="docs/troubleshooting.md">Troubleshooting</a> ·
  <a href="skills/modlens/references/configure.md">Configuration</a> ·
  <a href="skills/modlens/references/output-schema.md">Output contract</a> ·
  <a href="docs/security.md">Security</a> ·
  <a href="https://github.com/liustack/modsearch">ModSearch (web)</a>
</p>

<p align="center">
  <a href="https://x.com/liustack"><img src="https://img.shields.io/badge/follow-%40liustack-black?style=flat-square&logo=x&logoColor=white" alt="Follow @liustack on X"></a>
  <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@liustack/modlens?style=flat-square" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

DeepSeek-V4-Flash has no vision capability and cannot process screenshots or images. ModLens is a plug-in vision engine that gives a text-only model sight. **ModLens reads images pasted straight into the chat**, no saving to a file and passing a path first.

## Talk to us

Something broken, or something missing? [Open an issue](https://github.com/liustack/modlens/issues/new/choose). For everything else, come find me on X: **[@liustack](https://x.com/liustack)**. What you built with it, which harness you are on, what should come next. New releases land there first, and a proper community space is on the way.

## Highlights

- **Completely free.** The default channel is Antigravity CLI, no API key needed. A free Gemini key brings a read down to 5-10 seconds.
- **Evidence, not an impression.** Full transcription, reading-order layout regions, entity and relation lists. The model quotes specifics.
- **Install once, use everywhere.** Verified on real machines in Claude Code, Codex, Pi, and OpenCode.

## Installation

**Step 1, set up a vision engine (the only part that needs your hands).** The recommended choice is a free Gemini API key: get one at [Google AI Studio](https://aistudio.google.com), about three minutes, no credit card.

A free API key in the OpenAI-compatible format from another platform is also a good option.

To avoid any sign-up, install Antigravity CLI instead, then sign in:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                                                           # sign in, then exit
```

**Step 2, hand the rest to your AI.** Send it this line, along with the key if you chose the Gemini API key:

> Install and configure the modlens skill following https://github.com/liustack/modlens/blob/main/INSTALL.md, then run the health check and tell me the result.

## Usage

Once installed, just chat. Paste an image or drop a path, ask anything, and the skill triggers on its own: the image goes to a vision engine and the answer comes back grounded in what it read.

## See it work

Unedited runs, all driving a text-only DeepSeek-V4-Flash.

A tweet screenshot in the Codex desktop app. It reads the caption, the engagement numbers (2.9K replies, 270K likes, 5M views), even the image's alt text. Where the resolution runs out, it says so instead of guessing.

![Text-only DeepSeek reading a tweet screenshot in full detail via ModLens](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-app.png)

Three images pasted at once. The model queues them up and reads them one by one, design intent included.

![Three images dropped together, read one by one](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-batch.png)

The stress test: a scatter plot of 128 models. It identifies the chart, both axes, the log scale, and picks the one highlighted point out of the crowd with its coordinates (about $0.028, intelligence score 50). Dense charts are where vision models most often fail.

![The 128-model scatter plot, highlighted point read with exact coordinates](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-codex-chart.png)

And the paste path, end to end: Claude Code on a DeepSeek gateway, two images pasted straight into the chat. The UI shows nothing but placeholders, the skill recovers both from session storage and reads them, down to the color values on a slide cover.

![Two pasted images recovered from session storage and read in a gateway Claude Code session](https://raw.githubusercontent.com/liustack/modlens/main/assets/demo-claude-paste-recovery.png)

## Documentation

| Doc | Read it when |
| :-- | :-- |
| [INSTALL.md](INSTALL.md) | Installing the skill step by step (written for an agent) |
| [CLI manual](skills/modlens/references/cli.md) | The CLI the skill drives: flags, config, doctor |
| [Troubleshooting](docs/troubleshooting.md) | A command failed and the message needs decoding |
| [Configuration](skills/modlens/references/configure.md) | Setting a key, switching providers, fixing config |
| [Output contract](skills/modlens/references/output-schema.md) | Parsing the JSON or building on it |
| [Harness setup](docs/harness-setup.md) | Wiring it into Codex, Claude Code, Pi, or OpenCode |
| [Security](docs/security.md) | File permissions, image content as untrusted input |
| [CHANGELOG](CHANGELOG.md) | Finding what changed in a version |
| [AGENTS.md](AGENTS.md) | Working on this codebase |

## Contributing

ModLens does not accept pull requests. The project is maintained by a single author who reviews every line, which is a deliberate choice for reliability. Two effective ways to contribute:

- **[Open an issue](https://github.com/liustack/modlens/issues).** Bugs, suggestions, confusing errors, unclear docs. Issues are read and shape what gets built next.
- **Fork it.** Under MIT your copy is fully yours to modify and publish.

## Shameless plug

This project runs on LIUSTACK Skills: `shaping` before you build, `coding` while you build, `dig` when it breaks, `snapshot` when you hand off. Lighter than Superpowers, and stronger.

```bash
npx -y skills add liustack/liustack -g
```

⭐ If it helps, star [ModLens](https://github.com/liustack/modlens) and [liustack](https://github.com/liustack/liustack). Stars are how the next developer finds them.

## Star History

<a href="https://www.star-history.com/?repos=liustack%2Fmodlens&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=liustack/modlens&type=date&theme=dark&legend=top-left&sealed_token=oQQAwrPffo9WRUsM6P4RnEu4ZdRART3ChPwIkavGtAfrMycGmLYdjuM2uJ4gjnoIyaF_MDwhOBkJlzmS8pT_W9IRDlsCqLafe7gwvw7Vcnr5MRTkczOasg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=liustack/modlens&type=date&legend=top-left&sealed_token=oQQAwrPffo9WRUsM6P4RnEu4ZdRART3ChPwIkavGtAfrMycGmLYdjuM2uJ4gjnoIyaF_MDwhOBkJlzmS8pT_W9IRDlsCqLafe7gwvw7Vcnr5MRTkczOasg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=liustack/modlens&type=date&legend=top-left&sealed_token=oQQAwrPffo9WRUsM6P4RnEu4ZdRART3ChPwIkavGtAfrMycGmLYdjuM2uJ4gjnoIyaF_MDwhOBkJlzmS8pT_W9IRDlsCqLafe7gwvw7Vcnr5MRTkczOasg" />
 </picture>
</a>

## Disclaimer

Provided as-is under the MIT License below. The author makes no warranty and gives no endorsement for any particular use, commercial use included. Your use of upstream engines (Antigravity CLI, the Gemini, OpenAI, and Anthropic APIs, and any OpenAI-compatible endpoint) is governed by their own terms and quotas, which you are responsible for.

## License

MIT
