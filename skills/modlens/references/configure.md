# Configuring ModLens

Read this when the user asks how to set up, configure, or switch ModLens providers. Prefer running the commands for the user over explaining them.

## Where config lives

`~/.modlens/config.json`, managed by the CLI. Precedence: CLI flags > environment variables > config file > built-in defaults. The default provider with zero config is `antigravity-cli`.

```bash
modlens config init                     # write a starter config (refuses to overwrite; --force to redo)
modlens config show                     # effective file, API keys masked
modlens config set provider <name>      # change the default provider
modlens config set <provider>.<field> <value>   # fields: apiKey, baseUrl, model, extraBody
```

`config set` writes the file with 0600 permissions.

## The file's exact shape

Everything lives under two top-level keys, both optional. A missing file means all defaults. Provider settings sit under `providers.<name>`, not at the top level, which is the mistake hand-editors make most.

```json
{
  "provider": "gemini-api",
  "providers": {
    "antigravity-cli": { "model": "gemini-3.6-flash-low" },
    "gemini-api": {
      "apiKey": "AIza...",
      "baseUrl": "https://generativelanguage.googleapis.com",
      "model": "gemini-3.6-flash"
    },
    "openai": {
      "apiKey": "sk-...",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen3.6-27b",
      "extraBody": { "thinking": { "type": "disabled" } }
    },
    "anthropic": { "apiKey": "sk-ant-..." },
    "claude-cli": { "model": "haiku" }
  }
}
```

Field semantics:

- `provider`: which provider runs when `-p` is not given. Canonical names or aliases both work (`agy`/`antigravity` for `antigravity-cli`, `gemini` for `gemini-api`, `openai-compat` for `openai`, `claude` for `anthropic`, `claude-code` for `claude-cli`). Empty or absent means `antigravity-cli`.
- `providers.<name>.<field>`: four fields exist, `apiKey`, `baseUrl`, `model`, and `extraBody`. Every provider entry is optional, and every field inside it is optional. Alias keys are read too (settings saved under `gemini` are found when `gemini-api` resolves), with the canonical key winning on conflict.
- `providers.<name>.extraBody`: a JSON object merged into the request body of the API providers (`gemini-api`, `openai`, `anthropic`), for whatever knobs that vendor has and modlens has no flag for. Turning thinking off is the usual reason, see the section below. Nested objects merge key by key, so adding one knob leaves the rest of that block alone. The fields carrying the image, the prompt, and the schema enforcement are refused with an error naming the field. The two CLI providers take no request body, so a run on `antigravity-cli` or `claude-cli` ignores it and says so in `meta.warnings`.
- Environment variables override the file for these bindings: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`. Nothing else is read from the environment except `MODLENS_HARNESS` (paste-recovery scope, unrelated to this file).
- Unknown top-level keys and unknown provider names are ignored rather than rejected, so a typo fails quiet: run `modlens doctor` after hand-editing, it shows which file and env values are actually in effect.

Hand-editing is fine (keep the file valid JSON and its permissions 0600). `modlens config set` does the same thing with guardrails.

## Provider setup recipes

### antigravity-cli (default, free, no key)

Needs Antigravity CLI installed and signed in:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # user must complete browser sign-in themselves, then exit
```

Any free Google account works; no Google AI Pro needed. Sign-in cannot be automated, ask the user to run `agy` once.

### gemini-api (free key, fastest free route, 5-10s)

1. The user creates a key at https://aistudio.google.com (three minutes, no credit card, free tier does not expire).
2. Store it either way:

```bash
modlens config set gemini-api.apiKey <key>
# or environment: export GEMINI_API_KEY=<key>
```

Default model `gemini-3.6-flash` has vision on the free tier (about 10-15 requests/min, 1500/day). Free-tier data may be used by Google to improve products; mention this if the user handles sensitive images.

### openai (any OpenAI-compatible multimodal endpoint)

Needs three values. Example for DashScope qwen:

```bash
modlens config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
modlens config set openai.apiKey <sk-key>
modlens config set openai.model qwen3.6-27b
```

For official OpenAI: baseUrl `https://api.openai.com/v1`, a vision-capable model. Environment equivalents: `OPENAI_BASE_URL`, `OPENAI_API_KEY`. The model must be multimodal; text-only models will fail or hallucinate. This route has no server-side schema enforcement, so occasional shape failures are surfaced as explicit errors; retry or switch provider.

### anthropic (Claude API key)

```bash
modlens config set anthropic.apiKey <sk-ant-key>
# or: export ANTHROPIC_API_KEY=<key>
```

Default model is Claude Haiku (`claude-haiku-4-5-20251001`). Schema is enforced through a forced tool call.

**`ANTHROPIC_BASE_URL` trap.** modlens binds `ANTHROPIC_BASE_URL` to `anthropic.baseUrl`, so it inherits whatever that variable points at. If the user set it in their shell to route Claude Code through a text-only gateway (a common way to run a non-Claude model behind the Claude Code UI), then `-p anthropic` silently sends the vision request to that gateway too, where it fails or comes back blind, with no hint that the endpoint was swapped. Check `echo $ANTHROPIC_BASE_URL` when anthropic vision misbehaves. Fixes: unset it for the modlens call, pin the real endpoint with `modlens config set anthropic.baseUrl https://api.anthropic.com`, or use `-p gemini-api` instead.

### claude-cli (Claude Code login, no key)

Rides an existing `claude` sign-in, so it costs the user's Claude subscription quota, not a separate API bill. Requires Claude Code installed and logged in (`claude --version` to check). Runs with `--allowedTools Read` only. Local image files only; for remote URLs use gemini-api instead. Default model alias `haiku`.

```bash
modlens config set provider claude-cli   # make it the default if the user wants
```

## Turning thinking off

A reasoning model spends its thinking budget before it answers. Reading text out of an image needs none of that, so on a model that thinks by default the run is slower and more expensive for nothing. Every vendor names the switch differently, and there is no portable one, so modlens sends whatever you put in `extraBody` and leaves the naming to the vendor's own docs.

```bash
modlens config set openai.extraBody '{"thinking":{"type":"disabled"}}'   # persist it
modlens -i shot.png --extra-body '{"thinking":{"type":"disabled"}}'      # one run only
modlens config set openai.extraBody ''                                   # clear it
```

`--extra-body` replaces the stored object for that run rather than merging into it.

Known spellings, current as of August 2026:

| Endpoint | Field to send |
| :-- | :-- |
| MiMo official API (`api.xiaomimimo.com/v1`) | `{"thinking":{"type":"disabled"}}` |
| MiMo Responses-format route | `{"reasoning":{"effort":"none"}}` |
| Qwen, GLM, MiMo and friends self-hosted on vLLM or SGLang | `{"chat_template_kwargs":{"enable_thinking":false}}` |
| OpenAI-style gateways that accept an effort level | `{"reasoning_effort":"low"}` |
| `gemini-api`, Gemini 3 family | `{"generationConfig":{"thinkingConfig":{"thinkingLevel":"LOW"}}}` |
| `gemini-api`, Gemini 2.5 Flash and Flash Lite | `{"generationConfig":{"thinkingConfig":{"thinkingBudget":0}}}` |
| `anthropic` | nothing to do, thinking is off unless it is asked for |

Three things that bite:

- Not every model can turn it off. Gemini 3 Pro and Gemini 2.5 Pro have no off switch, only a lower level. Some models ignore an effort field entirely and think anyway.
- Strict clouds (Groq and Cerebras among them) reject fields they do not recognize with a 400. If a request that worked before now fails with a 400 naming your field, that gateway wants a different spelling, not this one.
- Others accept an unknown field and quietly ignore it, so check that it took effect instead of assuming. Compare `meta.durationSeconds` and the token counts in `meta.usage` against a run without `extraBody`. If neither moved, the field did not land.

## Choosing a provider for the user

- Wants zero setup and free: `antigravity-cli` (needs agy sign-in, 15-40s per image).
- Wants fast and free: `gemini-api` (three-minute key, 5-10s).
- Already pays for Claude: `claude-cli` (no extra key) or `anthropic` (API billing).
- Has a favorite multimodal endpoint (qwen, GLM, ...): `openai`.

Every configured provider also backs up the others: a run tries them in a
fixed order (local images agent-first; remote URLs inline-API-first, agent
last) and fails over on an error, a timeout, or a schema-violating result.
`config set provider <name>` moves a provider to the front of its allowed
region; `-p <name>` pins exactly one with no fallback. `doctor` prints the
chains, and the result's `meta.attempts` shows what a run actually tried.

## Troubleshooting

- Error names a missing env var or `config set` command: run exactly that.
- `Provider CLI not found: agy`: install Antigravity CLI or switch provider.
- `Claude CLI reported ...` or empty result: check `claude` login state.
- openai route `does not match the vision schema`: retry once, then switch to gemini-api or anthropic.
- `extraBody cannot override "<field>"`: that field carries the image, the prompt, or the schema. Drop it from the object and keep the vendor knobs.
- A 400 that names a field you set in `extraBody`: that gateway does not know it. See the thinking section above for the other spellings.
- `config init` refusing to run: the file exists; use `modlens config show` first, `--force` only if the user agrees to overwrite.
