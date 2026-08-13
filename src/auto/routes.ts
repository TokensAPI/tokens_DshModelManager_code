// Auto-mode routes (spec: .issues/2026-08-13-auto-mode, steps 2-4): turn what
// discovery found into providers the failover chain can actually run. Two
// families, ordered fast-first when the chain assembles them:
//
// - borrowed-inline: pi's stored credentials plus its models-store recipe
//   (baseUrl, api shape, modality) feed the existing inline API providers, so
//   the SSRF guards, image checks, and schema enforcement all stay in force.
// - borrowed-agent: codex and opencode both take a local image attachment in
//   their non-interactive modes (codex exec -i, opencode run -f), the same
//   pattern claude-cli established.
//
// Every route carries a borrowedNote so the analyzer can say whose quota a
// read spent; credentials are fetched at call time and live only in memory.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildVisionPrompt, JSON_TEMPLATE_INSTRUCTION } from '../prompt.ts';
import { anthropicApiProvider } from '../providers/anthropicApi.ts';
import { findOnPath } from '../providers/availability.ts';
import { geminiApiProvider } from '../providers/geminiApi.ts';
import type {
    BuildProviderInvocationOptions,
    ProviderParsedOutput,
    VisionProvider,
} from '../providers/index.ts';
import { openaiCompatProvider } from '../providers/openaiCompat.ts';
import { extractJson, truncate, tryParseJson } from '../util/json.ts';
import { type AutoDiscovery, discoverAuto } from './discover.ts';

const KEY_FETCH_TIMEOUT_MS = 10_000;

/** `codex exec` with the image attached and the schema enforced via file. */
export function codexCliRoute(visionModel: string): VisionProvider {
    return {
        name: 'codex-cli',
        defaultModel: visionModel,
        isolateWorkdir: true,
        borrowedNote:
            "auto mode borrowed the local Codex CLI login for this read; it spent that account's quota.",
        buildInvocation: (options: BuildProviderInvocationOptions) => {
            if (options.imageKind === 'remote') {
                throw new Error(
                    'codex-cli route reads local files only. Remote URLs stay on the inline providers.',
                );
            }
            // No --output-schema: codex routes it into OpenAI strict
            // structured output, which rejects this schema (it requires
            // additionalProperties: false on every object). The filled-in
            // template asks for the shape instead, and the analyzer's schema
            // check verifies what came back.
            const prompt = `${buildVisionPrompt({
                imageSource: options.imageSource,
                imageKind: 'inline',
                extraPrompt: options.extraPrompt,
            })}\n\n${JSON_TEMPLATE_INSTRUCTION}`;
            const model = options.model || visionModel;
            const args = [
                'exec',
                '--skip-git-repo-check',
                '--ephemeral',
                '-s',
                'read-only',
                '--json',
                '-i',
                options.imageSource,
            ];
            // 'default' is the probe's marker for a stock install: no -m lets
            // codex run its own (vision-capable) default model.
            if (model && model !== 'default') {
                args.push('-m', model);
            }
            // -- fences the positional prompt off from the variadic -i, which
            // otherwise swallows it as a second image file.
            args.push('--', prompt);
            return {
                command: options.providerBin || 'codex',
                args,
                cwd: path.resolve(options.workdir || path.dirname(options.imageSource)),
            };
        },
        parseOutput: (stdout: string): ProviderParsedOutput => {
            let threadId: string | null = null;
            let usage: unknown = null;
            let lastMessage: string | null = null;
            for (const line of stdout.split('\n')) {
                const event = tryParseJson(line.trim()) as {
                    type?: string;
                    thread_id?: string;
                    usage?: unknown;
                    item?: { type?: string; text?: string };
                } | null;
                if (!event) {
                    continue;
                }
                if (event.type === 'thread.started' && event.thread_id) {
                    threadId = event.thread_id;
                }
                if (event.type === 'turn.completed' && event.usage !== undefined) {
                    usage = event.usage;
                }
                if (
                    event.type === 'item.completed' &&
                    event.item?.type === 'agent_message' &&
                    typeof event.item.text === 'string'
                ) {
                    lastMessage = event.item.text;
                }
            }
            if (!lastMessage) {
                throw new Error(
                    'codex exec produced no agent message. Check the Codex login (run: codex).',
                );
            }
            const result = extractJson(lastMessage);
            if (result === null) {
                throw new Error(`codex returned a non-JSON answer: ${truncate(lastMessage)}`);
            }
            return {
                result,
                meta: { conversationId: threadId, durationSeconds: null, usage },
            };
        },
    };
}

/** `opencode run` with the image attached; JSON asked for in the prompt. */
export function opencodeCliRoute(modelId: string): VisionProvider {
    return {
        name: 'opencode-cli',
        defaultModel: modelId,
        isolateWorkdir: true,
        borrowedNote: `auto mode borrowed OpenCode's ${modelId} for this read; it spent that account's quota.`,
        buildInvocation: (options: BuildProviderInvocationOptions) => {
            if (options.imageKind === 'remote') {
                throw new Error(
                    'opencode-cli route reads local files only. Remote URLs stay on the inline providers.',
                );
            }
            const prompt = `${buildVisionPrompt({
                imageSource: options.imageSource,
                imageKind: 'inline',
                extraPrompt: options.extraPrompt,
            })}\n\n${JSON_TEMPLATE_INSTRUCTION}`;
            // The message must precede -f: yargs reads -f as an array and
            // would swallow a trailing positional as another file.
            return {
                command: options.providerBin || 'opencode',
                args: [
                    'run',
                    prompt,
                    '-m',
                    options.model || modelId,
                    '--format',
                    'json',
                    '-f',
                    options.imageSource,
                ],
                cwd: path.resolve(options.workdir || path.dirname(options.imageSource)),
            };
        },
        parseOutput: (stdout: string): ProviderParsedOutput => {
            let sessionId: string | null = null;
            let usage: unknown = null;
            const texts: string[] = [];
            for (const line of stdout.split('\n')) {
                const event = tryParseJson(line.trim()) as {
                    type?: string;
                    sessionID?: string;
                    part?: { type?: string; text?: string; tokens?: unknown };
                } | null;
                if (!event) {
                    continue;
                }
                sessionId ??= event.sessionID ?? null;
                if (event.type === 'text' && typeof event.part?.text === 'string') {
                    texts.push(event.part.text);
                }
                if (event.type === 'step_finish' && event.part?.tokens !== undefined) {
                    usage = event.part.tokens;
                }
            }
            const answer = texts.join('').trim();
            if (!answer) {
                throw new Error('opencode run produced no text answer.');
            }
            const result = extractJson(answer);
            if (result === null) {
                throw new Error(`opencode returned a non-JSON answer: ${truncate(answer)}`);
            }
            return {
                result,
                meta: { conversationId: sessionId, durationSeconds: null, usage },
            };
        },
    };
}

/** Which inline provider serves each api shape in pi's models-store. */
const PI_API_TARGETS: Record<string, string> = {
    openai: 'openai',
    anthropic: 'anthropic',
    google: 'gemini-api',
};

const DEFAULT_TARGETS: Record<string, VisionProvider> = {
    openai: openaiCompatProvider,
    anthropic: anthropicApiProvider,
    'gemini-api': geminiApiProvider,
};

interface PiStoredModel {
    id?: string;
    provider?: string;
    api?: string;
    baseUrl?: string;
    input?: string[];
}

/**
 * Vision models pi holds credentials for, wrapped over the matching inline
 * provider. The store carries the whole recipe (baseUrl, api shape, modality);
 * the key is printed by `pi auth print-api-key` at call time and never stored.
 */
export function piBorrowedRoutes(
    home: string,
    env: NodeJS.ProcessEnv,
    targets: Record<string, VisionProvider> = DEFAULT_TARGETS,
): VisionProvider[] {
    const piPath = findOnPath('pi', env);
    if (!piPath) {
        return [];
    }
    const agentDir = path.join(home, '.pi', 'agent');
    let auth: Record<string, unknown>;
    let store: Record<string, { models?: PiStoredModel[] }>;
    try {
        auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf-8'));
        store = JSON.parse(fs.readFileSync(path.join(agentDir, 'models-store.json'), 'utf-8'));
    } catch {
        return [];
    }
    const routes: VisionProvider[] = [];
    const usedTargets = new Set<string>();
    for (const entry of Object.values(store)) {
        for (const model of entry?.models ?? []) {
            if (
                !model.id ||
                !model.provider ||
                !model.baseUrl ||
                !(model.input ?? []).includes('image') ||
                !(model.provider in auth)
            ) {
                continue;
            }
            const targetName = PI_API_TARGETS[(model.api ?? '').split('-')[0]];
            const target = targetName ? targets[targetName] : undefined;
            const targetExecute = target?.execute;
            if (!target || !targetExecute || usedTargets.has(target.name)) {
                continue;
            }
            usedTargets.add(target.name);
            const { id, provider, baseUrl } = model as Required<
                Pick<PiStoredModel, 'id' | 'provider' | 'baseUrl'>
            >;
            routes.push({
                name: `pi:${target.name}`,
                defaultModel: id,
                borrowedNote: `auto mode borrowed pi's ${provider} credentials for ${id}; this read spent that account's quota.`,
                execute: async (options) => {
                    const apiKey = fetchPiKey(piPath, id, provider);
                    return targetExecute({
                        ...options,
                        settings: {
                            ...(options.settings ?? {}),
                            apiKey,
                            baseUrl,
                            model: options.model || id,
                        },
                    });
                },
            });
        }
    }
    // Two borrowed keys are plenty; an unbounded list would bloat every chain.
    return routes.slice(0, 2);
}

function fetchPiKey(piPath: string, modelId: string, provider: string): string {
    try {
        const key = execFileSync(
            piPath,
            ['auth', 'print-api-key', '--model', modelId, '--provider', provider],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: KEY_FETCH_TIMEOUT_MS },
        ).trim();
        if (!key) {
            throw new Error('pi printed an empty credential');
        }
        return key;
    } catch (error) {
        // Never let the key (or a partial one) travel inside an error message.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `pi could not print a credential for ${provider}/${modelId}: ${truncate(message.replace(/sk-[\w-]+/g, 'sk-***'), 200)}`,
        );
    }
}

export interface AutoRouteOptions {
    env?: NodeJS.ProcessEnv;
    home?: string;
    /** Injectable discovery result; defaults to the cached discoverAuto. */
    discovery?: AutoDiscovery;
    /** Injectable inline targets for tests. */
    targets?: Record<string, VisionProvider>;
}

/**
 * The auto region of the failover chain, fast-first: borrowed-inline routes,
 * then borrowed agents (local images only; agents attach local files, and
 * remote URLs must stay behind the inline path's download guards). claude-cli
 * is not built here: it is already a first-class provider in the base chain.
 */
export function autoProviders(
    kind: 'local' | 'remote',
    options: AutoRouteOptions = {},
): VisionProvider[] {
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const routes: VisionProvider[] = [];
    try {
        routes.push(...piBorrowedRoutes(home, env, options.targets));
    } catch {
        // A broken pi store must not take the whole chain down.
    }
    if (kind === 'local') {
        try {
            const discovery = options.discovery ?? discoverAuto({ env, home });
            const codex = discovery.probes.find((probe) => probe.harness === 'codex');
            if (codex?.cliFound && codex.loggedIn !== false && codex.visionModels[0]) {
                routes.push(codexCliRoute(codex.visionModels[0]));
            }
            const opencode = discovery.probes.find((probe) => probe.harness === 'opencode');
            if (opencode?.cliFound && opencode.visionModels[0]) {
                routes.push(opencodeCliRoute(opencode.visionModels[0]));
            }
        } catch {
            // Discovery trouble degrades to the base chain, never to a crash.
        }
    }
    return routes;
}
