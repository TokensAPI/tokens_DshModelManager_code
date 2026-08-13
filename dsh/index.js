// DeepSeek Harness (dsh) plugin: registers a read_image tool backed by the
// modlens CLI that ships in this very package. dsh models are text-only, so
// the tool is the vision bridge; unlike prompt-triggered skills, a registered
// tool schema reaches the model on every request, so there is no trigger
// gamble. The engine is spawned from ../dist/main.js inside this package:
// no PATH lookup, no npx, the plugin and its engine version-lock together.
//
// Loaded via the cordis.patch.yml row `@liustack/modlens/dsh` (see the
// package.json `dsh.bundle` manifest). Providers, reuse grants, and guard
// rules keep living in ~/.modlens/config.json, shared with every harness.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLI_PATH = fileURLToPath(new URL('../dist/main.js', import.meta.url))
// Kept in lockstep with src/schema.ts by a repo test; the plugin file cannot
// import the TS source and stays fully dependency-free (node builtins only).
const OUTPUT_SCHEMA = JSON.parse(
  readFileSync(new URL('./vision-schema.json', import.meta.url), 'utf8'),
)

const CLI_TIMEOUT_MS = 180_000

export const name = 'modlens'
export const inject = ['tools']

export function apply(ctx) {
  // Registered as a raw JSON-Schema tool definition (no dsh package imports:
  // the developer-preview registry accepts these and out-of-tree resolution
  // of @deepseek-ai/dsh-tools is not yet reliable), so this plugin owns its
  // own argument validation inside execute.
  ctx.tools.register({
    name: 'read_image',
    description:
      'Read an image through the modlens vision bridge. Use whenever a message references an image the current model cannot see: a local file path or an http(s) URL to a screenshot, photo, chart, diagram, or document scan. Returns structured evidence with every word transcribed (ocr.full_text), layout regions in reading order, semantics, and an uncertainty list; quote the evidence instead of guessing. Requires a configured modlens engine (run `npx @liustack/modlens doctor` in a terminal to check).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute local file path or http(s) URL of the image',
        },
        prompt: {
          type: 'string',
          description: 'Optional extra focus for the reading (e.g. "focus on the axis labels")',
        },
      },
      required: ['path'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderEvidence(value) }],
    },
    // The CLI enforces its own deadline; this is the cooperative backstop.
    timeoutMs: CLI_TIMEOUT_MS + 20_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: 'read_image',
      kind: 'read',
      rawInput: args,
      ...(typeof args?.path === 'string' && !/^https?:\/\//i.test(args.path)
        ? { locations: [{ path: args.path }] }
        : {}),
    }),
    async execute(args, exec) {
      if (typeof args?.path !== 'string' || args.path.trim() === '') {
        throw new Error('read_image needs a non-empty string "path".')
      }
      const cliArgs = [CLI_PATH, '-i', args.path, '--timeout', String(CLI_TIMEOUT_MS)]
      if (args.prompt) {
        cliArgs.push('--prompt', args.prompt)
      }
      const { stdout, stderr, code } = await run(process.execPath, cliArgs, exec.signal)
      if (code !== 0) {
        throw new Error(
          `modlens failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`,
        )
      }
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        throw new Error(`modlens produced no JSON: ${stdout.trim().slice(0, 300)}`)
      }
      // The canonical value is the vision result itself; routing details
      // (meta.attempts, whose quota a reused engine spent) stay operational.
      return parsed.result
    },
  })
}

function run(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

function renderEvidence(value) {
  const lines = [value.summary]
  const text = value.ocr?.full_text?.trim()
  if (text) {
    lines.push('', 'Transcription:', text.length > 4000 ? `${text.slice(0, 4000)}…` : text)
  }
  const uncertainty = value.uncertainty ?? []
  if (uncertainty.length > 0) {
    lines.push('', `Uncertain: ${uncertainty.join('; ')}`)
  }
  return lines.join('\n')
}
