import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { BuildProviderInvocationOptions, VisionProvider } from '../providers/index.ts';
import type { AutoDiscovery } from './discover.ts';
import { codexCliRoute, opencodeCliRoute, piCliRoute, piRoutes, reuseProviders } from './routes.ts';

function pathWith(bins: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-routes-bin-'));
    for (const [bin, script] of Object.entries(bins)) {
        fs.writeFileSync(path.join(dir, bin), script, { mode: 0o755 });
    }
    return dir;
}

const BUILD_BASE: BuildProviderInvocationOptions = {
    imageSource: '/tmp/shot.png',
    imageKind: 'local',
    timeoutMs: 60_000,
    workdir: '/tmp/work',
};

describe('codexCliRoute', () => {
    it('builds a codex exec invocation with image, json events, and the template prompt', () => {
        const route = codexCliRoute('gpt-5.6-sol');
        const invocation = route.buildInvocation?.(BUILD_BASE);
        expect(invocation?.command).toBe('codex');
        const args = invocation?.args ?? [];
        expect(args[0]).toBe('exec');
        expect(args).toContain('--json');
        // No --output-schema: codex routes it into OpenAI strict structured
        // output, which rejects our schema (additionalProperties must be
        // false everywhere). The prompt template carries the shape instead,
        // and the analyzer's schema check verifies the result (seen live).
        expect(args).not.toContain('--output-schema');
        expect(args).toContain('-i');
        expect(args[args.indexOf('-i') + 1]).toBe('/tmp/shot.png');
        expect(args).toContain('-m');
        expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
        // The prompt is the positional tail, fenced off by -- so the variadic
        // -i <FILE>... cannot swallow it as a second image (seen live), and it
        // carries the JSON template.
        expect(args[args.indexOf('--') + 1]).toBe(args[args.length - 1]);
        expect(args[args.length - 1]).toContain('attached');
        expect(args[args.length - 1]).toContain('"ocr"');
        expect(invocation?.cwd).toBe('/tmp/work');
    });

    it('omits -m for the official default model and refuses remote URLs', () => {
        const route = codexCliRoute('default');
        const args = route.buildInvocation?.(BUILD_BASE).args ?? [];
        expect(args).not.toContain('-m');
        expect(() =>
            route.buildInvocation?.({
                ...BUILD_BASE,
                imageKind: 'remote',
                imageSource: 'https://x/y.png',
            }),
        ).toThrow(/local files only/);
    });

    it('parses the codex event stream: last agent_message wins, usage and thread id kept', () => {
        const route = codexCliRoute('default');
        const payload = { summary: 'ok' };
        const stdout = [
            JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
            JSON.stringify({ type: 'turn.started' }),
            JSON.stringify({
                type: 'item.completed',
                item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(payload) },
            }),
            JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5 } }),
        ].join('\n');
        const parsed = route.parseOutput?.(stdout);
        expect(parsed?.result).toEqual(payload);
        expect(parsed?.meta.conversationId).toBe('t-1');
        expect(parsed?.meta.usage).toEqual({ input_tokens: 5 });
    });

    it('throws a clear error when no agent message arrived', () => {
        const route = codexCliRoute('default');
        expect(() => route.parseOutput?.('{"type":"turn.started"}')).toThrow(/no agent message/i);
    });
});

describe('opencodeCliRoute', () => {
    it('builds an opencode run invocation: prompt first, then model, format, file', () => {
        const route = opencodeCliRoute('opencode/gemini-3-flash');
        const invocation = route.buildInvocation?.(BUILD_BASE);
        expect(invocation?.command).toBe('opencode');
        const args = invocation?.args ?? [];
        expect(args[0]).toBe('run');
        // The message is positional and must precede -f, whose array greed
        // would otherwise swallow it.
        expect(args[1]).toContain('attached');
        expect(args[1]).toContain('"ocr"');
        expect(args.indexOf('-f')).toBeGreaterThan(1);
        expect(args[args.indexOf('-f') + 1]).toBe('/tmp/shot.png');
        expect(args[args.indexOf('-m') + 1]).toBe('opencode/gemini-3-flash');
        expect(args[args.indexOf('--format') + 1]).toBe('json');
    });

    it('parses the opencode event stream into text, session id, and tokens', () => {
        const route = opencodeCliRoute('opencode/gemini-3-flash');
        const payload = { summary: 'seen' };
        const stdout = [
            JSON.stringify({ type: 'step_start', sessionID: 's-1', part: { type: 'step-start' } }),
            JSON.stringify({
                type: 'text',
                sessionID: 's-1',
                part: { type: 'text', text: JSON.stringify(payload) },
            }),
            JSON.stringify({
                type: 'step_finish',
                sessionID: 's-1',
                part: { type: 'step-finish', tokens: { total: 9 } },
            }),
        ].join('\n');
        const parsed = route.parseOutput?.(stdout);
        expect(parsed?.result).toEqual(payload);
        expect(parsed?.meta.conversationId).toBe('s-1');
        expect(parsed?.meta.usage).toEqual({ total: 9 });
    });
});

describe('piReusedRoutes', () => {
    function piHome(): string {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-routes-home-'));
        fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
        fs.writeFileSync(
            path.join(home, '.pi', 'agent', 'models-store.json'),
            JSON.stringify({
                openai: {
                    models: [
                        {
                            id: 'gpt-5.6-sol',
                            provider: 'openai',
                            api: 'openai-completions',
                            baseUrl: 'https://api.example.com/v1',
                            input: ['text', 'image'],
                        },
                        {
                            id: 'text-only',
                            provider: 'openai',
                            api: 'openai-completions',
                            baseUrl: 'https://api.example.com/v1',
                            input: ['text'],
                        },
                    ],
                },
            }),
        );
        fs.writeFileSync(
            path.join(home, '.pi', 'agent', 'auth.json'),
            JSON.stringify({ openai: { type: 'api_key' } }),
        );
        return home;
    }

    it('wraps a credentialed vision model over the matching inline provider', async () => {
        const home = piHome();
        const env = { PATH: pathWith({ pi: '#!/bin/sh\necho sk-borrowed-key\n' }) };
        const seen: BuildProviderInvocationOptions[] = [];
        const fakeTarget: VisionProvider = {
            name: 'openai',
            defaultModel: 'x',
            execute: async (options) => {
                seen.push(options);
                return {
                    result: { summary: 'done' },
                    meta: { conversationId: null, durationSeconds: null, usage: null },
                };
            },
        };
        const { inline: routes } = piRoutes(home, env, { openai: fakeTarget });
        expect(routes).toHaveLength(1);
        expect(routes[0].name).toBe('pi:openai');
        expect(routes[0].defaultModel).toBe('gpt-5.6-sol');
        expect(routes[0].reuseNote).toContain('pi');

        await routes[0].execute?.(BUILD_BASE);
        expect(seen[0].settings).toMatchObject({
            apiKey: 'sk-borrowed-key',
            baseUrl: 'https://api.example.com/v1',
            model: 'gpt-5.6-sol',
        });
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('returns no routes without credentials, a store, or a pi binary', () => {
        const home = piHome();
        // No pi on PATH: the key could never be fetched.
        expect(piRoutes(home, { PATH: '' })).toEqual({ inline: [], agents: [] });
        fs.rmSync(home, { recursive: true, force: true });
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-routes-home-'));
        expect(piRoutes(empty, { PATH: pathWith({ pi: '#!/bin/sh\necho k\n' }) })).toEqual({
            inline: [],
            agents: [],
        });
        fs.rmSync(empty, { recursive: true, force: true });
    });
});

describe('piCliRoute', () => {
    it('builds a non-interactive pi invocation with the @file attachment', () => {
        const route = piCliRoute('bespoke', 'vision-x');
        const invocation = route.buildInvocation?.(BUILD_BASE);
        expect(invocation?.command).toBe('pi');
        const args = invocation?.args ?? [];
        expect(args).toContain('-p');
        expect(args).toContain('--no-session');
        expect(args).toContain('--no-tools');
        expect(args[args.indexOf('--provider') + 1]).toBe('bespoke');
        expect(args[args.indexOf('--model') + 1]).toBe('vision-x');
        expect(args).toContain('@/tmp/shot.png');
        expect(args[args.length - 1]).toContain('"ocr"');
    });

    it('parses the pi event stream from the message_end event', () => {
        const route = piCliRoute('bespoke', 'vision-x');
        const payload = { summary: 'seen' };
        const stdout = [
            JSON.stringify({ type: 'message_update', message: { content: [] } }),
            JSON.stringify({
                type: 'message_end',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'hm' },
                        { type: 'text', text: JSON.stringify(payload) },
                    ],
                    usage: { totalTokens: 9 },
                    responseId: 'r-1',
                },
            }),
        ].join('\n');
        const parsed = route.parseOutput?.(stdout);
        expect(parsed?.result).toEqual(payload);
        expect(parsed?.meta.conversationId).toBe('r-1');
        expect(parsed?.meta.usage).toEqual({ totalTokens: 9 });
    });

    it('falls back to a pi-cli agent route for unmappable credentials', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-routes-home-'));
        fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
        fs.writeFileSync(
            path.join(home, '.pi', 'agent', 'models-store.json'),
            JSON.stringify({
                bespoke: {
                    models: [
                        {
                            id: 'vision-x',
                            provider: 'bespoke',
                            api: 'bespoke-rpc',
                            baseUrl: 'https://b.example.com',
                            input: ['text', 'image'],
                        },
                    ],
                },
            }),
        );
        fs.writeFileSync(
            path.join(home, '.pi', 'agent', 'auth.json'),
            JSON.stringify({ bespoke: { type: 'oauth' } }),
        );
        const env = { PATH: pathWith({ pi: '#!/bin/sh\necho k\n' }) };
        const routes = piRoutes(home, env);
        expect(routes.inline).toEqual([]);
        expect(routes.agents.map((r) => r.name)).toEqual(['pi-cli']);
        expect(routes.agents[0].defaultModel).toBe('vision-x');
        fs.rmSync(home, { recursive: true, force: true });
    });
});

describe('reuseProviders', () => {
    const discovery: AutoDiscovery = {
        cachedAt: new Date().toISOString(),
        fromCache: false,
        probes: [
            {
                harness: 'claude-code',
                cliFound: true,
                visionModels: ['anthropic/*'],
                source: 'builtin-table',
                elapsedMs: 0,
            },
            {
                harness: 'codex',
                cliFound: true,
                loggedIn: true,
                visionModels: ['default'],
                source: 'builtin-table',
                elapsedMs: 0,
            },
            {
                harness: 'opencode',
                cliFound: true,
                visionModels: ['opencode/gemini-3-flash'],
                source: 'builtin-table',
                elapsedMs: 0,
            },
            { harness: 'pi', cliFound: false, visionModels: [], source: 'none', elapsedMs: 0 },
        ],
    };

    it('builds routes only for granted harnesses, region-ordered', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-routes-home-'));
        const routes = reuseProviders(
            'local',
            { reuse: { codex: true, opencode: true } },
            { env: { PATH: '' }, home, discovery },
        );
        expect(routes.inline).toEqual([]);
        expect(routes.agents.map((r) => r.name)).toEqual(['codex-cli', 'opencode-cli']);
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('builds nothing without grants, even when discovery is full', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-routes-home-'));
        for (const config of [{}, { reuse: { codex: false, opencode: false } }]) {
            const routes = reuseProviders('local', config, { env: { PATH: '' }, home, discovery });
            expect(routes).toEqual({ inline: [], agents: [] });
        }
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('keeps agents out of the remote kind entirely', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-routes-home-'));
        const routes = reuseProviders(
            'remote',
            { reuse: { codex: true, opencode: true, pi: true } },
            { env: { PATH: '' }, home, discovery },
        );
        expect(routes.agents).toEqual([]);
        fs.rmSync(home, { recursive: true, force: true });
    });
});
