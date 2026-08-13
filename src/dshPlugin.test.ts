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

    async function load(autoRead?: boolean) {
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
                    bytes: new Uint8Array([1, 2, 3]),
                    mediaType: 'image/png',
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
        const adapter = registered[0].adapter;
        const models = (await adapter.listModels('deepseek-modlens')) as Array<{
            provider: string;
            name: string;
            inputModalities: string[];
        }>;
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
        adapter.stream({ provider: 'deepseek-modlens', model: 'deepseek-v4-flash', messages: [] });
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
