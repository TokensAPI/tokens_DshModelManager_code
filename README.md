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
  <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/liustack/modlens/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/liustack/modlens/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@liustack/modlens?style=flat-square" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

```text
Send this to your AI: install and configure the modlens skill following https://github.com/liustack/modlens/blob/main/INSTALL.md
```

Text-only models like DeepSeek-V4-Flash have no vision capability and cannot process screenshots or images. ModLens hands the image to a real vision engine and returns structured evidence the model can quote: every word transcribed, the layout mapped into reading-order regions, uncertain parts marked. It also solves a problem other bridges do not: **images pasted directly into the chat are recovered and read**, with no save-to-file step.

## Highlights

- **Pasted images are recoverable.** A pasted image never becomes a file, so other vision bridges cannot process it. ModLens recovers it from the harness's local session storage.
- **Evidence, not an impression.** Full transcription, reading-order layout regions, entity and relation lists. The model quotes specifics.
- **Uncertainty is explicit.** Unclear content goes into the `uncertainty` field. Pixel coordinates and confidence scores, the two data points vision models most often fabricate, are deliberately excluded.
- **Keep your model.** The model was chosen for price and reasoning. That choice stays.
- **Free to start.** The default engine (Antigravity CLI) needs no key. A free Gemini key brings a read down to 5-10 seconds.
- **Install once, use everywhere.** Verified on real machines in Claude Code, Codex, Pi, and OpenCode.

## Installation

Send this line to your AI. It installs, configures, and verifies the skill, then reports back:

> Install and configure the modlens skill following https://github.com/liustack/modlens/blob/main/INSTALL.md, then run the health check and tell me the result.

The recommended engine is a free Gemini key: get one at [Google AI Studio](https://aistudio.google.com) (about three minutes, no credit card), then send the key to your AI and let it configure the engine.

To avoid any sign-up, use Antigravity CLI instead. **The one step that needs your hands** is its browser sign-in:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash   # install, skip if your AI already did
agy                                                           # sign in, then exit
```

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

## How it works

![A text-only model hands an image to the vision engine through the modlens skill and gets structured JSON evidence back](https://raw.githubusercontent.com/liustack/modlens/main/assets/flow.en.png)

Four steps:

1. The skill triggers when an image shows up: a path, a URL, or the bare placeholder a text-only model gets left with after a paste.
2. It runs the `modlens` CLI, which hands the image to a vision engine. Five to choose from, the free Antigravity CLI by default.
3. The engine's reading is forced into a fixed JSON schema: transcription, layout, semantics, uncertainty. Output that does not match the schema is rejected, never patched up.
4. Your model quotes the evidence and answers.

Paste recovery is the capability other bridges lack. A paste is handled entirely inside the client: the image is encoded and sent the moment it lands, out of reach of any external tool, which is why other bridges require a saved file and a path. But before those bytes leave, the harness has already written them into its local session record. `recover-paste` reads them back from there: JSONL in Claude Code and Pi, SQLite in OpenCode, and Codex needs no recovery at all because its pastes already land as temp files. Details in [harness setup](docs/harness-setup.md).

| | Swap in a multimodal model | Other vision bridges (MCP servers etc.) | ModLens |
| :-- | :-- | :-- | :-- |
| Your chosen model | has to change | stays | stays |
| An image pasted into the chat | visible if the model supports it | out of reach | recovered and read |
| What you get back | the model's own reading | usually a description | transcription, layout regions, entities |
| Where it cannot read | may invent | may invent | says so in `uncertainty` |
| Cost | multimodal model pricing | usually per API call | agy's free quota or a free Gemini key |

The weaknesses, in the same place: agy's free tier is a weekly quota and heavy use hits the wall (a free Gemini key sidesteps it). Session storage layouts are each harness's internals with no compatibility promise, so if recovery ever breaks, dragging the file in still works everywhere.

## Documentation

| Doc | Read it when |
| :-- | :-- |
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

## Disclaimer

Provided as-is under the MIT License below. The author makes no warranty and gives no endorsement for any particular use, commercial use included. Your use of upstream engines (Antigravity CLI, the Gemini, OpenAI, and Anthropic APIs, and any OpenAI-compatible endpoint) is governed by their own terms and quotas, which you are responsible for.

## License

MIT
