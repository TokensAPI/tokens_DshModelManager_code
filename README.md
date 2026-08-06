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

```bash
npx -y skills add liustack/modlens             # install the skill
npx @liustack/modlens -i screenshot.png        # or just use the CLI
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

Two ways in. Choose by who is doing the install.

### If you are a person

Run this block top to bottom. It installs the skill, points ModLens at a free Gemini engine, and verifies the result. Nothing to choose:

```bash
npx -y skills add liustack/modlens
npx @liustack/modlens config set gemini-api.apiKey <KEY>
npx @liustack/modlens config set provider gemini-api
npx @liustack/modlens doctor
```

Get `<KEY>` from [Google AI Studio](https://aistudio.google.com): about three minutes, no credit card. The last command runs a local health check. You are done when the entry under `Selected provider` reads `[ok]`.

### If you are an AI agent

Tell it: "Install the ModLens skill from https://github.com/liustack/modlens, following its INSTALL.md." The agent reads [INSTALL.md](INSTALL.md), a zero-ambiguity four-step guide, and runs it.

<details>
<summary>No-key engine, manual install, other engines, multiple agents</summary>

**No key at all.** Antigravity CLI needs no sign-up. It is slower (15-40 seconds), its free quota is a weekly bucket, and its browser sign-in cannot be completed in a headless session, so for agents and servers the Gemini key above is the reliable choice.

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # sign in, then exit
```

**Manual skill install.** When the `skills` CLI is unavailable, copy the skill into your host's directory:

| Host | Skill directory |
| :-- | :-- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi, OpenCode | `~/.agents/skills/` |

The exact clone-and-copy commands and a per-host walkthrough are in [INSTALL.md](INSTALL.md).

**Other engines.** `openai` (any OpenAI-compatible multimodal endpoint), `anthropic`, and `claude-cli` (your existing Claude login). Recipes in [Configuration](skills/modlens/references/configure.md).

**Multiple agents on one machine.** Install into each host's directory, or keep one copy under `~/.agents/skills/modlens` and symlink the others to it.

</details>

Requires Node 22.13+. macOS and Linux are fully supported and verified in CI.

## Usage

With the skill installed you do not type commands: paste an image or drop a path, ask anything, and it fires on its own. By hand:

```bash
modlens -i screenshot.png                       # local image
modlens -i https://example.com/chart.png        # remote image
modlens -i chart.png --prompt "focus on axes"   # extra focus
modlens recover-paste                           # pull a pasted image into a file
```

Output is a fixed JSON shape:

```json
{
  "image": "/path/to/screenshot.png",
  "provider": "gemini-api",
  "result": {
    "summary": "A workflow diagram with four nodes connected by labeled arrows.",
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

`meta` records how the result was produced: when (`generatedAt`), which `model`, the provider's `conversationId` when it has one, wall-clock `durationSeconds`, and the raw `usage` the provider reported (shape varies by provider, `null` when none).

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

## CLI reference

`modlens analyze` (the default command):

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `-i, --input <path\|url>` | Image to analyze (required) | |
| `-p, --provider <name>` | Vision provider | `antigravity-cli` |
| `-m, --model <name>` | Provider model | per provider (below) |
| `-o, --output <path>` | Also write JSON to a file | |
| `--prompt <text>` | Extra focus | |
| `--timeout <ms>` | Provider timeout | `180000` |
| `--provider-bin <path>` | Provider binary path | `agy` / `claude` |
| `--workdir <path>` | Working directory for the provider | a fresh isolated directory per run |

The default `-m` model depends on the provider:

| Provider | Default model |
| :-- | :-- |
| `antigravity-cli` (default) | `gemini-3.6-flash-low` |
| `gemini-api` | `gemini-3.6-flash` |
| `anthropic` | `claude-haiku-4-5-20251001` |
| `claude-cli` | `haiku` |
| `openai` | none, `-m` is required |

`modlens recover-paste`:

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `--count <n>` | How many recent pasted images to recover | `1` |
| `--out-dir <path>` | Where to write recovered images | a fresh private `<tmpdir>/modlens-paste-*` per run |
| `--session <id>` | Session id for exact targeting | auto-detect |
| `--transcript <path>` | Explicit transcript `.jsonl` or `.db` (overrides `--session`) | |
| `--harness <name>` | Force storage scope: `claude-code`, `pi`, `opencode`, `none` | auto-detect |
| `--cwd <path>` | Project directory the image was pasted in | current directory |

Five providers: `antigravity-cli` (default, no key), `gemini-api` (fastest free route), `openai` (any OpenAI-compatible multimodal endpoint), `anthropic`, and `claude-cli` (uses your existing Claude subscription). Two more subcommands: `modlens config <init|set|show>`, and `modlens doctor` (checks Node, provider readiness, which provider will be selected and why, and the detected harness, without spending quota or touching the network. Add `--json` for a machine-readable report).

## Documentation

| Doc | Read it when |
| :-- | :-- |
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
