// Run with node --test scripts/verify-adapter-pricing.mjs against an existing runtime.
// Optional contract integration against an existing Desktop runtime; no app build
// or live model requests. DSH_RUNTIME_ROOT points at its package directory.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { __modelManager, apply } from '../dsh/index.js';

// Optional private session replay arrives on stdin; never persist or print its
// messages, paths, tool arguments or credentials. No tool runner is mounted.
let replayRows;
if (process.env.DSH_SESSION_REPLAY === '1') {
    process.stdin.setEncoding('utf8');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    replayRows = input
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
}

test('real DSH token-meter can price text and image histories through the plugin', {
    skip: !process.env.DSH_RUNTIME_ROOT,
}, async () => {
    const require = createRequire(resolve(process.env.DSH_RUNTIME_ROOT, 'package.json'));
    const load = (name) => import(pathToFileURL(require.resolve(name)));
    const { Context } = await load('@deepseek-ai/cordis');
    const { LlmRuntime, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm');
    const { Session, SessionId, canonicalHeader } = await load('@deepseek-ai/dsh-session');
    const { default: Registry } = await load('@deepseek-ai/dsh-session-projection');
    const { default: TokenMeter } = await load('@deepseek-ai/dsh-token-meter');
    const ctx = new Context();
    new Registry(ctx);
    const llm = new LlmRuntime(ctx);
    class Upstream extends LlmAdapter {
        imageRequestPricing() {
            return { priceImages: (images) => images.map(() => ({ visualTokens: 384, text: '' })) };
        }
        async listModels() {
            return [
                { id: 'deepseek-v4-flash', name: 'Text', inputModalities: ['text'] },
                { id: 'gpt-5.5', name: 'Vision', inputModalities: ['text', 'image'] },
            ];
        }
        stream() {
            throw new Error('network must not be used for measurement');
        }
    }
    llm.registerAdapter(['tokensapi'], new Upstream());
    apply(
        { llm, tools: { register() {} }, on() {} },
        {
            upstream: 'tokensapi',
            providerId: 'modlens-tokensapi',
            settingsCard: false,
            pasteToPath: false,
        },
    );
    const meter = new TokenMeter(ctx);
    for (const withImage of [false, true]) {
        const session = Session.create(SessionId(`pricing-${withImage}`));
        const content = [{ type: 'text', text: 'Measure this history before compaction.' }];
        if (withImage)
            content.push({
                type: 'image',
                attachment: {
                    attachmentId: `sha256:${'ab'.repeat(32)}`,
                    mediaType: 'image/png',
                    width: 800,
                    height: 800,
                    bytes: 2048,
                    name: 'test.png',
                },
            });
        session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), {
            surfaceOp: 'append',
        });
        const measurements = ['deepseek-v4-flash', 'gpt-5.5'].map((model) =>
            meter.measure(
                session,
                canonicalHeader({ config: { provider: 'modlens-tokensapi', model } }),
            ),
        );
        for (const result of measurements) {
            assert.ok(Number.isFinite(result.totalTokens) && result.totalTokens > 0);
            assert.equal(result.nodes.length, 1);
        }
        if (withImage) assert.ok(measurements[1].totalTokens > measurements[0].totalTokens);
        else assert.equal(measurements[0].totalTokens, measurements[1].totalTokens);
    }
});

test('real DSH manual, pressure and overflow compaction recover on legacy and native routes', {
    skip: !process.env.DSH_RUNTIME_ROOT,
}, async (t) => {
    const require = createRequire(resolve(process.env.DSH_RUNTIME_ROOT, 'package.json'));
    const load = (name) => import(pathToFileURL(require.resolve(name)));
    const { Context } = await load('@deepseek-ai/cordis');
    const { LlmRuntime, LlmAdapter, createUserMessage, createAssistantMessage } =
        await load('@deepseek-ai/dsh-llm');
    const { default: SessionStore, Session, SessionId } = await load('@deepseek-ai/dsh-session');
    const { default: Registry } = await load('@deepseek-ai/dsh-session-projection');
    const { default: TokenMeter } = await load('@deepseek-ai/dsh-token-meter');
    const { BasicCompactionEngine } = await load('@deepseek-ai/dsh-compaction-basic');
    const ctx = new Context();
    new Registry(ctx);
    new SessionStore(ctx);
    // Detached in-memory replay only. Never write into the user's session store.
    ctx.sessions.flush = async () => false;
    const llm = new LlmRuntime(ctx);
    const model = 'deepseek-v4-flash-vision-exp';
    let summaryCalls = 0;
    class Upstream extends LlmAdapter {
        imageRequestPricing() {
            return { priceImages: (images) => images.map(() => ({ visualTokens: 384, text: '' })) };
        }
        async listModels() {
            return [
                {
                    id: model,
                    name: model,
                    inputModalities: ['text', 'image'],
                    context: { contextWindow: 262144, maxOutputTokens: 32768 },
                },
            ];
        }
        async resolveModel(provider) {
            return { ...(await this.listModels())[0], provider };
        }
        async *stream(options) {
            assert.equal(options.provider, 'tokensapi');
            assert.equal(options.model, model);
            summaryCalls++;
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield {
                type: 'block-end',
                index: 0,
                block: { type: 'text', text: 'Offline regression summary of the completed work.' },
            };
            yield { type: 'finish', reason: { kind: 'stop' } };
        }
    }
    llm.registerAdapter(['tokensapi'], new Upstream());
    let wrapper;
    const originalRegister = llm.registerAdapter.bind(llm);
    llm.registerAdapter = (ids, adapter) => {
        if (ids.includes('modlens-tokensapi')) wrapper = adapter;
        return originalRegister(ids, adapter);
    };
    const credentials = new Map();
    const pluginCtx = {
        llm,
        tools: { register() {} },
        on() {},
        credentials: {
            describe: async (ref) => ({ configured: credentials.has(ref), writable: true }),
            resolve: async (ref) =>
                credentials.has(ref) ? { value: credentials.get(ref) } : undefined,
            set: async (ref, value) => {
                credentials.set(ref, value);
            },
        },
    };
    apply(pluginCtx, {
        upstream: 'tokensapi',
        providerId: 'modlens-tokensapi',
        settingsCard: false,
        pasteToPath: false,
    });
    await __modelManager.setManagedCredential(pluginCtx, 'synthetic-regression-key', async () => ({
        status: 200,
        json: async () => ({
            data: [
                {
                    id: model,
                    input: ['text', 'image'],
                    supported_endpoint_types: ['openai'],
                    contextWindow: 262144,
                    maxTokens: 32768,
                },
            ],
        }),
    }));
    const route = await __modelManager.resolveManagedMainRoute(pluginCtx, model);
    assert.equal(route.provider, 'tokensapi');
    assert.equal(route.visionMode, 'native');
    const meter = new TokenMeter(ctx);
    const compact = new BasicCompactionEngine(ctx, { auto: false, retainTokens: 0 });
    const signal = new AbortController().signal;
    const makeSession = (provider) => {
        let session;
        if (replayRows) {
            const failed = replayRows.find(
                (row) =>
                    row.type === 'command/done' &&
                    row.data?.kind === 'error' &&
                    String(row.data?.text).includes('imageRequestPricing'),
            );
            assert.ok(failed, 'replay must include the reported compact pricing failure');
            const events = replayRows.filter(
                (row) => Number.isInteger(row.seq) && row.seq < failed.seq,
            );
            session = Session.create(SessionId('private-compaction-replay'), events);
        } else {
            session = Session.create(SessionId('synthetic-compaction-replay'));
            for (let turn = 1; turn <= 3; turn++) {
                session.append('turn/start', { turn });
                session.append(
                    'user/message',
                    createUserMessage({
                        content: [
                            {
                                type: 'text',
                                text: 'Synthetic long conversation history. '.repeat(20000),
                            },
                        ],
                        source: { kind: 'user' },
                    }),
                    { surfaceOp: 'append' },
                );
                session.append('step/start', { turn, step: 1 });
                session.append(
                    'assistant/message',
                    {
                        turn,
                        step: 1,
                        stream: [],
                        message: createAssistantMessage({
                            content: [{ type: 'text', text: 'Done.' }],
                            source: { provider, model },
                        }),
                    },
                    { surfaceOp: 'append' },
                );
                session.append('step/end', { turn, step: 1 });
                session.append('turn/end', { turn, reason: { kind: 'completed' } });
            }
        }
        const previousHeader =
            session.snapshotEvents().findLast((event) => event.type === 'request/header')?.data
                .header ?? {};
        session.append('request/header', {
            header: {
                ...previousHeader,
                config: { ...previousHeader.config, provider, model, maxTokens: 32768 },
            },
            reason: 'initial',
        });
        return session;
    };
    // Prove that this history actually exercises the missing-interface bug.
    const legacy = makeSession('modlens-tokensapi');
    const price = wrapper.imageRequestPricing;
    delete wrapper.imageRequestPricing;
    assert.throws(() => meter.measure(legacy), /imageRequestPricing is not a function/);
    wrapper.imageRequestPricing = price;
    for (const provider of ['modlens-tokensapi', route.provider]) {
        for (const trigger of ['manual', 'pressure', 'context-overflow']) {
            const session = makeSession(provider);
            if (trigger !== 'manual') {
                const turns = session
                    .snapshotEvents()
                    .filter((event) => event.type === 'turn/start');
                session.append('turn/start', { turn: (turns.at(-1)?.data.turn ?? 0) + 1 });
            }
            const before = meter.measure(session).totalTokens;
            const agent = {
                session,
                options: { provider, model },
                runMaintenance: (task) => task(signal),
            };
            const result =
                trigger === 'manual'
                    ? await compact.compactNow(agent, signal)
                    : await compact.compactIfNeeded(agent, trigger, signal);
            if (trigger === 'pressure' && before < 262144 * compact.config.thresholdRatio) {
                assert.equal(result, null);
                t.diagnostic(
                    `${provider}/pressure: estimate ${before} is below the configured threshold; overflow recovery is tested separately`,
                );
                continue;
            }
            assert.ok(result, `${provider}/${trigger} must compact the long history`);
            const after = meter.measure(session).totalTokens;
            assert.ok(after < before, `${provider}/${trigger} must shrink the replay surface`);
            assert.ok(
                session.snapshotEvents().some((event) => event.type === 'compaction/summary'),
            );
            t.diagnostic(
                `${replayRows ? 'private replay' : 'synthetic'} ${provider}/${trigger}: ${before} -> ${after} tokens`,
            );
        }
    }
    assert.ok(summaryCalls >= 4);
});
