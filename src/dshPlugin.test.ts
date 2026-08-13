import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { VISION_RESULT_SCHEMA } from './schema.ts';

describe('dsh plugin bundle', () => {
    it('ships a vision schema identical to the source of truth', () => {
        // dsh/index.js cannot import the TS source, so it carries a JSON copy;
        // this is the lockstep check that keeps the copy honest.
        const shipped = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'dsh', 'vision-schema.json'), 'utf-8'),
        );
        expect(shipped).toEqual(VISION_RESULT_SCHEMA);
    });

    it('wires the bundle manifest to the patch and the patch to the subpath', () => {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
        ) as {
            dsh?: { bundle?: { patch?: string } };
            exports?: Record<string, string>;
            files?: string[];
        };
        expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
        expect(pkg.exports?.['.']).toBe('./dsh/index.js');
        expect(pkg.exports?.['./dsh']).toBe('./dsh/index.js');
        expect(pkg.files).toContain('dsh');
        expect(pkg.files).toContain('cordis.patch.yml');
        const patch = fs.readFileSync(path.join(__dirname, '..', 'cordis.patch.yml'), 'utf-8');
        expect(patch).toContain("name: '@liustack/modlens'");
    });
});

describe('dsh plugin auto-read (phase 2)', () => {
    type Handler = (
        payload: { messages: unknown[]; signal?: AbortSignal },
        next: () => Promise<unknown>,
    ) => Promise<{
        kind: string;
        messages?: Array<{ content: Array<{ type: string; text?: string }> }>;
    }>;

    async function load(autoRead: boolean | undefined = true) {
        // The plugin is plain JS by design (no build step, no dsh type deps).
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: { autoRead?: boolean }) => void;
        };
        const handlers: Record<string, Handler> = {};
        const ctx = {
            tools: { register: () => {} },
            attachments: {
                readImage: async () => ({
                    data: new Uint8Array([1, 2, 3]),
                    ref: { mediaType: 'image/png' },
                }),
            },
            on: (event: string, fn: Handler) => {
                handlers[event] = fn;
            },
        };
        plugin.apply(ctx as never, autoRead === undefined ? {} : { autoRead });
        return handlers;
    }

    function fakeCli(body: string): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-cli-'));
        const file = path.join(dir, 'cli.js');
        fs.writeFileSync(file, body);
        return file;
    }

    const imageMessage = () => ({
        role: 'user',
        content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', attachment: { id: 'a1', mediaType: 'image/png' } },
        ],
    });

    it('rewrites image blocks into modlens evidence text after next()', async () => {
        const handlers = await load();
        const cli = fakeCli(
            `console.log(JSON.stringify({ result: { summary: 'S', ocr: { full_text: 'HELLO-EVIDENCE' }, uncertainty: [] } }))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const messages = [imageMessage()];
            const decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(decision.kind).toBe('enter');
            const blocks = decision.messages?.[0].content ?? [];
            expect(blocks[0]).toEqual({ type: 'text', text: 'what is this' });
            expect(blocks[1].type).toBe('text');
            expect(blocks[1].text).toContain('HELLO-EVIDENCE');
            expect(blocks[1].text).toContain('Pasted image');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('degrades a failed read to an explanatory block instead of rejecting the step', async () => {
        const handlers = await load();
        const cli = fakeCli(`console.error('engine down'); process.exit(1)`);
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const messages = [imageMessage()];
            const decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(decision.kind).toBe('enter');
            const block = decision.messages?.[0].content[1];
            expect(block?.text).toContain('could not be read');
            expect(block?.text).toContain('engine down');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('passes through image-free steps, reject decisions, and autoRead: false', async () => {
        const handlers = await load();
        const plain = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
        const enter = await handlers['agent/pre-step']({ messages: plain }, async () => ({
            kind: 'enter',
            messages: plain,
        }));
        expect(enter.messages).toBe(plain);
        const reject = await handlers['agent/pre-step'](
            { messages: [imageMessage()] },
            async () => ({ kind: 'reject' }),
        );
        expect(reject).toEqual({ kind: 'reject' });
        const off = await load(false);
        expect(off['agent/pre-step']).toBeUndefined();
        // Default config: no auto-read handler (request-time conversion owns it).
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const bare: Record<string, unknown> = {};
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: unknown) => {
                    bare[event] = fn;
                },
            } as never,
            {},
        );
        expect(bare['agent/pre-step']).toBeUndefined();
    });
});

describe('dsh plugin vision provider (phase 3)', () => {
    async function loadWith(llm: Record<string, unknown> | undefined, config = {}) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const ctx = {
            tools: { register: () => {} },
            attachments: {},
            on: () => {},
            llm,
        };
        plugin.apply(ctx as never, config);
        return ctx;
    }

    it('registers a wrapper provider that declares image input and delegates', async () => {
        const registered: Array<{
            providers: string[];
            adapter: Record<string, CallableFunction>;
        }> = [];
        const streamed: Array<Record<string, unknown>> = [];
        const llm = {
            registerAdapter: (providers: string[], adapter: Record<string, CallableFunction>) => {
                registered.push({ providers, adapter });
            },
            listModels: async () => [
                {
                    provider: 'deepseek-official',
                    id: 'deepseek-v4-flash',
                    name: 'DeepSeek V4 Flash',
                },
            ],
            resolveModelInfo: async (_p: string, model: string) => ({
                provider: 'deepseek-official',
                id: model,
                name: 'DeepSeek V4 Flash',
                inputModalities: ['text'],
            }),
            stream: (options: Record<string, unknown>) => {
                streamed.push(options);
                return (async function* () {})();
            },
        };
        await loadWith(llm);
        expect(registered[0].providers).toEqual(['deepseek-modlens']);
        const providerInfo = registered[0].adapter.providerInfo('deepseek-modlens') as {
            id: string;
            name: string;
        };
        expect(providerInfo.id).toBe('deepseek-modlens');
        expect(providerInfo.name.length).toBeGreaterThan(0);
        expect(registered[0].adapter.providerRetryPolicy('deepseek-modlens')).toBeUndefined();
        const adapter = registered[0].adapter;
        const models = (await adapter.listModels('deepseek-modlens')) as Array<{
            provider: string;
            name: string;
            inputModalities: string[];
        }>;
        expect(models).toHaveLength(1);
        expect(models[0].provider).toBe('deepseek-modlens');
        expect(models[0].inputModalities).toContain('image');
        expect(models[0].name).toContain('modlens vision');
        const info = (await adapter.resolveModel('deepseek-modlens', 'deepseek-v4-flash')) as {
            provider: string;
            id: string;
            inputModalities: string[];
        };
        expect(info.provider).toBe('deepseek-modlens');
        expect(info.id).toBe('deepseek-v4-flash');
        expect(info.inputModalities).toEqual(['text', 'image']);
        for await (const _chunk of adapter.stream({
            provider: 'deepseek-modlens',
            model: 'deepseek-v4-flash',
            messages: [],
        }) as AsyncIterable<unknown>) {
            // drain
        }
        expect(streamed[0].provider).toBe('deepseek-official');
    });

    it('degrades silently without the registration surface or when disabled', async () => {
        await loadWith(undefined);
        const registered: unknown[] = [];
        await loadWith(
            { registerAdapter: (...args: unknown[]) => registered.push(args), stream: () => {} },
            { visionProvider: false },
        );
        expect(registered).toEqual([]);
    });
});

describe('dsh plugin read_clipboard (milestone 2)', () => {
    const onDarwin = it.skipIf(process.platform !== 'darwin');

    it('ships a clipboard schema whose result branch is the source vision schema', () => {
        const shipped = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'dsh', 'clipboard-schema.json'), 'utf-8'),
        ) as {
            properties: { result: unknown; snapshot: { required: string[] } };
            required: string[];
        };
        expect(shipped.properties.result).toEqual(VISION_RESULT_SCHEMA);
        expect(shipped.required).toEqual(['snapshot', 'result']);
        expect(shipped.properties.snapshot.required).toContain('snapshotId');
        expect(shipped.properties.snapshot.required).toContain('sha256');
    });

    interface RegisteredTool {
        name: string;
        execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<unknown>;
    }

    async function loadTools(config: Record<string, unknown> = {}) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const tools: RegisteredTool[] = [];
        const handlers: Record<string, CallableFunction> = {};
        plugin.apply(
            {
                tools: { register: (tool: RegisteredTool) => tools.push(tool) },
                attachments: {},
                on: (event: string, fn: CallableFunction) => {
                    handlers[event] = fn;
                },
            } as never,
            config,
        );
        return { tools, handlers };
    }

    onDarwin('asks for approval on every call and stays out of other tools', async () => {
        const { handlers } = await loadTools();
        const gate = handlers['tools/pre-execute'];
        expect(gate).toBeDefined();
        const capture = (await gate({ name: 'read_clipboard', arguments: {} }, async () => ({
            kind: 'allow',
        }))) as { kind: string; reason?: string };
        expect(capture.kind).toBe('ask');
        expect(capture.reason).toContain('clipboard');
        const reread = (await gate(
            { name: 'read_clipboard', arguments: { snapshotId: 'snap9' } },
            async () => ({ kind: 'allow' }),
        )) as { kind: string; reason?: string };
        expect(reread.kind).toBe('ask');
        expect(reread.reason).toContain('snap9');
        const other = (await gate({ name: 'read_image', arguments: {} }, async () => ({
            kind: 'allow',
        }))) as { kind: string };
        expect(other.kind).toBe('allow');
    });

    function fakeClipCli(body: string): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-clip-'));
        const file = path.join(dir, 'cli.js');
        fs.writeFileSync(file, body);
        return file;
    }

    const captureOutput = JSON.stringify({
        image: 'clipboard://sha256/aa',
        provider: 'openai',
        result: { summary: 'CLIP-SUM', ocr: { full_text: 'CLIP-TEXT' }, uncertainty: [] },
        meta: {
            model: 'm',
            clipboard: {
                snapshotId: 'snap1',
                sha256: 'a'.repeat(64),
                bytes: 3,
                sourceMime: 'image/png',
                normalizedMime: 'image/png',
                createdAt: 'c',
                expiresAt: 'e',
            },
        },
    });

    onDarwin('capture path lifts the snapshot out of meta', async () => {
        const { tools } = await loadTools();
        const tool = tools.find((t) => t.name === 'read_clipboard');
        expect(tool).toBeDefined();
        const cli = fakeClipCli(
            `if (process.argv[2] !== 'clip' || process.argv[3] !== 'capture') { console.error('wrong argv: ' + process.argv.slice(2)); process.exit(9) }
             console.log(${JSON.stringify(captureOutput)})`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const value = (await tool?.execute({}, { signal: undefined })) as {
                snapshot: { snapshotId: string };
                result: { summary: string };
                provider: string;
                meta: Record<string, unknown>;
            };
            expect(value.snapshot.snapshotId).toBe('snap1');
            expect(value.result.summary).toBe('CLIP-SUM');
            expect(value.provider).toBe('openai');
            expect(value.meta).toEqual({ model: 'm' });
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    onDarwin('snapshotId routes to clip read and errors keep their identifier', async () => {
        const { tools } = await loadTools();
        const tool = tools.find((t) => t.name === 'read_clipboard');
        const cli = fakeClipCli(
            `if (process.argv[3] === 'read' && process.argv[4] === 'snap1') { console.log(${JSON.stringify(captureOutput)}) }
             else { console.error('Error: CLIPBOARD_NO_IMAGE: no image on the clipboard.'); process.exit(1) }`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const value = (await tool?.execute({ snapshotId: 'snap1' }, {})) as {
                snapshot: { snapshotId: string };
            };
            expect(value.snapshot.snapshotId).toBe('snap1');
            await expect(tool?.execute({ snapshotId: 'gone' }, {})).rejects.toThrow(
                /CLIPBOARD_NO_IMAGE/,
            );
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('stays unregistered when disabled', async () => {
        const { tools, handlers } = await loadTools({ readClipboard: false });
        expect(tools.find((t) => t.name === 'read_clipboard')).toBeUndefined();
        expect(handlers['tools/pre-execute']).toBeUndefined();
    });
});

describe('dsh plugin request-time image conversion (v2)', () => {
    it('keeps the log intact and converts wire messages once per attachment', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-cli-'));
        const marker = path.join(cliDir, 'count');
        const cli = path.join(cliDir, 'cli.js');
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'WIRE-EVIDENCE'},uncertainty:[]}}))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
            const streamed: Array<{
                messages: Array<{ content: Array<{ type: string; text?: string }> }>;
            }> = [];
            const ctx = {
                tools: { register: () => {} },
                attachments: {
                    readImage: async () => ({
                        data: new Uint8Array([1]),
                        ref: { mediaType: 'image/png' },
                    }),
                },
                on: () => {},
                llm: {
                    registerAdapter: (_p: string[], adapter: Record<string, CallableFunction>) => {
                        registered.push({ adapter });
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: (options: never) => {
                        streamed.push(options);
                        return (async function* () {})();
                    },
                },
            };
            plugin.apply(ctx as never, {});
            const adapter = registered[0].adapter;
            const request = {
                provider: 'deepseek-modlens',
                model: 'm',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'what is this' },
                            { type: 'image', attachment: { id: 'att-1' } },
                        ],
                    },
                ],
            };
            for await (const _c of adapter.stream(request) as AsyncIterable<unknown>) {
                // drain
            }
            const wire = streamed[0].messages[0].content;
            expect(wire[0]).toEqual({ type: 'text', text: 'what is this' });
            expect(wire[1].type).toBe('text');
            expect(wire[1].text).toContain('WIRE-EVIDENCE');
            // The caller's request object keeps its image block untouched.
            expect(request.messages[0].content[1].type).toBe('image');
            // Second request with the same attachment hits the cache: one CLI run.
            for await (const _c of adapter.stream(request) as AsyncIterable<unknown>) {
                // drain
            }
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });
});
