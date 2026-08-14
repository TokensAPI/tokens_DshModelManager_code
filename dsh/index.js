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

export const MEDIA_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
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
  // Paste-to-path: the browser half (dsh/client.js) intercepts image pastes
  // and POSTs the bytes here; the file lands in a private temp dir and the
  // path text goes into the composer instead of an image attachment. A
  // text-only model then never trips image admission, and the path is the
  // same trigger shape Pi, OpenCode, and Claude Code hand their models.
  // webServer exists only under the web profile, and this cordis has no
  // optional-inject form, so the route rides a scoped ctx.inject: the closure
  // runs when the service appears and never runs where it does not (headless
  // stays untouched, and the plugin itself never waits on it).
  if (config.pasteToPath !== false && typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerPasteRoute(scope)
      } catch (error) {
        console.error(`[modlens] paste-to-path route skipped: ${error}`)
      }
    })
  }
  // Registered as a raw JSON-Schema tool definition (no dsh package imports:
  // the developer-preview registry accepts these and out-of-tree resolution
  // of @deepseek-ai/dsh-tools is not yet reliable), so this plugin owns its
  // own argument validation inside execute.
  //
  // The name can collide: hosts with a durable attachment store mount their
  // own native read_image (dsh-tool-fs), and a duplicate registration throws,
  // which used to fail the whole plugin fiber (issue #21). The collision
  // falls back to a prefixed name — valuable exactly there, since the native
  // tool is gated on the model declaring image input and vanishes for
  // text-only models — and any other registration error degrades loudly
  // instead of taking the vision wrapper down with it.
  const readImageTool = (toolName) => ({
    name: toolName,
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
  const preferred = config.toolName || 'read_image'
  try {
    ctx.tools.register(readImageTool(preferred))
  } catch (error) {
    const fallback = 'modlens_read_image'
    if (preferred !== fallback && /already|duplicate/i.test(String(error))) {
      try {
        ctx.tools.register(readImageTool(fallback))
        console.error(
          `[modlens] tool name "${preferred}" is taken by the host; registered as "${fallback}" instead`,
        )
      } catch (retryError) {
        console.error(`[modlens] read_image registration skipped: ${retryError}`)
      }
    } else {
      console.error(`[modlens] read_image registration skipped: ${error}`)
    }
  }
}

// Image magic bytes for the paste route: refuse anything that is not a real
// image before a byte touches disk. Mirrors the CLI's sniffing table.
const PASTE_SNIFFS = [
  { ext: '.png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.gif', test: (b) => b.length >= 6 && b.toString('ascii', 0, 3) === 'GIF' },
  { ext: '.webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { ext: '.heic', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' },
]
const PASTE_MAX_BYTES = 25 * 1024 * 1024

/**
 * POST /modlens/paste: image bytes in, `{ path }` out. Bound to the dsh web
 * server, which listens on loopback by default; the file is private (0600)
 * in a fresh unpredictable temp dir, magic-byte checked and size-capped.
 */
function registerPasteRoute(ctx) {
  ctx.webServer.register({
    name: 'modlens-paste',
    kind: 'exact',
    path: '/modlens/paste',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      try {
        const chunks = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > PASTE_MAX_BYTES) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: `image over the ${PASTE_MAX_BYTES}-byte limit` }))
            req.destroy()
            return
          }
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)
        const sniff = PASTE_SNIFFS.find((s) => s.test(buffer))
        if (!sniff) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not a recognized image (png/jpeg/gif/webp/heic)' }))
          return
        }
        const { mkdtemp, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const dir = await mkdtemp(join(tmpdir(), 'modlens-dsh-paste-'))
        const file = join(dir, `paste${sniff.ext}`)
        await writeFile(file, buffer, { mode: 0o600 })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: file }))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
      }
    },
  })
}

/**
 * Phase 3: the paste unlock. dsh's image admission asks the selected
 * provider's adapter for inputModalities, and the DeepSeek adapter hardcodes
 * text-only, so pastes are refused before any plugin hook runs. This wrapper
 * registers a NEW provider whose model metadata declares image input and
 * whose stream() is a one-line delegation back to the real route. Pick the
 * wrapped model in the model selector, paste, and the request-time rewrite
 * turns the image into evidence text before the delegated request goes out;
 * the upstream serializer's own image rejection stays as the fail-closed
 * backstop. Guarded feature-detection: if the llm registration surface moved
 * (developer preview), the plugin quietly stays a read_image-only tool.
 *
 * Two modes (issue #29, design contributed by @zlycode01):
 * - `config.upstream` set: wrap exactly that one route, legacy behavior.
 * - unset: auto-discovery — every registered provider route carrying
 *   wrappable text-only family models gets its own `modlens-<provider>`
 *   wrapper, so a machine with several subscription packages (opencode-go,
 *   zai, ...) wraps them all instead of hand-picking one. A `discover` array
 *   of provider ids narrows the set. Routes that register late (llm-pi-ai
 *   mounts its routes after settings load) are picked up by re-sweeping on
 *   the registry's own `llm/adapters-updated` notification, no polling. The
 *   deepseek-official wrap keeps its historical `deepseek-modlens` id, so a
 *   selector remembering that provider survives the upgrade.
 */
function registerVisionProvider(ctx, config) {
  // Wrap only the text-only members of these families. Their own vision
  // models (present or future: deepseek-vl/ocr/janus, glm-4.5v, glm-5v-...)
  // need no bridge and are excluded by name and by declared modality.
  const families = config.families || ['deepseek', 'glm']
  const VISION_ID = /(deepseek-(vl|ocr)|janus|glm-[\d.]*v(\b|-))/i
  const shouldWrap = (info) => {
    const id = String(info?.id ?? '').toLowerCase()
    if (!families.some((family) => id.startsWith(family))) return false
    if (VISION_ID.test(id)) return false
    if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) return false
    return true
  }
  if (typeof ctx.llm?.registerAdapter !== 'function' || typeof ctx.llm?.stream !== 'function') {
    return
  }

  const registerWrapper = (upstream, providerId, displayName) => {
    const withVision = (info) => ({
      ...info,
      provider: providerId,
      inputModalities: ['text', 'image'],
    })
    try {
      ctx.llm.registerAdapter([providerId], {
        // Duck-typing LlmAdapter: providerInfo/providerRetryPolicy are
        // base-class defaults a plain object must supply itself (their
        // absence is exactly the silent registration failure this catch
        // used to swallow).
        providerInfo(provider) {
          return { id: provider, name: displayName }
        },
        providerRetryPolicy() {
          return undefined
        },
        async listModels(_provider, signal) {
          try {
            const models = await ctx.llm.listModels(upstream, signal)
            return models.filter(shouldWrap).map((model) => ({
              ...withVision(model),
              name: `${model.name ?? model.id} (modlens vision)`,
            }))
          } catch {
            return []
          }
        },
        async resolveModel(_provider, model, signal) {
          const info = await ctx.llm.resolveModelInfo(upstream, model, signal)
          if (!shouldWrap(info)) {
            throw new Error(`model "${model}" is outside the modlens vision wrap scope`)
          }
          return { ...withVision(info), id: model }
        },
        stream(options) {
          // Convert at request time, not at log time: the durable session
          // log keeps the real image blocks (so the UI shows the paste
          // natively), and only the wire messages carry evidence text.
          // Cached per attachment, since the same history rides every step.
          const self = this
          return (async function* () {
            const messages = await convertImagesToEvidence(ctx, options.messages, options.signal, self)
            yield* ctx.llm.stream({ ...options, provider: upstream, messages })
          })()
        },
        evidenceCache: new Map(),
      })
      return true
    } catch (error) {
      // A duplicate means a concurrent or earlier registration already won:
      // that is success for the claim, not a reason to retry forever.
      if (/already|duplicate/i.test(String(error))) {
        console.error(`[modlens] vision provider ${providerId} already registered, keeping the existing one`)
        return true
      }
      // A preview-era surface change: degrade to the read_image-only plugin,
      // but say so in the harness log instead of vanishing (a swallowed
      // TypeError here once hid a missing base method).
      console.error(`[modlens] vision provider registration skipped (${providerId}): ${error}`)
      return false
    }
  }

  if (config.upstream) {
    registerWrapper(
      config.upstream,
      config.providerId || 'deepseek-modlens',
      'DeepSeek (modlens vision)',
    )
    return
  }

  // Auto-discovery. `wrapped` guards duplicates across sweeps and the
  // self-nesting case (our own wrappers appear in listProviders too). Two
  // re-entrancy rules matter because registerAdapter itself broadcasts
  // llm/adapters-updated, so every successful wrap re-triggers a sweep:
  // an id is claimed in `wrapped` BEFORE any await (a concurrent sweep must
  // skip it while this one is still probing), and sweeps are serialized on
  // one promise chain so two can never interleave their probes at all.
  const discover = Array.isArray(config.discover) ? new Set(config.discover) : null
  const wrapped = new Set(['deepseek-modlens'])
  const sweepOnce = async () => {
    try {
      await sweepBody()
    } catch (error) {
      // A sweep failure must never become an unhandled rejection inside the
      // host process; the next topology notification simply tries again.
      console.error(`[modlens] vision provider discovery sweep failed: ${error}`)
    }
  }
  const sweepBody = async () => {
    if (typeof ctx.llm.listProviders !== 'function') {
      // Older registry surface: fall back to the single legacy wrap once.
      if (!wrapped.has('__legacy_fallback__')) {
        wrapped.add('__legacy_fallback__')
        registerWrapper('deepseek-official', 'deepseek-modlens', 'DeepSeek (modlens vision)')
      }
      return
    }
    for (const info of ctx.llm.listProviders()) {
      const id = info?.id
      if (!id || wrapped.has(id) || String(id).startsWith('modlens-')) continue
      if (discover && !discover.has(id)) continue
      // Claim before the await: the probe may suspend, and the sweep a
      // registration triggers must not probe the same id concurrently.
      wrapped.add(id)
      let models = []
      try {
        models = await ctx.llm.listModels(id)
      } catch {
        // Unreachable route today; release the claim so a later topology
        // change retries it.
        wrapped.delete(id)
        continue
      }
      if (!models.some(shouldWrap)) {
        // No eligible models yet: release, the route may gain some later.
        wrapped.delete(id)
        continue
      }
      const providerId = id === 'deepseek-official' ? 'deepseek-modlens' : `modlens-${id}`
      const base = info.name ?? id
      if (!registerWrapper(id, providerId, `${base} (modlens vision)`)) {
        wrapped.delete(id)
      }
    }
  }
  // Serialize: a sweep triggered mid-sweep runs after, never interleaved.
  // The first sweep is invoked directly so its synchronous prefix (the
  // legacy fallback, the pre-await claims) completes during apply().
  let sweeping = sweepOnce()
  const sweep = () => {
    sweeping = sweeping.then(sweepOnce, sweepOnce)
    return sweeping
  }
  if (typeof ctx.on === 'function') {
    ctx.on('llm/adapters-updated', () => {
      void sweep()
    })
  }
}

// The same pasted attachment rides every later step of its session, but the
// cache must never make a failure permanent or run the engine twice for
// concurrent steps. So it stores promises (concurrent readers join the first
// run), evicts failed reads on settle (a fixed config gets a fresh chance),
// and caps itself LRU-style so a long-lived Web profile cannot hoard
// evidence text forever.
const EVIDENCE_CACHE_LIMIT = 64

function cachedEvidence(ctx, adapter, block) {
  const key = JSON.stringify(block.attachment ?? block)
  const hit = adapter.evidenceCache.get(key)
  if (hit !== undefined) {
    // Refresh recency: Map iteration order is insertion order.
    adapter.evidenceCache.delete(key)
    adapter.evidenceCache.set(key, hit)
    return hit
  }
  // Deliberately no caller signal: a shared entry must not die with its first
  // caller (their abort used to cancel every concurrent joiner). A cancelled
  // caller simply stops awaiting; the read finishes and the cache keeps it.
  const pending = readImageBlock(ctx, block, undefined).then(
    (evidence) => {
      // Only evict our own entry: this promise may have been LRU-evicted and
      // the key re-populated by a newer read meanwhile.
      if (!evidence.ok && adapter.evidenceCache.get(key) === pending) {
        adapter.evidenceCache.delete(key)
      }
      return evidence.block
    },
    (error) => {
      // readImageBlock never rejects by contract; this is the belt for a
      // future refactor breaking that, so a rejected promise cannot lodge in
      // the cache forever.
      if (adapter.evidenceCache.get(key) === pending) {
        adapter.evidenceCache.delete(key)
      }
      return {
        type: 'text',
        text: `[A pasted image could not be read by modlens: ${
          error instanceof Error ? error.message.slice(0, 300) : String(error)
        }]`,
      }
    },
  )
  adapter.evidenceCache.set(key, pending)
  while (adapter.evidenceCache.size > EVIDENCE_CACHE_LIMIT) {
    adapter.evidenceCache.delete(adapter.evidenceCache.keys().next().value)
  }
  return pending
}

/**
 * Wait on a shared promise without inheriting its lifetime: the caller's
 * abort rejects THIS wait immediately, while the underlying read keeps
 * running and lands in the cache for the retry.
 */
function abortableWait(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Image blocks hide at two depths: top-level message content (pastes), and
 * inside tool-result content (dsh's own read_image tool nests one there).
 * The upstream adapter's rejection check recurses (issue #24), so the
 * conversion must recurse the same way or a nested image wedges the session
 * permanently — the durable log keeps the real block, and every later turn
 * re-fails on it.
 */
function contentHasImage(blocks) {
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (b) => b?.type === 'image' || (b?.type === 'tool-result' && contentHasImage(b.content)),
    )
  )
}

async function convertBlocks(blocks, convertOne) {
  const out = []
  for (const block of blocks) {
    if (block?.type === 'image') {
      out.push(await convertOne(block))
    } else if (block?.type === 'tool-result' && contentHasImage(block.content)) {
      out.push({ ...block, content: await convertBlocks(block.content, convertOne) })
    } else {
      out.push(block)
    }
  }
  return out
}

async function convertImagesToEvidence(ctx, messages, signal, adapter) {
  const out = []
  for (const message of messages) {
    if (!contentHasImage(message.content)) {
      out.push(message)
      continue
    }
    const content = await convertBlocks(message.content, (block) =>
      abortableWait(cachedEvidence(ctx, adapter, block), signal),
    )
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
    if (!decision.messages.some((message) => contentHasImage(message.content))) {
      return decision
    }
    const messages = []
    for (const message of decision.messages) {
      if (!contentHasImage(message.content)) {
        messages.push(message)
        continue
      }
      const content = await convertBlocks(
        message.content,
        async (block) => (await readImageBlock(ctx, block, payload.signal)).block,
      )
      messages.push({ ...message, content })
    }
    return { kind: 'enter', messages }
  })
}

/**
 * Read one image block into an evidence text block. Never throws: failures
 * degrade to an explanatory block with `ok: false`, so callers can decide
 * what a failure means (the pre-step keeps the step going, the cache refuses
 * to memoize it).
 */
async function readImageBlock(ctx, block, signal) {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  let dir
  try {
    // StoredImageAttachment carries { ref, data: Uint8Array }; the media type
    // rides the reference (verified against dsh attachment/src/types.ts).
    const stored = await ctx.attachments.readImage(block.attachment, signal)
    if (!stored?.data) {
      // Named failure instead of Buffer.from(undefined)'s bare TypeError the
      // next time a developer-preview release moves the field (issue #17).
      throw new Error(
        "attachments.readImage returned no 'data' bytes; the dsh attachment shape may have changed",
      )
    }
    const mediaType = stored.ref?.mediaType ?? block.attachment?.mediaType
    const ext = MEDIA_EXT[mediaType]
    if (!ext) {
      // Refusing beats disguising: a fake .png suffix would make the CLI (and
      // the provider behind it) judge mislabelled bytes.
      throw new Error(`unsupported pasted media type ${mediaType ?? '(none declared)'}`)
    }
    dir = await mkdtemp(join(tmpdir(), 'modlens-dsh-'))
    const file = join(dir, `paste${ext}`)
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
      ok: true,
      block: {
        type: 'text',
        text: `[Pasted image, read by the modlens vision bridge]\n${renderEvidence(parsed.result)}`,
      },
    }
  } catch (error) {
    return {
      ok: false,
      block: {
        type: 'text',
        text: `[A pasted image could not be read by modlens: ${
          error instanceof Error ? error.message.slice(0, 300) : String(error)
        }. Tell the user, and suggest running \`npx @liustack/modlens doctor\`.]`,
      },
    }
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function run(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      // In the packaged desktop app process.execPath is the Electron binary;
      // this makes it behave as plain node for the spawned CLI (issue #25).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
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
