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
export const inject = ['tools', 'agents', 'attachments', 'llm']

const MEDIA_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

export function apply(ctx, config = {}) {
  // Off by default since the vision provider converts at request time and
  // keeps the durable log (and the UI thumbnail) intact; turn it on only for
  // setups where images enter through a provider this plugin does not wrap.
  if (config.autoRead === true) {
    registerAutoRead(ctx)
  }
  if (config.visionProvider !== false) {
    registerVisionProvider(ctx, config)
  }
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

/**
 * Phase 3: the paste unlock. dsh's image admission asks the selected
 * provider's adapter for inputModalities, and the DeepSeek adapter hardcodes
 * text-only, so pastes are refused before any plugin hook runs. This wrapper
 * registers a NEW provider whose model metadata declares image input and
 * whose stream() is a one-line delegation back to the real route. Pick the
 * wrapped model in the model selector, paste, and the pre-step rewrite below
 * turns the image into evidence text before the delegated request goes out;
 * the upstream serializer's own image rejection stays as the fail-closed
 * backstop. Guarded feature-detection: if the llm registration surface moved
 * (developer preview), the plugin quietly stays a read_image-only tool.
 */
function registerVisionProvider(ctx, config) {
  const upstream = config.upstream || 'deepseek-official'
  const providerId = config.providerId || 'deepseek-modlens'
  if (typeof ctx.llm?.registerAdapter !== 'function' || typeof ctx.llm?.stream !== 'function') {
    return
  }
  const withVision = (info) => ({
    ...info,
    provider: providerId,
    inputModalities: ['text', 'image'],
  })
  try {
    ctx.llm.registerAdapter([providerId], {
      // Duck-typing LlmAdapter: providerInfo/providerRetryPolicy are base-class
      // defaults a plain object must supply itself (their absence is exactly
      // the silent registration failure this catch used to swallow).
      providerInfo(provider) {
        return { id: provider, name: 'DeepSeek (modlens vision)' }
      },
      providerRetryPolicy() {
        return undefined
      },
      async listModels(_provider, signal) {
        try {
          const models = await ctx.llm.listModels(upstream, signal)
          return models.map((model) => ({
            ...withVision(model),
            name: `${model.name ?? model.id} (modlens vision)`,
          }))
        } catch {
          return []
        }
      },
      async resolveModel(_provider, model, signal) {
        const info = await ctx.llm.resolveModelInfo(upstream, model, signal)
        return { ...withVision(info), id: model }
      },
      stream(options) {
        // Convert at request time, not at log time: the durable session log
        // keeps the real image blocks (so the UI shows the paste natively),
        // and only the wire messages carry evidence text. Cached per
        // attachment, since the same history rides every later step.
        const self = this
        return (async function* () {
          const messages = await convertImagesToEvidence(ctx, options.messages, options.signal, self)
          yield* ctx.llm.stream({ ...options, provider: upstream, messages })
        })()
      },
      evidenceCache: new Map(),
    })
  } catch (error) {
    // DUPLICATE_ADAPTER or a preview-era surface change: degrade to the
    // read_image-only plugin, but say so in the harness log instead of
    // vanishing (a swallowed TypeError here once hid a missing base method).
    console.error(`[modlens] vision provider registration skipped: ${error}`)
  }
}

async function convertImagesToEvidence(ctx, messages, signal, adapter) {
  const out = []
  for (const message of messages) {
    if (!Array.isArray(message.content) || !message.content.some((b) => b?.type === 'image')) {
      out.push(message)
      continue
    }
    const content = []
    for (const block of message.content) {
      if (block?.type !== 'image') {
        content.push(block)
        continue
      }
      const key = JSON.stringify(block.attachment ?? block)
      let text = adapter.evidenceCache.get(key)
      if (text === undefined) {
        text = (await readImageBlock(ctx, block, signal)).text
        adapter.evidenceCache.set(key, text)
      }
      content.push({ type: 'text', text })
    }
    out.push({ ...message, content })
  }
  return out
}

/**
 * Phase 2: paste auto-route. When entered messages carry image blocks (the
 * Web UI's paste/drop intake) and the model behind dsh is text-only, rewrite
 * each image block into a modlens evidence text block before the step starts.
 * Runs after `next()` so downstream pre-step listeners (compaction, context
 * injectors) see and shape the same final message set; a failed read degrades
 * to an explanatory text block instead of rejecting the step.
 */
function registerAutoRead(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') {
      return decision
    }
    const hasImage = decision.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block?.type === 'image'),
    )
    if (!hasImage) {
      return decision
    }
    const messages = []
    for (const message of decision.messages) {
      if (!Array.isArray(message.content)) {
        messages.push(message)
        continue
      }
      const content = []
      for (const block of message.content) {
        if (block?.type !== 'image') {
          content.push(block)
          continue
        }
        content.push(await readImageBlock(ctx, block, payload.signal))
      }
      messages.push({ ...message, content })
    }
    return { kind: 'enter', messages }
  })
}

async function readImageBlock(ctx, block, signal) {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  let dir
  try {
    // StoredImageAttachment carries { ref, data: Uint8Array }; the media type
    // rides the reference (verified against dsh attachment/src/types.ts).
    const stored = await ctx.attachments.readImage(block.attachment, signal)
    dir = await mkdtemp(join(tmpdir(), 'modlens-dsh-'))
    const mediaType = stored.ref?.mediaType ?? block.attachment?.mediaType
    const file = join(dir, `paste${MEDIA_EXT[mediaType] ?? '.png'}`)
    await writeFile(file, Buffer.from(stored.data), { mode: 0o600 })
    const cli = process.env.MODLENS_DSH_CLI || CLI_PATH
    const { stdout, stderr, code } = await run(
      process.execPath,
      [cli, '-i', file, '--timeout', String(CLI_TIMEOUT_MS)],
      signal,
    )
    if (code !== 0) {
      throw new Error((stderr || stdout).trim().slice(0, 300))
    }
    const parsed = JSON.parse(stdout)
    return {
      type: 'text',
      text: `[Pasted image, read by the modlens vision bridge]\n${renderEvidence(parsed.result)}`,
    }
  } catch (error) {
    return {
      type: 'text',
      text: `[A pasted image could not be read by modlens: ${
        error instanceof Error ? error.message.slice(0, 300) : String(error)
      }. Tell the user, and suggest running \`npx @liustack/modlens doctor\`.]`,
    }
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
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
