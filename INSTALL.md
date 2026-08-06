# Installing ModLens

This guide is written for an **AI agent** that a user has asked to install the ModLens
skill. Follow the four steps in order. Every step is idempotent: running it again on a
machine that is already set up does no harm, so when in doubt, run it.

You are done when Step 4 (`npx @liustack/modlens doctor`) shows the **selected provider**
as `[ok]`. Other providers reading `[!!]` is expected and fine: only the one that will run
has to be ready.

Requirements: Node 22.13 or newer. Check with `node --version`. If it is older, install a
newer Node before continuing (the rest will fail on an old runtime).

---

## Step 1 — Identify the host and its skill directory

Each coding agent loads skills from a fixed directory. Decide which one to install into.

| Host | Skill directory |
| :-- | :-- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi, OpenCode | `~/.agents/skills/` |

How to decide which host you are dealing with, in order of confidence:

1. **You know the host you are running inside.** Use its row from the table.
2. **Otherwise, check which home directories exist** and install into each that does:

   ```bash
   ls -d ~/.claude ~/.codex ~/.agents 2>/dev/null
   ```

   `~/.claude` means Claude Code, `~/.codex` means Codex, `~/.agents` means Pi or OpenCode.

**Multiple hosts on one machine.** Either install into each host's directory (Step 2 is cheap
to repeat), or install once and symlink. To share a single copy, put the skill under
`~/.agents/skills/modlens` and point the others at it:

```bash
mkdir -p ~/.claude/skills ~/.codex/skills
ln -sfn ~/.agents/skills/modlens ~/.claude/skills/modlens
ln -sfn ~/.agents/skills/modlens ~/.codex/skills/modlens
```

`ln -sfn` replaces an existing link in place, so this is safe to re-run.

**If it fails:** a missing parent directory is the usual cause. `mkdir -p` the skill
directory first, then retry.

---

## Step 2 — Place the skill

The goal is a `modlens` directory containing `SKILL.md` inside the skill directory from
Step 1. There are two equivalent ways. Try the CLI first; fall back to the manual copy if it
is unavailable.

### Path A — the skills CLI (one command)

```bash
npx -y skills add liustack/modlens
```

This is a third-party installer (the `skills` CLI, not part of ModLens). It detects the host
and writes the skill to the right directory. If the command is missing, the network blocks
it, or it errors, use Path B.

### Path B — clone and copy (works anywhere with git)

Set `DEST` to the skill directory you chose in Step 1, then run the block as-is:

```bash
DEST="$HOME/.claude/skills"          # <- change per Step 1 (~/.codex/skills or ~/.agents/skills)
SRC="$(mktemp -d)"
git clone --depth 1 https://github.com/liustack/modlens.git "$SRC"
mkdir -p "$DEST"
rm -rf "$DEST/modlens"               # remove any earlier copy so this is a clean replace
cp -R "$SRC/skills/modlens" "$DEST/modlens"
rm -rf "$SRC"
```

Confirm the copy landed:

```bash
ls "$DEST/modlens/SKILL.md"
```

**If it fails:**

- `git: command not found` — install git, or use Path A.
- Clone is blocked by the network — download the repository archive by hand and copy its
  `skills/modlens` directory to `$DEST/modlens`.
- `SKILL.md` is missing after the copy — `DEST` was wrong or the copy did not run. Re-check
  Step 1 and run the block again.

---

## Step 3 — Give it a vision engine

The skill calls the `modlens` CLI, which needs one vision engine configured. Pick the
shortest path that fits the machine. For an agent or any headless session, prefer the Gemini
key: it needs no interactive login and works without a display.

### Option 1 — Gemini API key (recommended, works headless)

```bash
npx @liustack/modlens config set gemini-api.apiKey <KEY>
npx @liustack/modlens config set provider gemini-api
```

Get a free `<KEY>` from [Google AI Studio](https://aistudio.google.com) (about three
minutes, no credit card). If you cannot obtain a key yourself, ask the user for one and run
the two commands with it. The key is written to `~/.modlens/config.json` with `0600`
permissions; re-running the commands overwrites the value in place.

### Option 2 — Antigravity CLI (no key, needs a browser sign-in)

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Then the **user must run `agy` once and complete the Google sign-in in a browser**. This step
is interactive and cannot be automated. Antigravity is slower than the Gemini key and its
login token lives in the OS keyring, which is locked in most headless sessions (agents, cron,
systemd, SSH without a desktop), so on those machines Option 1 is the reliable choice.

**If it fails:** a provider that stays `[!!]` in Step 4 with `missing: apiKey` means the key
was not saved, so run Option 1 again. `agy not on PATH` means Antigravity did not install or
the shell has not picked it up yet.

---

## Step 4 — Verify

Run the diagnostic. It reads the local machine only: no network call, no quota spent.

```bash
npx @liustack/modlens doctor
```

A healthy result for the recommended Gemini setup looks like this (trimmed):

```
Providers
  [ok] gemini-api: apiKey: file
  ...
Selected provider
  gemini-api
  reason: provider set in the config file
```

**Success is the two lines under `Selected provider`:** the provider named there is the one
that will run, and it must appear as `[ok]` in the `Providers` list above. The other
providers showing `[!!]` is normal and needs no action.

Common lines and what they mean:

| Line | Meaning | Fix |
| :-- | :-- | :-- |
| `[!!] ... (minimum 22.13)` under `Node` | Node is too old | Upgrade Node to 22.13+ |
| `Selected provider: antigravity-cli` when you configured Gemini | The provider was never switched | Re-run `config set provider gemini-api` (Step 3) |
| `[!!] gemini-api: missing: apiKey` | The key was not saved | Re-run the Step 3 Option 1 commands |
| `[!!] antigravity-cli: agy not on PATH` | Antigravity is not installed or not signed in | Use Option 1, or complete Step 3 Option 2 |
| `none detected` under `Harness` | You are not inside a recognized agent right now | Fine for a plain CLI check; recovery detects the harness at run time |

Add `--json` for a machine-readable report you can parse directly:

```bash
npx @liustack/modlens doctor --json
```

Once the selected provider reads `[ok]`, installation is complete. The skill triggers on its
own the next time an image shows up. To confirm the CLI end to end, run it on any local
image: `npx @liustack/modlens -i <path-to-image>`.
