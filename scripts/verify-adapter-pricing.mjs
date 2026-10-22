// Part of `npm run check:host`; also runnable directly with
// node --test --test-concurrency=1 scripts/verify-adapter-pricing.mjs
// Contract cases against a staged Host; no app build and no live model
// requests. DSH_HOST_ROOT points at the Host's `dsh-plugin-desktop` directory;
// without it every case reports NOT EXECUTED and check:host exits non-zero.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { __adapter, __modelManager, apply } from '../dsh/index.js';
import { hostRoot, withoutHost } from './host-contract-harness.mjs';

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

/**
 * DSH 0.1 kept the UI language in a settings namespace the plugin read with
 * settings.get('locale'). That provider still exists there and is used as is.
 * @returns the host's locale controls and the context the plugin is applied to.
 */
async function dsh01LocaleHost(load, z, settingsModule) {
    const { Context } = await load('@deepseek-ai/cordis');
    class MemorySettings extends settingsModule.SettingsProvider {
        async load() {
            return {};
        }
        async persist() {}
    }
    const settings = new MemorySettings(new Context());
    settings.register('locale', z.object({ preference: z.string().default('en') }));
    return {
        plugin: { settings },
        setLanguage: async (preference) => settings.publish({ locale: { preference } }),
        language: () => settings.get('locale').preference,
        close: async () => {},
    };
}

/**
 * DSH 0.2 removed settings.register/get: the UI language is the volatile
 * `preference` of the `locale` profile entry, changed through settings.update
 * and read back through settings.describe. This boots a real profile with the
 * real Loader, config editor and settings service, the same way the upstream
 * settings tests do. The locale entry mirrors the host Config of
 * @deepseek-ai/dsh-client-locale, whose host entry is not built in a runtime.
 * @returns the host's locale controls and the context the plugin is applied to.
 */
async function dsh02LocaleHost(require, load, z, settingsModule) {
    const { boot, initProfile, readProfilePatches } = await load('@deepseek-ai/dsh-app-boot');
    // The config editor is a dependency of the settings package, not of the CLI.
    const fromSettings = createRequire(require.resolve('@deepseek-ai/dsh-settings'));
    const { default: ConfigEditor } = await load('@deepseek-ai/dsh-config-editor', fromSettings);
    const { default: Timer } = await load('@deepseek-ai/cordis-plugin-timer');
    const { default: Hmr } = await load('@deepseek-ai/dsh-hmr');
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'modlens-locale-')));
    const dir = join(home, 'profiles', 'test');
    initProfile(dir, ['test-bundle']);
    const bundle = join(dir, 'node_modules', 'test-bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n');
    writeFileSync(
        join(bundle, 'package.json'),
        JSON.stringify({
            name: 'test-bundle',
            version: '1.0.0',
            dsh: { bundle: { patch: 'cordis.patch.yml' } },
        }),
    );
    writeFileSync(
        join(bundle, 'cordis.patch.yml'),
        JSON.stringify([
            {
                insert: [
                    { id: 'config-editor', name: 'cordis:editor' },
                    { id: 'settings', name: 'cordis:settings' },
                    { id: 'locale', name: 'cordis:locale', config: { preference: 'en' } },
                ],
            },
        ]),
    );
    writeFileSync(join(dir, 'cordis.yml'), '[]\n');
    const profile = {
        name: 'test',
        startedBundles: ['test-bundle'],
        dir,
        patchPath: join(dir, 'cordis.patch.yml'),
        installAnchor: join(home, 'package.json'),
        cwd: home,
        home,
        overlays: [],
        telemetryDisabledEnv: undefined,
    };
    const Locale = {
        Config: z.object({
            preference: z
                .string()
                .pattern(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u)
                .required(false)
                .volatile(),
        }),
        apply: () => {},
    };
    const ctx = await boot(
        'test',
        join(dir, 'cordis.yml'),
        readProfilePatches('test', profile),
        (root) => {
            root.provide('profileContext', profile);
            root.provide('appReady', {
                onReady: (listener) => {
                    listener();
                    return () => {};
                },
            });
            Object.assign(root.loader.builtins, {
                editor: ConfigEditor,
                settings: settingsModule.default,
                locale: Locale,
            });
        },
    );
    await ctx.plugin(Timer);
    const hmr = ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 });
    await hmr.await();
    await ctx.hmr.runExclusive(async () => {});
    const { settings } = ctx;
    return {
        // The settings service reaches the plugin the way the Host delivers it.
        plugin: {
            inject(services, callback) {
                if (services.length === 1 && services[0] === 'settings') callback({ settings });
            },
        },
        setLanguage: (preference) => settings.update('locale', { preference }),
        language: () => settings.describe().find((row) => row.ns === 'locale')?.value?.preference,
        close: async () => {
            await ctx.fiber.dispose();
            rmSync(home, { recursive: true, force: true });
        },
    };
}

test('real DSH settings localize cached image failures after language changes', {
    skip: withoutHost(),
}, async () => {
    const require = createRequire(resolve(hostRoot(), 'package.json'));
    const load = (name, from = require) => import(pathToFileURL(from.resolve(name)));
    const settingsModule = await load('@deepseek-ai/dsh-settings');
    const { default: z } = await load('@deepseek-ai/schemastery');
    const host =
        typeof settingsModule.SettingsProvider === 'function'
            ? await dsh01LocaleHost(load, z, settingsModule)
            : await dsh02LocaleHost(require, load, z, settingsModule);
    let handler;
    let reads = 0;
    const messages = [
        {
            role: 'user',
            content: [{ type: 'image', attachment: { id: 'settings-language-contract' } }],
        },
    ];
    const originalError = console.error;
    console.error = () => {};
    try {
        apply(
            {
                ...host.plugin,
                tools: { register() {} },
                attachments: {
                    async readImage() {
                        reads += 1;
                        return {};
                    },
                },
                on(event, callback) {
                    if (event === 'agent/pre-step') handler = callback;
                },
            },
            { autoRead: true, visionProvider: false, settingsCard: false, pasteToPath: false },
        );
        // Switching back as well: the message follows the language both ways.
        for (const [preference, message] of [
            [
                'en',
                'Image recognition failed. Please retry or switch the vision model in TokensAPI model settings.',
            ],
            ['zh', '图片识别失败，请重试或在 TokensAPI 模型设置中切换视觉模型。'],
            [
                'en',
                'Image recognition failed. Please retry or switch the vision model in TokensAPI model settings.',
            ],
        ]) {
            await host.setLanguage(preference);
            assert.equal(host.language(), preference);
            await assert.rejects(
                handler({}, async () => ({ kind: 'enter', messages })),
                {
                    code: 'MODLENS_VISION_READ_FAILED',
                    message,
                },
            );
        }
        assert.equal(reads, 1);
    } finally {
        console.error = originalError;
        await host.close();
    }
});

test('real DSH token-meter can price text and image histories through the plugin', {
    skip: withoutHost(),
}, async () => {
    const require = createRequire(resolve(hostRoot(), 'package.json'));
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
    skip: withoutHost(),
}, async (t) => {
    const require = createRequire(resolve(hostRoot(), 'package.json'));
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
            const checkpoint = [
                '## Primary Request and Intent',
                '- Verify the plugin against the real DSH compaction contract.',
                '## Key Technical Concepts',
                '- TokenMeter and BasicCompactionEngine compatibility.',
                '## Files and Code',
                '- scripts/verify-adapter-pricing.mjs: isolated contract fixture.',
                '## Errors and Fixes',
                '- (none)',
                '## Pending Jobs',
                '- (none)',
                '## Current Work',
                '- Exercising manual and automatic compaction.',
                '## Next Step',
                '- Complete the contract assertions.',
                '## Critical Context',
                '- Network access is forbidden in this fixture.',
            ].join('\n');
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield {
                type: 'block-end',
                index: 0,
                block: { type: 'text', text: checkpoint },
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
    // Prove that this history actually exercises the interface the wrapper has
    // to answer. The wrapper extends the Host's own LlmAdapter now, so the
    // method lives on its prototype and `delete` cannot hide it — which is the
    // whole point of T0033. Shadowing the instance hides it for one assertion;
    // removing the shadow hands the inherited method back.
    const legacy = makeSession('modlens-tokensapi');
    Object.defineProperty(wrapper, 'imageRequestPricing', { value: undefined, configurable: true });
    assert.throws(() => meter.measure(legacy), /imageRequestPricing is not a function/);
    delete wrapper.imageRequestPricing;
    assert.equal(typeof wrapper.imageRequestPricing, 'function');
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

test('real DSH adapter methods the plugin never declares are inherited, not missing', {
    skip: withoutHost(),
}, async () => {
    const require = createRequire(resolve(hostRoot(), 'package.json'));
    const load = (name) => import(pathToFileURL(require.resolve(name)));
    const { Context } = await load('@deepseek-ai/cordis');
    const { LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
    const model = 'deepseek-v4-flash';
    const ctx = new Context();
    const llm = new LlmRuntime(ctx);
    class Upstream extends LlmAdapter {
        providerInfo(provider) {
            return { id: provider, name: 'TokensAPI' };
        }
        async listModels(provider) {
            return [
                {
                    provider,
                    id: model,
                    name: 'DeepSeek V4 Flash',
                    inputModalities: ['text'],
                },
            ];
        }
        async resolveModel(provider) {
            return (await this.listModels(provider))[0];
        }
        stream() {
            throw new Error('a contract check must not reach the wire');
        }
    }
    llm.registerAdapter(['tokensapi'], new Upstream());
    let wrapper;
    const originalRegister = llm.registerAdapter.bind(llm);
    llm.registerAdapter = (ids, adapter) => {
        if (ids.includes('modlens-tokensapi')) wrapper = adapter;
        return originalRegister(ids, adapter);
    };
    apply(
        { llm, tools: { register() {} }, on() {} },
        {
            upstream: 'tokensapi',
            providerId: 'modlens-tokensapi',
            settingsCard: false,
            pasteToPath: false,
        },
    );
    assert.ok(wrapper, 'the managed vision wrapper must register');
    // The plugin resolves the base from its own module tree, which is the
    // Host's in an installed Desktop and is not from a source checkout. Both
    // are legitimate; the next assertions hold for either, and this one pins
    // which is which so a broken resolver cannot pass as "no Host base here".
    const resolved = __adapter.hostLlmAdapterBase();
    assert.equal(
        __adapter.hostLlmAdapterBase(() => require('@deepseek-ai/dsh-llm')),
        LlmAdapter,
        "the resolver must recognize this Host's adapter base",
    );
    assert.ok(wrapper instanceof (resolved ?? __adapter.LlmAdapterDefaults));
    // Every method this Host declares on the base is answerable on the
    // wrapper, including the ones the plugin never mentions. This is the
    // assertion that makes the next upstream addition a non-event: prepareCall,
    // imageRequestPricing and imageRequestTarget each arrived with a base
    // default, and the duck-typed object answered none of them until it was
    // patched, the last one as a live TypeError on 0.2.1 (T0026/T0033).
    const declared = Object.getOwnPropertyNames(LlmAdapter.prototype).filter(
        (name) => name !== 'constructor',
    );
    assert.ok(declared.length > 0);
    for (const name of declared) {
        assert.equal(typeof wrapper[name], 'function', `${name} must be callable on the wrapper`);
    }
    // ... and answers the inherited ones exactly as a bare subclass does. On
    // 0.2.0-rc.2 the base declares no imageRequestTarget, so there is nothing
    // to inherit and nothing changes; `declared` carries that difference.
    const bare = new (class extends LlmAdapter {})();
    if (declared.includes('imageRequestTarget')) {
        const image = { width: 1024, height: 768, bytes: 4096 };
        assert.deepEqual(
            wrapper.imageRequestTarget('modlens-tokensapi', model, image),
            bare.imageRequestTarget('modlens-tokensapi', model, image),
        );
    }
    // prepareCall is inherited now; it must still resolve through the wrapper's
    // own resolveModel (the bridged twin, not the upstream model) and bind the
    // one-shot stream to this registration, which is what the restated copy did.
    const prepared = await wrapper.prepareCall('modlens-tokensapi', model);
    assert.equal(prepared.model.provider, 'modlens-tokensapi');
    assert.equal(prepared.model.id, model);
    assert.ok(prepared.model.inputModalities.includes('image'));
    assert.equal(typeof prepared.stream, 'function');
    // Registration-time facts and the shared evidence cache survive the move
    // from a plain object to an instance.
    assert.deepEqual(wrapper.providerInfo('modlens-tokensapi'), {
        id: 'modlens-tokensapi',
        name: 'TokensAPI (modlens vision)',
    });
    assert.ok(wrapper.evidenceCache instanceof Map);
    assert.deepEqual(
        (await wrapper.listModels('modlens-tokensapi')).map((entry) => entry.id),
        [model],
    );
});
