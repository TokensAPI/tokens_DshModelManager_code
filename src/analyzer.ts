import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { discoverAuto } from './auto/discover.ts';
import { type AutoRouteOptions, borrowProviders } from './auto/routes.ts';
import { loadConfigFile, type ModlensConfig, resolveProviderSettings } from './config.ts';
import { providerChain } from './providers/availability.ts';
import {
    type ProviderFailureContext,
    type ProviderInvocation,
    type ProviderParsedOutput,
    resolveProvider,
    type VisionProvider,
} from './providers/index.ts';
import { missingSchemaFields } from './schema.ts';

export interface AnalyzeOptions {
    input: string;
    provider?: string;
    model?: string;
    prompt?: string;
    timeoutMs?: number;
    providerBin?: string;
    workdir?: string;
    /** --extra-body: replaces the configured extraBody for this run. */
    extraBody?: Record<string, unknown>;
    config?: ModlensConfig;
    /** Auto-mode discovery overrides (home, env, discovery), mainly for tests. */
    autoOptions?: AutoRouteOptions;
}

export interface AnalyzeAttempt {
    provider: string;
    ok: boolean;
    durationSeconds: number;
    error?: string;
}

export interface AnalyzeResult {
    image: string;
    provider: string;
    result: unknown;
    meta: {
        generatedAt: string;
        model: string;
        conversationId: string | null;
        durationSeconds: number | null;
        usage: unknown | null;
        /** Every provider tried this run, in order, successes and failures. */
        attempts: AnalyzeAttempt[];
        /** Routing notices: failovers and what they mean for the answer. */
        warnings: string[];
    };
}

interface CommandResult {
    stdout: string;
    stderr: string;
}

interface ResolvedInput {
    source: string;
    kind: 'local' | 'remote';
}

const DEFAULT_TIMEOUT_MS = 180_000;
// Give the provider's own timeout a chance to fire first; SIGTERM is the backstop.
const KILL_GRACE_MS = 30_000;
// After the provider exits, how long to keep draining stdout before giving up
// on the pipe closing. Reset whenever more output arrives.
const DRAIN_GRACE_MS = 500;
// How long a killed child gets before SIGKILL.
const SIGKILL_GRACE_MS = 2_000;

export async function analyzeImage(options: AnalyzeOptions): Promise<AnalyzeResult> {
    const resolvedInput = resolveInput(options.input);
    if (resolvedInput.kind === 'local') {
        validateInputFile(resolvedInput.source);
    }

    const config = options.config ?? loadConfigFile();
    // An explicit -p pins exactly one provider with no fallback (like
    // modsearch's -e). The providerBin test double pins the agent the same
    // way. Otherwise the failover chain: every provider that is set up on
    // this machine plus the borrowed routes the user granted, merged by
    // region so a borrowed engine gets speed-class placement, not priority.
    const chain = options.provider
        ? [resolveProvider(options.provider)]
        : options.providerBin
          ? [resolveProvider('antigravity-cli')]
          : composeChain(resolvedInput.kind, config, options.autoOptions);
    if (chain.length === 0) {
        throw new Error(
            'No vision provider is set up on this machine. Install Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash, then run agy once to sign in), or configure a key: modlens config set gemini-api.apiKey <key>. Run modlens doctor for the full picture.' +
                borrowHint(config, options.autoOptions),
        );
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const attempts: AnalyzeAttempt[] = [];
    const warnings: string[] = [];
    let lastError: unknown;

    for (const provider of chain) {
        const startedAt = Date.now();
        // An explicit -m names one provider's model, so it applies to the
        // first attempt only; a failover provider runs its own default, since
        // model names do not carry across providers.
        const model =
            (attempts.length === 0 ? options.model : undefined) ||
            resolveProviderSettings(provider.name, config).model ||
            provider.defaultModel;
        try {
            const parsed = await runProvider(
                provider,
                model,
                options,
                resolvedInput,
                timeoutMs,
                config,
                warnings,
            );
            attempts.push({
                provider: provider.name,
                ok: true,
                durationSeconds: (Date.now() - startedAt) / 1000,
            });
            if (provider.borrowedNote) {
                warnings.push(provider.borrowedNote);
            }
            if (attempts.length > 1) {
                const failed = attempts.slice(0, -1);
                warnings.push(
                    `Failed over to ${provider.name} after: ${failed
                        .map((attempt) => `${attempt.provider} (${attempt.error})`)
                        .join('; ')}.`,
                );
                if (options.model) {
                    warnings.push(
                        `The explicit model applied to ${failed[0].provider} only; ${provider.name} ran its own default.`,
                    );
                }
            }
            return {
                image: resolvedInput.source,
                provider: provider.name,
                result: parsed.result,
                meta: {
                    generatedAt: new Date().toISOString(),
                    model,
                    conversationId: parsed.meta.conversationId,
                    durationSeconds: parsed.meta.durationSeconds,
                    usage: parsed.meta.usage,
                    attempts,
                    warnings,
                },
            };
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            attempts.push({
                provider: provider.name,
                ok: false,
                durationSeconds: (Date.now() - startedAt) / 1000,
                error: message.slice(0, 300),
            });
        }
    }

    // A pinned or lone provider keeps its original, actionable error (agy's
    // sign-in guidance, a provider's own fix text). Only a real multi-provider
    // exhaustion gets the aggregate.
    if (chain.length === 1) {
        throw lastError;
    }
    throw new Error(
        `Every configured vision provider failed for this image. ${attempts
            .map((attempt) => `${attempt.provider}: ${attempt.error}`)
            .join(' | ')}${borrowHint(config, options.autoOptions)}`,
    );
}

const INLINE_REGION = new Set(['gemini-api', 'openai', 'anthropic']);

/**
 * Merge granted borrowed routes into the base chain by region: borrowed keys
 * join the inline region after the user's own, borrowed agents slot in before
 * claude-cli (which spends the Claude subscription and stays last). The base
 * order is preserved, so a `config set provider` preference keeps its place.
 */
function composeChain(
    kind: 'local' | 'remote',
    config: ModlensConfig,
    autoOptions: AutoRouteOptions | undefined,
): VisionProvider[] {
    const chain = [...providerChain(kind, config)];
    const borrowed = borrowProviders(kind, config, autoOptions);
    if (borrowed.inline.length > 0) {
        const lastInline = chain.map((p) => INLINE_REGION.has(p.name)).lastIndexOf(true);
        chain.splice(lastInline + 1, 0, ...borrowed.inline);
    }
    if (borrowed.agents.length > 0) {
        const claudeIndex = chain.findIndex((p) => p.name === 'claude-cli');
        chain.splice(claudeIndex === -1 ? chain.length : claudeIndex, 0, ...borrowed.agents);
    }
    return chain;
}

const BORROW_KEY_BY_HARNESS: Record<string, 'codex' | 'opencode' | 'pi'> = {
    codex: 'codex',
    opencode: 'opencode',
    pi: 'pi',
};

/**
 * When everything failed (or nothing was set up), say so if this machine has
 * borrowable vision the user was never asked about. A hint only: nothing is
 * enabled without an explicit grant.
 */
function borrowHint(config: ModlensConfig, autoOptions: AutoRouteOptions | undefined): string {
    try {
        const grants = config.borrow ?? {};
        const discovery =
            autoOptions?.discovery ??
            discoverAuto({ env: autoOptions?.env, home: autoOptions?.home });
        const unasked = discovery.probes.filter((probe) => {
            const key = BORROW_KEY_BY_HARNESS[probe.harness];
            return (
                key !== undefined &&
                probe.cliFound &&
                probe.visionModels.length > 0 &&
                grants[key] === undefined
            );
        });
        if (unasked.length === 0) {
            return '';
        }
        const names = unasked.map((probe) => probe.harness).join(', ');
        return ` Hint: this machine has vision reachable through ${names}, which modlens is not yet allowed to borrow. Ask the user, then: modlens config set borrow.<harness> true.`;
    } catch {
        return '';
    }
}

/** One provider, one attempt: execute (or spawn), parse, and verify the shape. */
async function runProvider(
    provider: VisionProvider,
    model: string,
    options: AnalyzeOptions,
    resolvedInput: ResolvedInput,
    timeoutMs: number,
    config: ModlensConfig,
    warnings: string[],
): Promise<ProviderParsedOutput> {
    const configured = resolveProviderSettings(provider.name, config);
    // --extra-body replaces the configured object rather than merging into it:
    // a partial override of vendor knobs is hard to reason about at the command
    // line, and the flag is the more specific layer.
    const settings = options.extraBody
        ? { ...configured, extraBody: options.extraBody }
        : configured;
    // The passthrough is a request-body field, so the two CLI agents have
    // nowhere to put it. Saying so beats letting the user believe thinking is
    // off when nothing was sent.
    if (settings.extraBody && !provider.execute) {
        warnings.push(
            `${provider.name} is a CLI provider and takes no request body, so extraBody was ignored for this run.`,
        );
    }
    const providerOptions = {
        imageSource: resolvedInput.source,
        imageKind: resolvedInput.kind,
        model,
        extraPrompt: options.prompt,
        providerBin: options.providerBin,
        workdir: options.workdir,
        timeoutMs,
        settings,
    };

    let parsed: ProviderParsedOutput;
    if (provider.execute) {
        parsed = await provider.execute(providerOptions);
    } else if (provider.buildInvocation && provider.parseOutput) {
        const buildInvocation = provider.buildInvocation;
        const parseOutput = provider.parseOutput;
        // Run the agent in a throwaway directory holding only this one image, so
        // an injection in the image cannot steer it into siblings of the
        // original file. A remote image has no local file to copy, but the agent
        // still must not run in the caller's directory, so it gets an empty
        // throwaway cwd instead. An explicit --workdir opts out.
        const isolation =
            !options.workdir && provider.isolateWorkdir
                ? resolvedInput.kind === 'local'
                    ? isolateImage(resolvedInput.source)
                    : emptyWorkdir()
                : null;
        try {
            const invocation = buildInvocation({
                ...providerOptions,
                imageSource: isolation?.imageSource ?? providerOptions.imageSource,
                workdir: isolation?.workdir ?? providerOptions.workdir,
            });
            // The grace exists for engines with their own internal deadline (agy
            // gets --print-timeout). Engines without one must honour the caller's
            // number as given.
            const backstop = provider.hasInternalTimeout ? timeoutMs + KILL_GRACE_MS : timeoutMs;
            const commandResult = await runCommand(
                provider.name,
                invocation,
                backstop,
                provider.describeFailure,
            );
            parsed = parseOutput(commandResult.stdout);
        } finally {
            // Output goes over stdout, so nothing here needs to outlive the run.
            isolation?.cleanup();
        }
    } else {
        throw new Error(
            `Provider ${provider.name} implements neither execute nor buildInvocation.`,
        );
    }

    // Server-side schema enforcement is uneven across providers, and even the
    // routes that have it can return a shell that only looks right. Verify the
    // shape here so a structurally broken result fails loudly for every
    // provider, and a failover peer gets its turn at a compliant answer.
    const missing = missingSchemaFields(parsed.result);
    if (missing.length > 0) {
        throw new Error(
            `${provider.name} returned a result that does not match the vision schema (missing: ${missing.join(', ')}).`,
        );
    }

    return parsed;
}

export function resolveInput(input: string): ResolvedInput {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error('Input path is required.');
    }

    if (isRemoteSource(trimmed)) {
        return { source: trimmed, kind: 'remote' };
    }

    if (/^file:\/\//i.test(trimmed)) {
        return { source: path.resolve(fileURLToPath(trimmed)), kind: 'local' };
    }

    return { source: path.resolve(trimmed), kind: 'local' };
}

function isRemoteSource(value: string): boolean {
    return /^https?:\/\//i.test(value.trim());
}

function validateInputFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Input image not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Input is not a file: ${filePath}`);
    }
}

interface IsolatedImage {
    imageSource?: string;
    workdir: string;
    cleanup: () => void;
}

/**
 * Place the input image, and nothing else, into a fresh temp directory the agent
 * runs in. Subprocess providers are handed a path and broad permissions, so text
 * inside the image could otherwise point them at neighbouring files; a directory
 * of one removes that reach.
 */
function isolateImage(source: string): IsolatedImage {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-work-'));
    const imageSource = path.join(workdir, path.basename(source));
    // Always a real copy, never a hardlink: a hardlink shares the inode, so a
    // provider writing to its temp path would mutate the user's original file.
    fs.copyFileSync(source, imageSource);
    fs.chmodSync(imageSource, 0o600);
    return {
        imageSource,
        workdir,
        cleanup: () => fs.rmSync(workdir, { recursive: true, force: true }),
    };
}

/**
 * An empty throwaway cwd for a remote image: there is no local file to copy,
 * but the agent still must not run in the caller's directory, where an
 * injection in the image could read whatever project the user happens to be in.
 */
function emptyWorkdir(): IsolatedImage {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-work-'));
    return {
        workdir,
        cleanup: () => fs.rmSync(workdir, { recursive: true, force: true }),
    };
}

/** Exported for tests: the timeout path is otherwise behind a 30s backstop. */
export function runCommand(
    providerName: string,
    invocation: ProviderInvocation,
    timeoutMs: number,
    describeFailure?: (context: ProviderFailureContext) => string | null,
): Promise<CommandResult> {
    const runStartedAt = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
            cwd: invocation.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Decoders keep state across chunks: a multi-byte character split down the
        // middle used to come out as replacement characters.
        const outDecoder = new TextDecoder('utf-8');
        const errDecoder = new TextDecoder('utf-8');
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let drainTimer: NodeJS.Timeout | undefined;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // A child that ignores SIGTERM used to keep the caller waiting for
            // as long as it liked, so report the timeout now and make sure it
            // dies.
            settle(null);
            setTimeout(() => {
                // child.killed only means a signal was delivered, not that the
                // process left, so a child ignoring SIGTERM read as "killed" and
                // never got SIGKILL. Escalate on "has not exited yet" instead.
                if (!exited) {
                    child.kill('SIGKILL');
                }
            }, SIGKILL_GRACE_MS).unref();
        }, timeoutMs);

        // 'close' waits for every stdio pipe to close, but agy leaves a
        // language server running that inherited the pipe, so its write end
        // never closes and 'close' never fires (issue #1). Settle on 'exit'
        // plus a drain window instead, and drop the pipes afterwards so the
        // lingering descendant cannot keep this process alive either.
        const settle = (code: number | null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            clearTimeout(drainTimer);
            // Flush the decoders: trailing bytes of a split character were dropped.
            stdout += outDecoder.decode();
            stderr += errDecoder.decode();
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();

            if (timedOut) {
                reject(new Error(`${providerName} provider timed out after ${timeoutMs} ms.`));
                return;
            }
            if (code !== 0) {
                // The provider knows what its own error output means; a bare
                // exit code tells the user nothing actionable (issue #3).
                const explained =
                    describeFailure?.({ stdout, stderr, code, startedAt: runStartedAt }) ?? null;
                reject(
                    new Error(
                        explained ??
                            `${providerName} provider failed with code ${code}.${stderr ? ` stderr: ${stderr.trim()}` : ''}`,
                    ),
                );
                return;
            }
            resolve({ stdout, stderr });
        };

        let exitCode: number | null = null;
        let exited = false;
        const restartDrain = () => {
            if (!exited || settled) {
                return;
            }
            clearTimeout(drainTimer);
            drainTimer = setTimeout(() => settle(exitCode), DRAIN_GRACE_MS);
        };

        child.stdout.on('data', (chunk: Buffer) => {
            stdout += outDecoder.decode(chunk, { stream: true });
            restartDrain();
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderr += errDecoder.decode(chunk, { stream: true });
            restartDrain();
        });

        child.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            clearTimeout(drainTimer);
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                // spawn reports ENOENT for a missing cwd too, and naming the
                // wrong cause sent people installing software they already had.
                const missingCwd = !fs.existsSync(invocation.cwd);
                reject(
                    new Error(
                        missingCwd
                            ? `Working directory does not exist: ${invocation.cwd}`
                            : `Provider CLI not found: ${invocation.command}. Install it and sign in first.`,
                    ),
                );
                return;
            }
            reject(error);
        });

        child.on('exit', (code) => {
            exitCode = code;
            exited = true;
            restartDrain();
        });

        // Normal providers close their pipes right after exiting: settle at once.
        child.on('close', (code) => settle(code));
    });
}
