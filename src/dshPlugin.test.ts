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

    it('names the failure when the attachment store returns no data bytes (#17)', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, Handler> = {};
        plugin.apply(
            {
                tools: { register: () => {} },
                // An API-shape drift: readImage resolves, but with no data field.
                attachments: { readImage: async () => ({ ref: { mediaType: 'image/png' } }) },
                on: (event: string, fn: Handler) => {
                    handlers[event] = fn;
                },
            } as never,
            { autoRead: true },
        );
        const messages = [imageMessage()];
        const decision = await handlers['agent/pre-step'](
            { messages, signal: undefined },
            async () => ({ kind: 'enter', messages }),
        );
        const block = decision.messages?.[0].content[1];
        expect(block?.text).toContain('could not be read');
        expect(block?.text).toContain("no 'data' bytes");
    });

    it('writes heic pastes with their real extension and refuses unknown types', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const cli = fakeCli(
            `const f = process.argv[3];
             if (!f.endsWith('.heic')) { console.error('wrong ext: ' + f); process.exit(9) }
             console.log(JSON.stringify({ result: { summary: 'S', ocr: { full_text: 'HEIC-OK' }, uncertainty: [] } }))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const load = (mediaType: string) => {
                const handlers: Record<string, Handler> = {};
                plugin.apply(
                    {
                        tools: { register: () => {} },
                        attachments: {
                            readImage: async () => ({
                                data: new Uint8Array([1]),
                                ref: { mediaType },
                            }),
                        },
                        on: (event: string, fn: Handler) => {
                            handlers[event] = fn;
                        },
                    } as never,
                    { autoRead: true },
                );
                return handlers;
            };
            const messages = [imageMessage()];
            const heic = await load('image/heic')['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(heic.messages?.[0].content[1].text).toContain('HEIC-OK');
            const pdf = await load('application/pdf')['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(pdf.messages?.[0].content[1].text).toContain('unsupported pasted media type');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('auto-read also converts images nested in tool-result content (#24)', async () => {
        const handlers = await load();
        const cli = fakeCli(
            `console.log(JSON.stringify({ result: { summary: 'S', ocr: { full_text: 'DEEP-NESTED' }, uncertainty: [] } }))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            // Two levels down: tool-result inside tool-result, image at the bottom.
            const messages = [
                {
                    role: 'tool',
                    content: [
                        {
                            type: 'tool-result',
                            toolCallId: 'outer',
                            content: [
                                {
                                    type: 'tool-result',
                                    toolCallId: 'inner',
                                    content: [{ type: 'image', attachment: { id: 'deep' } }],
                                },
                            ],
                        },
                    ],
                },
            ];
            const decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            const outer = decision.messages?.[0].content[0] as unknown as {
                content: Array<{ content: Array<{ type: string; text?: string }> }>;
            };
            expect(outer.content[0].content[0].type).toBe('text');
            expect(outer.content[0].content[0].text).toContain('DEEP-NESTED');
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

    it('converts images nested inside tool-result content on the wire (#24)', async () => {
        // dsh's native read_image nests its image block inside tool-result
        // content; the upstream adapter's rejection check recurses, so the
        // conversion must too or the session wedges on its own history.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-nested-'));
        const cli = path.join(cliDir, 'cli.js');
        fs.writeFileSync(
            cli,
            `console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'NESTED-EVIDENCE'},uncertainty:[]}}))`,
        );
        process.env.MODLENS_DSH_CLI = cli;
        try {
            const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
            const streamed: Array<{
                messages: Array<{
                    content: Array<{
                        type: string;
                        text?: string;
                        content?: Array<{ type: string; text?: string }>;
                    }>;
                }>;
            }> = [];
            plugin.apply(
                {
                    tools: { register: () => {} },
                    attachments: {
                        readImage: async () => ({
                            data: new Uint8Array([1]),
                            ref: { mediaType: 'image/png' },
                        }),
                    },
                    on: () => {},
                    llm: {
                        registerAdapter: (
                            _p: string[],
                            adapter: Record<string, CallableFunction>,
                        ) => {
                            registered.push({ adapter });
                        },
                        listModels: async () => [],
                        resolveModelInfo: async () => ({}),
                        stream: (options: never) => {
                            streamed.push(options);
                            return (async function* () {})();
                        },
                    },
                } as never,
                {},
            );
            const request = {
                provider: 'deepseek-modlens',
                model: 'm',
                messages: [
                    {
                        role: 'tool',
                        content: [
                            {
                                type: 'tool-result',
                                toolCallId: 'call_1',
                                content: [
                                    { type: 'text', text: '<path>shot.png</path>' },
                                    { type: 'image', attachment: { id: 'att-nested' } },
                                ],
                            },
                        ],
                    },
                ],
            };
            for await (const _c of registered[0].adapter.stream(
                request,
            ) as AsyncIterable<unknown>) {
                // drain
            }
            const wire = streamed[0].messages[0].content[0];
            expect(wire.type).toBe('tool-result');
            expect(wire.content?.[0]).toEqual({ type: 'text', text: '<path>shot.png</path>' });
            expect(wire.content?.[1].type).toBe('text');
            expect(wire.content?.[1].text).toContain('NESTED-EVIDENCE');
            // The caller's request keeps the nested image: the log stays native.
            const original = request.messages[0].content[0] as {
                content: Array<{ type: string }>;
            };
            expect(original.content[1].type).toBe('image');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    async function adapterWithCli(cli: string) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
        plugin.apply(
            {
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
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        process.env.MODLENS_DSH_CLI = cli;
        return registered[0].adapter;
    }

    const imageRequest = (id: string) => ({
        provider: 'deepseek-modlens',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { id } }] }],
    });

    it('does not memoize a failed read: the next step retries', async () => {
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-retry-'));
        const marker = path.join(cliDir, 'runs');
        const cli = path.join(cliDir, 'cli.js');
        // First run fails (transient config error), later runs succeed.
        fs.writeFileSync(
            cli,
            `const fs=require('fs');const n=(fs.existsSync(${JSON.stringify(marker)})?fs.readFileSync(${JSON.stringify(marker)},'utf8').length:0)+1;fs.appendFileSync(${JSON.stringify(marker)},'x');
             if(n===1){console.error('quota exhausted');process.exit(1)}
             console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'RECOVERED'},uncertainty:[]}}))`,
        );
        try {
            const adapter = await adapterWithCli(cli);
            for await (const _c of adapter.stream(
                imageRequest('att-r'),
            ) as AsyncIterable<unknown>) {
                // drain
            }
            for await (const _c of adapter.stream(
                imageRequest('att-r'),
            ) as AsyncIterable<unknown>) {
                // drain
            }
            expect(fs.readFileSync(marker, 'utf-8')).toBe('xx');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it("one caller's abort neither kills the other waiter nor the shared read", async () => {
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-abort-'));
        const marker = path.join(cliDir, 'runs');
        const cli = path.join(cliDir, 'cli.js');
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');
             setTimeout(()=>console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'SURVIVED'},uncertainty:[]}})),200)`,
        );
        try {
            const adapter = await adapterWithCli(cli);
            const controller = new AbortController();
            const cancelled = (async () => {
                for await (const _c of adapter.stream({
                    ...imageRequest('att-a'),
                    signal: controller.signal,
                }) as AsyncIterable<unknown>) {
                    // drain
                }
            })().then(
                () => 'completed',
                () => 'aborted',
            );
            const survivor = (async () => {
                for await (const _c of adapter.stream(
                    imageRequest('att-a'),
                ) as AsyncIterable<unknown>) {
                    // drain
                }
                return 'completed';
            })();
            setTimeout(() => controller.abort(), 30);
            // The cancelled caller stops promptly; the other waiter and the
            // underlying read are unaffected, and the read ran exactly once.
            expect(await cancelled).toBe('aborted');
            expect(await survivor).toBe('completed');
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });

    it('joins concurrent readers of the same attachment into one CLI run', async () => {
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-dsh-conc-'));
        const marker = path.join(cliDir, 'runs');
        const cli = path.join(cliDir, 'cli.js');
        // Slow enough that both streams overlap the same in-flight read.
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');
             setTimeout(()=>console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'ONCE'},uncertainty:[]}})),150)`,
        );
        try {
            const adapter = await adapterWithCli(cli);
            const drain = async () => {
                for await (const _c of adapter.stream(
                    imageRequest('att-c'),
                ) as AsyncIterable<unknown>) {
                    // drain
                }
            };
            await Promise.all([drain(), drain()]);
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.MODLENS_DSH_CLI;
        }
    });
});

describe('dsh plugin tool-name collision (#21)', () => {
    it('falls back to modlens_read_image and keeps the rest of the plugin alive', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: string[] = [];
        const adapters: string[] = [];
        plugin.apply(
            {
                tools: {
                    register: (tool: { name: string }) => {
                        // The host's native read_image (dsh-tool-fs) is there first.
                        if (tool.name === 'read_image') {
                            throw new Error('tool "read_image" is already registered');
                        }
                        registered.push(tool.name);
                    },
                },
                attachments: {},
                on: () => {},
                llm: {
                    registerAdapter: (providers: string[]) => {
                        adapters.push(...providers);
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        expect(registered).toContain('modlens_read_image');
        // The collision no longer fails the fiber: the vision wrapper registered.
        expect(adapters).toContain('deepseek-modlens');
    });

    it('an unrelated registration error degrades without killing apply', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        expect(() =>
            plugin.apply(
                {
                    tools: {
                        register: () => {
                            throw new Error('registry exploded');
                        },
                    },
                    attachments: {},
                    on: () => {},
                } as never,
                {},
            ),
        ).not.toThrow();
    });
});

describe('image format contract (CLI, skill, dsh in lockstep)', () => {
    it('dsh MEDIA_EXT covers exactly the CLI allow-list', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            MEDIA_EXT: Record<string, string>;
        };
        const { ALLOWED_MIME } = await import('./imageInput.ts');
        expect(new Set(Object.keys(plugin.MEDIA_EXT))).toEqual(ALLOWED_MIME);
    });

    it('the skill trigger extensions are exactly the CLI extension table', async () => {
        const { MIME_BY_EXT } = await import('./imageInput.ts');
        const skill = fs.readFileSync(
            path.join(__dirname, '..', 'skills', 'modlens', 'SKILL.md'),
            'utf-8',
        );
        const match = skill.match(/\(((?:\.\w+, )+\.\w+)\)/);
        expect(match).toBeTruthy();
        const skillExts = new Set((match as RegExpMatchArray)[1].split(', '));
        expect(skillExts).toEqual(new Set(Object.keys(MIME_BY_EXT)));
    });
});

describe('format mapping lockstep', () => {
    it('every MEDIA_EXT value maps back to its mime through the CLI table', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            MEDIA_EXT: Record<string, string>;
        };
        const { MIME_BY_EXT } = await import('./imageInput.ts');
        for (const [mime, ext] of Object.entries(plugin.MEDIA_EXT)) {
            expect(MIME_BY_EXT[ext]).toBe(mime);
        }
    });
});

describe('dsh paste-to-path host route', () => {
    type RouteHandler = (
        req: {
            method: string;
            [Symbol.asyncIterator]: () => AsyncIterator<Buffer>;
        },
        res: {
            writeHead: (code: number, headers?: Record<string, string>) => unknown;
            end: (body?: string) => void;
        },
    ) => Promise<void>;

    async function routeOf(config: Record<string, unknown> = {}) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const routes: Array<{ path: string; handler: RouteHandler }> = [];
        const scoped = {
            webServer: {
                register: (route: { path: string; handler: RouteHandler }) => routes.push(route),
            },
        };
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: () => {},
                inject: (deps: string[], fn: (scope: unknown) => void) => {
                    // The scoped closure runs only where webServer exists.
                    if (deps.includes('webServer')) fn(scoped);
                },
            } as never,
            config,
        );
        return routes;
    }

    function fakeReq(method: string, body: Buffer) {
        return {
            method,
            destroy: () => {},
            async *[Symbol.asyncIterator]() {
                yield body;
            },
        };
    }

    function fakeRes() {
        const out = { code: 0, body: '' };
        return {
            out,
            res: {
                writeHead: (code: number) => {
                    out.code = code;
                    return { end: (b?: string) => (out.body = b ?? '') };
                },
                end: (b?: string) => {
                    out.body = b ?? '';
                },
            },
        };
    }

    it('registers /modlens/paste under the web profile and writes a private file', async () => {
        const routes = await routeOf();
        expect(routes[0]?.path).toBe('/modlens/paste');
        const { out, res } = fakeRes();
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
        await routes[0].handler(fakeReq('POST', png) as never, res as never);
        expect(out.code).toBe(200);
        const { path: written } = JSON.parse(out.body) as { path: string };
        expect(written.endsWith('paste.png')).toBe(true);
        expect(fs.readFileSync(written)).toEqual(png);
        // POSIX permission bits are meaningless on Windows (mode reads 0o666
        // regardless), the same boundary recover-paste's checks respect.
        if (process.platform !== 'win32') {
            expect(fs.statSync(written).mode & 0o777).toBe(0o600);
        }
        fs.rmSync(path.dirname(written), { recursive: true, force: true });
    });

    it('refuses non-POST, non-image bytes, and honors the off switch', async () => {
        const routes = await routeOf();
        const a = fakeRes();
        await routes[0].handler(fakeReq('GET', Buffer.alloc(0)) as never, a.res as never);
        expect(a.out.code).toBe(405);
        const b = fakeRes();
        await routes[0].handler(
            fakeReq('POST', Buffer.from('not an image')) as never,
            b.res as never,
        );
        expect(b.out.code).toBe(400);
        expect(await routeOf({ pasteToPath: false })).toEqual([]);
    });
});

describe('dsh vision provider auto-discovery (#29)', () => {
    interface FakeProvider {
        id: string;
        name?: string;
        models: Array<{ id: string; name?: string; inputModalities?: string[] }>;
    }

    async function discoveryCtx(providers: FakeProvider[], config: Record<string, unknown> = {}) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: string[] = [];
        const handlers: Record<string, () => void> = {};
        const live = [...providers];
        const ctx = {
            tools: { register: () => {} },
            attachments: {},
            on: (event: string, fn: () => void) => {
                handlers[event] = fn;
            },
            llm: {
                registerAdapter: (ids: string[]) => {
                    registered.push(...ids);
                },
                listProviders: () => live.map((p) => ({ id: p.id, name: p.name })),
                listModels: async (id: string) => live.find((p) => p.id === id)?.models ?? [],
                resolveModelInfo: async () => ({}),
                stream: () => (async function* () {})(),
            },
        };
        plugin.apply(ctx as never, config);
        // sweep is async; give it a tick.
        await new Promise((r) => setTimeout(r, 10));
        return { registered, handlers, live };
    }

    const deepseek: FakeProvider = {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash' }],
    };
    const opencode: FakeProvider = {
        id: 'opencode-go',
        name: 'opencode-go',
        models: [{ id: 'glm-5.3' }],
    };
    const unrelated: FakeProvider = {
        id: 'other-vendor',
        models: [{ id: 'kimi-k2.5' }],
    };

    it('wraps every route carrying wrappable family models, once each', async () => {
        const { registered } = await discoveryCtx([deepseek, opencode, unrelated]);
        // deepseek-official keeps its historical id; others get modlens-<id>;
        // a route with no family models is left alone.
        expect(registered).toContain('deepseek-modlens');
        expect(registered).toContain('modlens-opencode-go');
        expect(registered).not.toContain('modlens-other-vendor');
    });

    it('honors the discover whitelist', async () => {
        const { registered } = await discoveryCtx([deepseek, opencode], {
            discover: ['opencode-go'],
        });
        expect(registered).toEqual(['modlens-opencode-go']);
    });

    it('a set upstream keeps single-route legacy mode', async () => {
        const { registered } = await discoveryCtx([deepseek, opencode], {
            upstream: 'deepseek-official',
        });
        expect(registered).toEqual(['deepseek-modlens']);
    });

    it('never wraps its own wrappers', async () => {
        const { registered } = await discoveryCtx([
            deepseek,
            { id: 'modlens-opencode-go', models: [{ id: 'glm-5.3' }] },
        ]);
        expect(registered).toEqual(['deepseek-modlens']);
    });

    it('late routes are wrapped when the registry notifies', async () => {
        const { registered, handlers, live } = await discoveryCtx([deepseek]);
        expect(registered).toEqual(['deepseek-modlens']);
        // llm-pi-ai style: a provider registering after plugin mount.
        live.push(opencode);
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered).toContain('modlens-opencode-go');
        // And the notification never duplicates existing wraps.
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered.filter((id) => id === 'modlens-opencode-go')).toHaveLength(1);
    });
});
