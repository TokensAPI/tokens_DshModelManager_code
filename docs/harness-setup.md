---
summary: 'Harness setup: how images reach the model in Codex, Claude Code, Pi, and OpenCode'
read_when:
  - Setting modlens up inside a specific coding agent
  - A pasted image is not reaching the model
  - Understanding what recover-paste does per harness
---

# Harness setup

Where a pasted image ends up differs per harness, and modlens takes a different route in each. `recover-paste` detects which harness it runs inside (process ancestry, then environment fingerprints) and reads only that harness's storage.

## Codex

Pasted images become real temp files, and the message carries a tag like `<image name=[Image #1] path="/tmp/xxxx.png">`. The skill reads the path out of the tag. `recover-paste` detects Codex and refuses, pointing back at the tag.

One catch with text-only models: once `models.json` declares `input_modalities: ["text"]`, the Codex TUI blocks Ctrl+V paste outright. Drag the file into the terminal, type its path, or use `codex exec -i image.png "..."`.

## Claude Code, Pi, OpenCode

None of them hands the model a usable temp-file path the way Codex does (newer Claude Code builds do write pastes to their own `~/.claude/image-cache/`, injected as a path line only in the terminal entrypoint), but all three persist the user message locally before any gateway strips it:

| Harness | Storage | Notes |
| :-- | :-- | :-- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | images as base64. The injected `CLAUDE_CODE_SESSION_ID` targets the exact session |
| Pi | `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` | same shape as Claude Code |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite, images as data URLs (read via `node:sqlite`) |

Running a text-only model behind `ANTHROPIC_BASE_URL` in Claude Code, a pasted image arrives as a pathless `[Unsupported Image]` placeholder (on lenient gateways) or breaks the request outright ([#62009](https://github.com/anthropics/claude-code/issues/62009)). The bytes are not gone, and that is what `recover-paste` retrieves.

## Skill locations

| Harness | Reads skills from |
| :-- | :-- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi, OpenCode | `~/.agents/skills/` |

Symlinks work in all of them, so linking the skill folder once keeps every agent on the latest version.

## Platform support

macOS and Linux are fully supported and verified in CI on Node 22 and 24.

Windows runs the same CI matrix. Detection there skips the process-ancestry pass, since there is no `ps`, and falls back to the environment fingerprints above, so a harness that sets none of them reads as undetected (force it with `--harness` or `MODLENS_HARNESS`). OpenCode paste recovery is covered on Windows, including the path-separator normalization from [#11](https://github.com/liustack/modlens/issues/11): opencode records `session.directory` with forward slashes while `path.resolve` returns backslashes there, and both sides are normalized before matching. The JSONL stores (Claude Code, Pi) key off `os.homedir()` and each harness's own on-disk slug, and are exercised on POSIX. External engines (Antigravity CLI, the Claude CLI) run only where they ship a Windows build.

## Gateway setups

OpenCode with DeepSeek: `opencode auth login`, pick DeepSeek and paste the key (it lands in `~/.local/share/opencode/auth.json`), then set the default model in `~/.config/opencode/opencode.jsonc` to `deepseek/deepseek-v4-flash`. Pi reads its key from `~/.pi/agent/auth.json`.

## DeepSeek Harness (dsh)

dsh is different from the other harnesses: modlens plugs in as a native tool, not a prompt-triggered skill. The package itself is a dsh bundle, so one command installs it into a profile:

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @liustack/modlens
```

This registers a `read_image` tool whose schema reaches the model on every request (no trigger heuristics), runs the modlens CLI shipped inside the same package, and returns the structured evidence as the tool's canonical JSON output. Engines, reuse grants, and guard rules stay in `~/.modlens/config.json`, shared with every other harness. dsh is in developer preview and its plugin surface may change; the plugin keeps its touch small (raw tool registration, the llm adapter surface for the vision variants, the attachment reader, and one agent pre-step hook) and degrades loudly if any of them moves.
