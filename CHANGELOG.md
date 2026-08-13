# Changelog

## 3.6.0 - 2026-08-13

- The skill now triggers on what a text-only model can actually see. Field testing with DeepSeek behind an Anthropic-compatible gateway showed the old description asking the model to judge "can I see images", the exact self-assessment that fails when a gateway strips images silently, so the skill loaded but never fired. The description now keys on visible evidence: placeholders like `[Image #1]` and `[Unsupported Image]` trigger with a guard check as backup, and a `[Image: source: <path>]` line with no visible image content is a hard trigger, because that line means the harness stored the pasted image on disk and did not deliver it. Newer Claude Code builds write pastes to `~/.claude/image-cache/<session>/` and inject that line from the cli entrypoint (all models get it, vision models also get the real image and are immune to the trigger by the no-visible-content condition; the VSCode entrypoint injects nothing). The skill reads that path directly when it is alive, falls back to `recover-paste` when it is not, and never deletes Claude Code's own cache files.
- `guards.allowModels`: the guard gains an allowlist mode for the world where most models are multimodal and the text-only ones are the short list. Non-empty means only listed models run the engine and every other identified model is denied. Deny patterns win over allow matches, so a broad allow can have vision variants carved out (`allowModels: ["glm-5.*"]`, `denyModels: ["glm-*v*"]`), and the unknown-model policy is unchanged (fail open unless `denyWhenUnknown`). `config set guards.allowModels` takes a JSON array or comma list, `doctor` reports both lists and flags allowlist mode, the analyze fast gate also refuses an explicit `MODLENS_MODEL` that is off the list, and `configure.md` documents tightly anchored patterns (`deepseek-v4-*`, not `deepseek*`) so a vendor's next multimodal generation falls off the list instead of into it. Configure by what actually reaches the model, not by what it could see: a multimodal model behind an image-stripping gateway still needs modlens.

## 3.5.1 - 2026-08-13

- `file://` inputs now resolve through Node's `fileURLToPath` instead of hand-stripping the prefix (issue #16). The old unwrap left a leading slash in front of Windows drive letters, so `file:///C:/Temp/shot.png` could resolve against the current working drive as `E:\C:\Temp\shot.png`, and `decodeURI` left reserved escapes such as the `%23` in a `#` filename undecoded. A URL produced by `pathToFileURL()` now round-trips back to the original local path, and a malformed file URL fails with Node's clear error instead of silently resolving to a wrong path. Thanks to @BruceWae for the report and a validated fix branch.

## 3.5.0 - 2026-08-12

- The CLI no longer prints a `node:sqlite` ExperimentalWarning on every start. Bundling undici had hoisted its lazy `require('node:sqlite')` (for a cache store nothing here uses) into a top-level import. The build now keeps that require a runtime call.

- Invocation guard (issue #15): `modlens guard` answers whether the vision engine should run at all, for people who point both text-only and vision-capable models at the same client. `guards.denyModels` in the config holds glob patterns of models with native vision. A match means deny (exit 1, machine-readable verdict), and the skill's workflow now checks it before the first read of a session. The active model is detected from three signals, strongest first: the `MODLENS_MODEL` env var, the harness's own session storage (Claude Code, Pi, and Codex transcripts, the OpenCode database, scoped by the same harness detection recover-paste uses: a transcript cannot misname the model, while a model's `--model` self-report can), then that self-report. Unknown stays fail-open unless `guards.denyWhenUnknown` is set: a wrongly blocked read would break the text-only bridge this tool exists for, a wrongly allowed one only wastes a provider call. `analyze` itself refuses before spending quota when the explicit `MODLENS_MODEL` matches a deny rule (only that: sniffing and the unknown policy stay advisory, in `modlens guard`), and `doctor` grew a Guard section showing the rules, the detected model with its signal, and a live verdict. Sniffing reads a bounded tail window of transcripts that can carry hundreds of MB of inline images, and a guard with no configured rules answers without touching detection at all.

## 3.4.0 - 2026-08-12

- Vendor-specific request fields can now be passed through to the three API providers, which is how you turn thinking off (issue #12). `modlens config set openai.extraBody '{"thinking":{"type":"disabled"}}'` stores it per provider, `--extra-body '<json>'` overrides it for one run, and an empty value clears it. Reasoning models spend their budget re-deriving a transcription task that needs none, so on a thinking-by-default model this is the difference between a slow read and a fast one. There is deliberately no `--no-thinking` flag: every gateway spells the knob differently (`thinking.type` on the MiMo API, `reasoning.effort` on its Responses route, `chat_template_kwargs.enable_thinking` on a self-hosted vLLM, `thinkingConfig` inside `generationConfig` on Gemini), some ignore what they do not know and others reject it with a 400, so guessing on the user's behalf would fail silently about as often as it worked. `configure.md` carries the per-vendor recipes.
- The passthrough deep-merges into the request body, so adding a knob to a nested block keeps what was already there (a Gemini `thinkingConfig` no longer wipes out the `responseJsonSchema` next to it). The fields that carry the image, the prompt, and the schema enforcement are reserved and rejected with a message naming the field. The two CLI providers take no request body: they warn in `meta.warnings` that the value was ignored rather than letting a run look configured when nothing was sent.

## 3.3.0 - 2026-08-07

- Automatic provider failover. A run now tries every provider that is set up on this machine, in order, and the first good result wins: a provider that errors, times out, or returns a schema-violating result hands over to the next. A local image tries `antigravity-cli`, then `gemini-api`, `openai`, `anthropic`, `claude-cli`; a remote URL tries the inline API providers first and the agent last (only the inline download path runs the private-address guards, the magic-byte check, and the size cap), and `claude-cli` never joins the remote chain since it reads local files only. The result's `meta.attempts` records every provider tried with timings and failure reasons, and `meta.warnings` carries failover notices. `doctor` prints both chains. Availability (binary on PATH, required keys present) is one shared source of truth between the doctor's readiness report and the chain. The 3.2.0 remote-URL reroute is absorbed by the remote chain order.
- Behavior change: `config set provider <name>` is now a preference, not a pin. It moves that provider to the front of its allowed region (for a remote URL an agent still stays behind the inline providers), and the rest of the chain backs it up on failure, matching modsearch's engine setting. To pin exactly one provider with no fallback, pass `-p <name>`, which keeps its original error when it fails.

## 3.2.0 - 2026-08-07

- A remote image URL with no explicit `-p` now runs on `gemini-api` whenever a Gemini key is configured, even if the default provider is an agent. The inline path downloads the image itself, behind the private-address guards, the magic-byte image check, and the 25 MB cap; an agent fetching the URL on its own passes through none of those. Without a Gemini key the run stays on the configured default, a local image never reroutes, and an explicit `-p` always wins.

## 3.1.1 - 2026-08-07

Fixes from a deep acceptance review (external audit, reproduced and verified here).

- The isolated workdir now actually isolates. The "isolated copy" of a local image was a hardlink sharing the original's inode, so a provider writing its temp path mutated the user's file: it is now always a real 0600 copy, with a regression test asserting the original survives a provider that overwrites everything in its cwd. A remote image skipped isolation entirely and ran the agent in the caller's directory: it now gets an empty throwaway cwd, and the antigravity fallback is the tmpdir, never `process.cwd()`. `docs/security.md` states plainly that this is exposure reduction, not an OS sandbox, and that untrusted images are better served by an inline API provider.
- Remote image downloads go through SSRF guards ported from modsearch. The old path called bare `fetch` on the user-supplied URL, so a URL pointing at loopback, RFC-private, link-local, or cloud-metadata addresses was downloaded and its bytes uploaded to the vision provider. Now the hostname is checked against a blocklist, every resolved address must be public, the connection is pinned to the exact validated IP via an undici dispatcher (closing DNS rebinding), and every redirect hop is re-normalized, re-validated, and re-pinned. There is deliberately no allow-private switch: for a genuinely local image the answer is a file path, and the error says so.
- Schema validation has one source of truth. `missingSchemaFields` checked only that arrays existed, so `[42]` in `ocr.lines`, a string `reading_order`, and numbers in `uncertainty` all passed as evidence, and the runtime check required `visual` while the provider schema did not. The walk is now driven by `VISION_RESULT_SCHEMA` itself (types, array elements, enums, nested requireds, present-but-optional fields), and `visual` joins the schema's required list.
- The launchers skip npx when node is below the CLI's 22.13 floor: an old node with a working npx used to be selected anyway, a path known to fail at run time. The diagnosis explains an unusable npx and reports `nodeMeetsFloor`, and the no-runtime next step names the actual node version. Doc wording is corrected: `doctor` spends no quota but the npx/bunx paths may download the pinned package on first use, and Bun cannot load `node:sqlite`, so OpenCode paste recovery on a bunx-resolved machine needs a real Node install.

## 3.1.0 - 2026-08-07

- Windows joins the CI matrix (Node 22 and 24), so the CLI core, config, `doctor`, harness detection, and OpenCode paste recovery run on a real Windows runner rather than being assumed. The POSIX-only cases (subprocess signal handling, permission-bit assertions, and the Claude Code and Pi JSONL home-layout fixtures) are guarded with `describe.skipIf`, and the OpenCode path normalization from #11 now runs end to end on Windows, not only as an injected-path unit test. A `.gitattributes` pins text files to LF so the Windows checkout matches the other platforms and Biome does not fail on line endings.
- Two guards that assumed POSIX permissions are fixed for Windows, where files report `0o666`/`0o777` and access is ACL-based. `recover-paste --out-dir` no longer rejects an existing private directory, and `doctor` no longer flags the config file's mode. Both checks now run only where `process.getuid` exists, and the symlink guard on `--out-dir` stays in force everywhere.
- The skill now launches the CLI through a bundled launcher (`skills/modlens/scripts/run.sh` for macOS/Linux, `run.ps1` for Windows) instead of a hard-coded `npx`, because a Claude Code native install has none of `node`, `npx`, `bun`, or `bunx` on PATH, so a fixed command failed for a whole class of users. Both launchers resolve the same way, forward every argument to the CLI unchanged, and share a `doctor --json` diagnosis: a compatible `modlens` already on PATH (same major version and not older than the pinned one), then the pinned-version `npx`, then `bunx --bun`, then a structured diagnosis on stderr with `nextSteps` and exit 78 when nothing can run. `doctor` is offline and chains the CLI's own provider/config doctor when a CLI is reachable. The native-artifact branch is a phase-B placeholder that reports none is published yet. The two scripts are POSIX sh and PowerShell 5.1, identical apart from their version constants and shell syntax, and a new `references/runtime.md` documents the pin, the compatibility rule, and the diagnostic fields.
- `SKILL.md` is rewritten to drive the launcher: the usage section runs `run.sh` / `run.ps1`, keeps a plain-language version of the same resolution order for harnesses that forbid running scripts, and drops the bare-`npx` fallback. Its frontmatter is brought in line with the Agent Skills spec: `allowed-tools` becomes the spec's space-separated string (`Bash`) instead of a YAML list, and a `compatibility` field states the runtime requirement.
- Release tooling stamps the pinned version so it cannot drift. A new `scripts/stamp.mjs` rewrites the version constant in `run.sh`, `run.ps1`, and `runtime.md` from `package.json`, `scripts/release.mjs` calls it on every bump, and `scripts/stamp.test.mjs` fails the build if the three copies ever disagree with `package.json`. The npm `files` list now ships `skills/modlens/scripts`.
- Root `INSTALL.md`, written for an AI agent installing the skill on a user's behalf, is rebuilt around the launcher and the machine as found. Four ordered, idempotent steps (find the harness's skill directory, copy `skills/modlens` in, give it one vision engine, verify), each with an "if it fails" branch and Windows notes. It installs into the user-global skill directory by default, probes before configuring (the README now has the user prepare an engine first, so an already-ready provider is the common case), prefers the Gemini key for headless reliability with Antigravity as the no-signup path, and verifies through the launcher, including the exit-78 no-runtime diagnosis.
- The README installation section (both languages) is reordered to match how the install actually flows: step 1 is the only human part, preparing an engine (get a free Gemini key, or install Antigravity and sign in), and step 2 hands one line to the user's AI, which follows `INSTALL.md` and reports back. The hero one-liner above the fold, three highlight bullets, and the how-it-works section are removed, keeping the highlights to evidence output, free start, and install-once-use-everywhere, and the docs table links `INSTALL.md`. The platform line is rewritten to state per-OS support honestly, and the harness and troubleshooting docs gain a Windows section.

A code-review pass. Two user-facing bugs, a stack of doc corrections, and the tooling a public repo is expected to carry.

- BREAKING: requires Node 22.13+. The floor was Node 18 with a special note that OpenCode paste recovery needed 22.13 for `node:sqlite`. That split is gone: 22.13 is the single minimum, `node:sqlite` is always available, and the CI matrix now runs Node 22 and 24 (dropping 18 and 20). The defensive runtime guard in the OpenCode adapter and the `describe.skipIf` in its tests stay, harmless, in case someone runs below the stated floor. README (both languages), CONTRIBUTING, AGENTS, and the harness doc drop the per-feature Node caveat.
- New `evals/` scaffolding makes "every experiment leaves a reproducible artifact" a format and a tool rather than a slogan. Seed cases (dense bilingual text, a dense chart, a clean diagram, a stylized banner, and a dependency-free generated prompt-injection image) live under `evals/cases/`, and `pnpm eval` drives the built CLI over them, writing one evidence artifact per case (command, tool version and commit, provider and model, input SHA-256, raw output, expected points and scoring, latency, usage, errors and degradation) to a git-ignored `evals/results/<date>/`. It reports transcription and schema pass rates and a latency summary, and `--dry-run` validates cases without spending quota. Local and on-demand by design: it spends real quota and never runs in CI.
- New `modlens doctor` command diagnoses local config and routing without spending a byte of provider quota or making a network request. It reports the Node version against the 22.13 floor, node:sqlite availability, each provider's readiness (agy/claude on PATH, and whether each API key comes from env or the config file, with a copy-paste fix for what is missing), which provider will be selected and from which layer (flag, config, or default), the detected harness and whether the verdict came from process ancestry or an environment fingerprint, and the config file's path and permission bits. Add `--json` for a machine-readable report. Troubleshooting now opens by pointing at it.
- OpenCode paste recovery works on Windows again (issue #11). Matching a session compared `path.resolve(cwd)`, which is backslash-separated on Windows, against opencode's forward-slash `session.directory`, so the equality and both prefix checks missed every row and recovery returned nothing. The v2.8.0 change that turned `--session` into a directory-narrowing filter meant the old `--session` workaround stopped helping too. Both sides are normalized to forward slashes before matching now, with the LIKE wildcard escaping preserved.
- A provider that ignores SIGTERM on timeout is now actually killed. The SIGKILL backstop checked `child.killed`, which turns true the moment a signal is delivered, not when the process exits, so a child that trapped SIGTERM read as already dead and was never escalated. It now tracks whether the process has exited and sends SIGKILL when it has not.
- The published npm package now includes `docs/`, `CHANGELOG.md`, and `SECURITY.md`. The README links to the harness, security, and troubleshooting docs, but the `files` allow-list left them out of the tarball, so those links 404'd for anyone reading the package on npm.
- CI now runs on macOS as well as Linux across the Node 18/20/22 matrix, so a macOS-only regression (path handling, `mkdtemp`, file modes) is caught before release.
- `vitest` moves to 3.2.7 to match `@vitest/coverage-v8`, silencing the version-mismatch warning `pnpm coverage` printed when the two drifted.
- The `node:sqlite` requirement for OpenCode paste recovery is stated correctly: Node **22.13+**, not 22.5. The module was added in 22.5 but behind `--experimental-sqlite`, and only became available without a flag in 22.13. Both READMEs, CONTRIBUTING, the harness and troubleshooting docs, the runtime error message, and the CI comment now agree.
- Publishing happens in exactly one place now. `scripts/release.mjs` and the tag-triggered `release.yml` workflow both ran `npm publish` and created the GitHub Release, a race that could double-publish or leave a half-finished release. `release.mjs` keeps every guard, the version bump, commit, tag, and push, but stops at the tag: pushing it hands off to CI, which publishes with provenance and cuts the GitHub Release from the matching CHANGELOG section.
- The subprocess providers (`antigravity-cli`, `claude-cli`) now run in a throwaway directory holding only the input image, not in the image's own directory. `agy` runs with `--dangerously-skip-permissions`, so an injection in an image sitting beside other files could in principle steer the agent into reading them. Each call now hardlinks (or copies) the one image into a fresh `mkdtemp` directory, runs there, and removes it afterward. An explicit `--workdir` keeps the old behaviour.
- Structural schema validation now runs for every provider, not just `openai`. The shape check that caught half-filled results lived inside the OpenAI-compatible path, so a malformed result from gemini, anthropic, agy, or claude-cli could slip through if the server-side schema was not honoured. The check moved into `schema.ts`, and the analyzer runs it over every provider's result, naming the provider when a field is missing.
- Remote image downloads are now capped at 25 MB and their type is confirmed from the file header rather than guessed. `fetchRemoteImageBase64` read the whole response into memory with no ceiling (a memory-exhaustion vector) and trusted a server's `content-type`, defaulting to `image/jpeg` for anything else. It now rejects an oversized `content-length` up front, enforces the cap while streaming, sniffs the magic bytes (png/jpeg/gif/webp) as the authority over a faked extension or lying header, and refuses a type outside the allow list instead of relabelling it. Local reads go through the same type check.
- `recover-paste` no longer writes to a fixed, shared `<tmpdir>/modlens-paste` by default. A `recursive` mkdir does not re-apply its mode to a directory that already exists, so on a shared machine another user could pre-create that path and read every screenshot recovered into it. Each run now mints a private `mkdtemp` directory instead. An explicit `--out-dir` is still honoured, but an existing one is rejected unless it is a real directory (not a symlink), owned by the current user, with no group or world access. Recovered files are deliberately left in place for `modlens -i` to read.

- `config show` prints the effective config now, merging environment variables over the file and tagging each value file or env. Reading only the file hid keys set through `GEMINI_API_KEY` and the other bound vars, so the value modlens actually used never appeared.
- Local image paths containing `#` or `?` keep their real extension. Routing them through `new URL()` read the character as a fragment or query and dropped the extension, mislabelling the type as JPEG.
- The disclaimer no longer contradicts the MIT license it ships beside. It withholds warranty and endorsement without withholding the commercial-use right MIT grants, and points at the upstream engines' own terms.
- Docs caught up with the code. Both READMEs gained `--provider-bin`, `--workdir`, a per-provider default-model table, a full `recover-paste` flag table, and the `meta` output fields, with `MODLENS_HARNESS` and `--out-dir` written up in troubleshooting. The anthropic recipe warns that `ANTHROPIC_BASE_URL` can silently reroute a vision request to a text-only gateway. AGENTS.md drops three claims that had gone stale.
- Internals, all behavior-preserving: the duplicated JSON helpers (parse, extract, truncate) collapsed into one `util/json` module, and the 710-line `recoverPaste` split into per-harness modules. An always-true branch and a few lint findings cleared.
- Tooling: Biome for formatting and linting on the repo's 4-space style, a Node 18/20/22 CI matrix that skips the `node:sqlite` tests where the module is unavailable, `@vitest/coverage-v8` with a `coverage` script, tests for the CLI assembly, and a tag-triggered release workflow that publishes with provenance. Adds the collaboration files a public repo expects: CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and pull-request templates, and Dependabot.
- The Chinese README's plug now invites readers to the WeChat public account rather than installing the liustack skills.
- `release.mjs` matches the CHANGELOG again: version dots are escaped literally and the section ends at end of file, so the newest entry (and versions like `2.8.0`) match instead of being missed.

## 2.8.0 - 2026-08-06

- README rebuilt against how widely used projects actually write theirs: install command inside the first screen, a nav row and badges in the hero, short scannable highlights, and roughly 1,000 words instead of a long read. Harness specifics and security detail moved into `docs/harness-setup.md` and `docs/security.md`, with a Documentation table pointing at them.

## 2.7.11 - 2026-08-06

- Stops calling it OCR. A vision model reading an image is not OCR, which is a specific and different technology, and the word was borrowed for convenience across the README, the skill, and both articles. The prose now says what actually happens: every word in the image is transcribed. The `ocr` field in the output contract keeps its familiar name, with a note that a vision model does the reading.

## 2.7.10 - 2026-08-06

- README rewritten rather than patched again. The hero buried the one thing that sets this apart (you can paste) under a generic pitch, then repeated it in a feature list and again in its own section. The opening now leads with pasting, the feature list is gone as duplication, and the comparison against swapping models or running a vision MCP server sits where a reader weighing options will find it.

## 2.7.9 - 2026-08-06

- The flow diagram says something again. Replacing ASCII art with an abstract illustration removed the labels along with the alignment chore, which was a bad trade. It is now a rendered diagram with real labels, one per language, generated from HTML so nothing drifts.

## 2.7.8 - 2026-08-06

- Releases are now one command: `pnpm release <version|patch|minor|major>` refuses a dirty tree, a non-main branch, a duplicate tag, or a version with no CHANGELOG entry, then runs typecheck, tests, and build before anything irreversible happens, and finishes with tag, push, npm publish, and a GitHub release. Publishing by hand is how a version once reached npm with no changelog and no tag behind it.
- Every previously published version now has a git tag, reconstructed from the commit that carried it.

## 2.7.7 - 2026-08-05

- README: leads with a scannable feature block (paste support, evidence rather than a description, honest uncertainty, no model swap, zero-key start, four harnesses) and states requirements. Adds a comparison against swapping in a multimodal model and against vision MCP servers, our own weaknesses included.
- New `docs/troubleshooting.md`: every error this CLI prints, with cause and fix, linked from the README and the skill.
- The ASCII flow diagram is now a real illustration. Its alignment had needed repair across several releases, which is a poor trade for a picture.
- The Gemini CLI era research doc is marked historical so it is not read as current design.

## 2.7.6 - 2026-08-05

- `config init` now writes only the shape (`{"provider": "", "providers": {}}`) instead of all five providers with their fields pre-filled. Baked-in defaults in a config file silently outrank later changes to those defaults, and the placeholders hid the one decision that matters. The command prints what can be set instead.

## 2.7.5 - 2026-08-05

A verification pass on the 2.7.4 fixes (same external reviewer) found four that did not hold and three bugs the fixes themselves introduced. All seven are addressed here.

**Fixes that did not hold**

- Unreadable config files still became empty configs: the 2.7.4 edit never applied, because this file is indented differently from its sibling project. Permissions errors now surface.
- Harness detection still matched a flag's value: `node --require pi app.js` read as Pi. The script behind a node shim must now look like a path to a script.
- agy log evidence was scoped by file mtime alone, so a concurrent call or an older failure in the same file still misdiagnosed this run. Lines are now filtered by their own glog timestamps.
- The openai schema check only looked at top-level keys, so `{"ocr":{}}` passed. Nested required fields are checked.

**Bugs introduced by the 2.7.4 fixes**

- `transcriptBelongsTo` returned on the first recorded cwd, so a transcript whose first line matched could still hand over another project's images. Any matching line now decides, and a transcript with cwd lines that all mismatch is rejected.
- That check also read every transcript in full, then the image scan read it again. Each file is read once.
- The alias table added for config lookups was written by hand and did not match the real provider aliases (`claude` resolves to `anthropic`, not `claude-cli`, and `claude-code` and `openai-compat` were missing), so settings landed on the wrong provider. The table now comes from the provider registry.
- `--transcript` skipped harness validation, so `--harness bogus` silently parsed the file as Claude Code.

## 2.7.4 - 2026-08-05

Correctness and privacy pass after an external review (gpt-5.6-sol) that proved every finding with a probe.

**Recovering the wrong project's images**

- OpenCode directory matching passed the project path straight into SQL `LIKE`, where `_` and `%` are wildcards, so a path containing either matched other projects. Patterns are escaped now.
- `--session <id>` dropped the directory condition entirely, and session slugs are not unique across projects. The reviewer found two colliding slugs in a real local database. A session now narrows the directory match instead of replacing it.
- Claude Code and Pi directory slugs are lossy: `/tmp/project.alpha` and `/tmp/project-alpha` produce the same slug. Both harnesses record the real cwd inside the transcript, which is now checked before a transcript is trusted.

**Privacy**

- Recovered images landed as 0644 inside a 0755 directory, so on a shared `/tmp` any local user could read them. They are written 0600 into a 0700 directory, and re-chmodded because the filenames are content hashes and an existing file keeps its old mode.

**Correctness**

- A successful run could be reported as a timeout: the timer stayed armed while output drained, so a slow drain turned exit code 0 into a timeout error. It is cleared when the child exits.
- A timeout sent one SIGTERM and then waited, so an engine ignoring signals hung the CLI. It now settles immediately and escalates to SIGKILL.
- Output decoding kept no state across chunks, so a multi-byte character split across a chunk boundary became replacement characters.
- The OpenCode "needs Node 22.5" message was swallowed by an empty catch, leaving only "no pasted images". Setup problems now travel with the error.
- `--harness` was ignored when `--transcript` was given, so a copied Pi transcript was parsed as Claude Code. `--transcript <db>` also ignored `--cwd`.
- Harness detection scanned the first eight command tokens, so a command that merely mentioned "pi" in its arguments was detected as Pi. Only the executable, plus the script path behind a node shim, is read now.
- agy log evidence was accepted if the file was under two minutes old, which let a previous quota failure or a concurrent agy call misdiagnose an unrelated error. Evidence must now postdate the start of this run.
- The `claude-cli` provider inherited a 30 second kill grace meant for agy's own `--print-timeout`, silently extending `--timeout`. The grace applies only to engines with an internal deadline.
- The openai provider's "schema validation" accepted `{"summary":"x","ocr":null}` and anything missing layout, semantics, visual, or uncertainty. All required fields are checked.
- Settings saved under a provider alias (`config set gemini.apiKey`) were invisible once the name resolved to `gemini-api`.
- An unmapped image type was relabelled `.png`, so downstream tools reading the extension got the wrong type.
- `ENOENT` from spawn was always reported as a missing CLI, even when the real cause was a missing working directory.
- A config file that exists but cannot be read (permissions) silently became an empty config.

## 2.7.3 - 2026-08-05

- Fix: a failing `antigravity-cli` run now explains itself instead of reporting a bare exit code ([#3](https://github.com/liustack/modlens/issues/3), thanks @mtongle). Providers gained a `describeFailure` hook, and the agy provider uses it to surface agy's own error text and classify the two failures users actually hit: a locked OS keyring in headless sessions (the report's case, where agy claims to be signed out) and an exhausted weekly quota. Both messages end with the exact commands to switch to a keyless, quota-independent provider. Diagnosis only reads agy's log when this run produced an agy error envelope and the log is fresh, so stale logs cannot misdiagnose an unrelated failure.
- Docs: README leads with paste support, recommends the free AI Studio key over the slower agy default, and documents that the skill configures modlens for you on request.

## 2.7.2 - 2026-08-05

- Fix: runs with the `antigravity-cli` provider hung until the timeout killed them ([#1](https://github.com/liustack/modlens/issues/1), thanks @hawkmor for the diagnosis). agy exits cleanly but leaves a language server holding the inherited stdout pipe, so the child's `close` event never fires. The provider run now settles on `exit` plus a short drain window, and releases the pipes afterwards so a lingering descendant cannot keep the CLI process alive either.

## 2.7.1 - 2026-08-04

- Docs: per-harness skill discovery paths (`~/.claude/skills/`, `~/.codex/skills/`, `~/.agents/skills/` for Pi and OpenCode), OpenCode + DeepSeek setup recipe, and the four-harness live verification matrix (Claude Code session-id recovery, OpenCode full skill loop on DeepSeek, Pi store isolation, Codex refusal).

## 2.7.0 - 2026-08-04

- `recover-paste` now identifies the harness it is running inside before touching any storage: process ancestry first (the nearest known harness among parent processes, which also resolves nested setups to the innermost tool), env fingerprints second (`CLAUDECODE`, `PI_CODING_AGENT`, `CODEX_THREAD_ID`). Detection scopes recovery to that harness's store only, so another tool's stale sessions can never hijack a paste; Codex is refused outright with path-tag guidance. `--harness <name|none>` overrides, output gains a `detected` field.
- In Claude Code, recovery auto-targets the exact session from the injected `CLAUDE_CODE_SESSION_ID`, falling back to newest-image scanning when that transcript holds no images (subagent sessions).

## 2.6.1 - 2026-08-03

- Fix: opencode runs shell commands at the repo root while sessions record the directory they were launched in. Exact directory matching made recovery miss the real paste and fall through to stale Claude Code transcripts of the same project, recovering the wrong images (caught in a live session). Directories now match by prefix in both directions, and recovery is scoped to the single opencode session owning the newest image.
- Recovered entries report `filename` (the original attachment name) when the harness stored one.
- Skill: recovered paths are oldest to newest so analyze the last one first, match `filename` when present, run every command yourself instead of delegating to the user, and treat a `harness` value that differs from the harness you are running in as suspect.

## 2.6.0 - 2026-08-03

- `recover-paste` now supports OpenCode: pasted/attached images are read from its SQLite store (`~/.local/share/opencode/opencode.db`) via node:sqlite (Node 22.5+, lazy-loaded so older Nodes keep the JSONL harnesses). Recovery internals refactored into per-harness adapters (Claude Code, Pi, OpenCode) sharing one newest-image picker. Verified against a real opencode + deepseek session.

## 2.5.0 - 2026-08-03

- `recover-paste` now supports Pi (Armin Ronacher's coding agent) alongside Claude Code: both store pasted images as base64 in per-session JSONL files, and recovery auto-detects which harness owns the newest pasted image. Verified live against a real pi + deepseek session. Result JSON gains a `harness` field.

## 2.4.3 - 2026-08-03

- Docs: the Claude Code paste-recovery loop is now marked as verified end to end in a real DeepSeek-gateway session (placeholder spotted, file recovered by session id, image answered in full).

## 2.4.2 - 2026-08-03

- Project hygiene: CHANGELOG, GitHub Actions CI, AGENTS.md rewrite, testing guide rewrite, recover-paste and config command reference in READMEs, dead code removal, auto-externalized Node built-ins in the build.

## 2.4.1 - 2026-08-03

- Skill: path-finding is now a per-harness decision tree. Codex path tags never trigger transcript recovery, unknown harnesses are told to ask for a path instead of guessing.

## 2.4.0 - 2026-08-03

- `recover-paste --session <id>`: exact transcript targeting. Skills relay `${CLAUDE_SESSION_ID}` (substituted by Claude Code since v2.1.9); without it, recovery falls back to newest-image-timestamp scanning.

## 2.3.2 - 2026-08-03

- Tests co-located with sources, one module one `.test.ts` (31 to 50 tests). First direct coverage for `prompt` and `imageInput`.
- Skill explains why `recover-paste` takes no session id.

## 2.3.1 - 2026-08-03

- `recover-paste` locates the session by newest pasted-image timestamp instead of file mtime, immune to concurrent sessions in the same project.

## 2.3.0 - 2026-08-03

- New `recover-paste` command: recovers images pasted into Claude Code from the local session transcript (they never hit a regular temp file), prints real file paths as JSON.

## 2.2.0 - 2026-08-03

- New `claude-cli` provider: rides an existing Claude Code login, `--allowedTools Read` only, `--json-schema` enforced, haiku default.
- Skill routes configuration questions to `references/configure.md`.

## 2.1.0 - 2026-08-02

- Three direct-API providers: `gemini-api` (free AI Studio key, `responseJsonSchema`), `openai` (any OpenAI-compatible multimodal endpoint), `anthropic` (forced tool call, Claude Haiku default). 3-10s per image versus 15-40s agent loops.
- Layered config: `~/.modlens/config.json` via `config init/set/show` (0600, masked), env vars override the file, flags override everything.

## 2.0.0 - 2026-08-01

- Breaking: vision engine migrated from the discontinued Gemini CLI free tier to Antigravity CLI (`agy`).
- Provider layer (`buildInvocation` + `parseOutput`), schema-enforced structured output via `--json-schema`, no markdown scraping.
- Output contract v2: `result`/`meta` envelope; fabricated bbox and confidence fields dropped.
