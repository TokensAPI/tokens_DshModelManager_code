import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    __modelManager,
    apply,
    Config,
    createManagerConfig,
    DEEPSEEK_OFFICIAL,
    TOKENSAPI,
    volatileSchemastery,
    // @ts-expect-error The DSH entry is deliberately dependency-free plain JS.
} from '../dsh/index.js';
import { resolveProviderSettings } from './config.ts';

interface CredentialHarness {
    stored: string | undefined;
    verification: string | undefined;
    official: string | undefined;
    ctx: {
        credentials: {
            describe: (
                ref: string,
            ) => Promise<{ configured: boolean; writable: boolean; source?: string }>;
            resolve: (ref: string) => Promise<{ value: string } | undefined>;
            set: (ref: string, value: string) => Promise<void>;
        };
    };
}

function credentialHarness(initial?: string, verified = false): CredentialHarness {
    const harness: CredentialHarness = {
        stored: initial,
        verification: undefined,
        official: undefined,
        ctx: {
            credentials: {
                describe: async (ref) => ({
                    configured:
                        ref === TOKENSAPI.credentialRef
                            ? harness.stored !== undefined
                            : ref === TOKENSAPI.verificationRef
                              ? harness.verification !== undefined
                              : ref === DEEPSEEK_OFFICIAL.credentialRef
                                ? harness.official !== undefined
                                : false,
                    writable: true,
                    ...(harness.stored === undefined && harness.verification === undefined
                        ? {}
                        : { source: 'file' }),
                }),
                resolve: async (ref) => {
                    const value =
                        ref === TOKENSAPI.credentialRef
                            ? harness.stored
                            : ref === TOKENSAPI.verificationRef
                              ? harness.verification
                              : ref === DEEPSEEK_OFFICIAL.credentialRef
                                ? harness.official
                                : undefined;
                    return value === undefined ? undefined : { value };
                },
                set: async (ref, value) => {
                    if (ref === TOKENSAPI.credentialRef) harness.stored = value;
                    else if (ref === TOKENSAPI.verificationRef) harness.verification = value;
                    else if (ref === DEEPSEEK_OFFICIAL.credentialRef) harness.official = value;
                    else throw new Error(`unexpected credential ref: ${ref}`);
                },
            },
        },
    };
    if (initial !== undefined && verified) {
        harness.verification = __modelManager.managedCredentialFingerprint(initial);
    }
    return harness;
}

describe('Claude compatibility transport', () => {
    it('rewrites DSH attribution on the real wire without exposing another path', async () => {
        const ctx = credentialHarness().ctx;
        const request = vi.fn(
            async (target: URL, options: RequestInit & { body?: AsyncIterable<Uint8Array> }) => {
                let body = '';
                for await (const chunk of options.body ?? [])
                    body += Buffer.from(chunk).toString('utf8');
                const headers = new Headers(options.headers);
                expect(target.href).toBe('https://tokensapi.ai/v1/messages');
                expect(headers.get('user-agent')).toBe('claude-cli/2.1.0');
                expect(headers.get('x-api-key')).toBe('test-key');
                expect(headers.get('anthropic-version')).toBe('2023-06-01');
                expect(body).toBe('{"model":"claude-opus-5"}');
                return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
                    status: 200,
                    headers: {
                        'content-type': 'text/event-stream',
                        'request-id': 'safe-request-id',
                    },
                });
            },
        );

        // The wire test owns its HTTP client. Requests through the shared global
        // dispatcher outlive the test: an unread response keeps its connection,
        // and the pool later re-arms a keep-alive timer inside whichever test
        // runs next, which on Linux and macOS was a fake-timer test.
        const client = new Agent();
        const send = (url: string, init: RequestInit) =>
            undiciFetch(url, { ...init, dispatcher: client } as Parameters<typeof undiciFetch>[1]);
        try {
            const baseURL = await __modelManager.ensureClaudeProxy(ctx, request);
            const response = await send(`${baseURL}/v1/messages`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'user-agent': 'deepseek-harness/0.1.5-rc.2',
                    'x-api-key': 'test-key',
                    'anthropic-version': '2023-06-01',
                },
                body: '{"model":"claude-opus-5"}',
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('request-id')).toBe('safe-request-id');
            await expect(response.text()).resolves.toContain('message_stop');

            const refused = await send(`${baseURL}/v1/models`, { method: 'POST' });
            expect(refused.status).toBe(403);
            await refused.arrayBuffer();
            const spoofed = await send(
                `${baseURL.replace('/tokens/model-manager/claude-proxy', '/untrusted/prefix')}/v1/messages`,
                { method: 'POST' },
            );
            expect(spoofed.status).toBe(403);
            await spoofed.arrayBuffer();
            expect(request).toHaveBeenCalledTimes(1);
        } finally {
            await __modelManager.closeClaudeProxy(ctx);
            await client.close();
        }
    });
});

describe('offline fallback and complete catalog deadlines', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('serves entry GET from local state and only refreshes the primary catalog explicitly', async () => {
        const harness = credentialHarness('local-key', true);
        let handler: CallableFunction = () => {};
        __modelManager.registerModelManagerRoute(
            {
                webServer: {
                    register: (route: { handler: CallableFunction }) => {
                        handler = route.handler;
                    },
                },
            },
            harness.ctx,
        );
        const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        const read = async (url: string) => {
            let result: { authenticated?: boolean; modelListError?: string } = {};
            const req = Object.assign(new EventEmitter(), {
                method: 'GET',
                url,
                headers: { host: '127.0.0.1:43120' },
            });
            const res = Object.assign(new EventEmitter(), {
                writeHead: vi.fn(),
                end: (text: string) => {
                    result = JSON.parse(text);
                },
            });
            await handler(req, res);
            expect(req.listenerCount('aborted')).toBe(0);
            expect(res.listenerCount('close')).toBe(0);
            return result;
        };
        expect((await read('/tokens/model-manager')).authenticated).toBe(true);
        expect(request).not.toHaveBeenCalled();
        expect((await read('/tokens/model-manager?refresh=1')).modelListError).toBeTruthy();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('saves, switches both ways and restores saved fallback without contacting primary', async () => {
        const harness = credentialHarness('local-key', true);
        const request = vi.fn(async (url: string) => {
            expect(url).toBe('https://backup.example/v1/models');
            return { status: 200, json: async () => ({ data: [{ id: 'backup-chat' }] }) };
        });
        await __modelManager.configureFallback(
            harness.ctx,
            {
                baseURL: 'https://backup.example/v1',
                apiKey: 'backup-key',
                mainModel: 'backup-chat',
            },
            request,
        );
        const offline = vi.fn(() => {
            throw new Error('no network permitted');
        });
        expect((await __modelManager.switchToTokensAPI(harness.ctx, offline)).channel).toBe(
            'tokensapi',
        );
        expect((await __modelManager.switchToOfficial(harness.ctx, offline)).activeMainModel).toBe(
            'backup-chat',
        );
        expect(
            (
                await __modelManager.selectMainModel(
                    harness.ctx,
                    {
                        provider: 'modlens-tokens-fallback',
                        model: 'backup-chat',
                    },
                    offline,
                )
            ).activeMainModel,
        ).toBe('backup-chat');
        expect(offline).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledTimes(1);
        expect(harness.stored).toBe('local-key');
        expect(harness.official).toBe('backup-key');
    });

    for (const verified of [false, true]) {
        it(`rejects missing or mismatched local login (${verified}) before any fallback request`, async () => {
            const harness = credentialHarness('local-key', verified);
            if (verified) harness.verification = 'wrong-fingerprint';
            const request = vi.fn();
            for (const operation of [
                () =>
                    __modelManager.discoverFallback(harness.ctx, { apiKey: 'backup-key' }, request),
                () =>
                    __modelManager.configureFallback(
                        harness.ctx,
                        { apiKey: 'backup-key' },
                        request,
                    ),
                () => __modelManager.switchToOfficial(harness.ctx, request),
            ])
                await expect(operation()).rejects.toMatchObject({ code: 'unauthenticated' });
            expect(request).not.toHaveBeenCalled();
        });
    }

    it('keeps offline authentication but honors an explicit server rejection', async () => {
        const harness = credentialHarness('local-key', true);
        const offline = await __modelManager.modelManagerStatus(harness.ctx, async () => {
            throw new Error('offline');
        });
        expect(offline.authenticated).toBe(true);
        expect(offline.modelListError).toBeTruthy();
        const rejected = await __modelManager.modelManagerStatus(harness.ctx, async () => ({
            status: 403,
        }));
        expect(rejected.authenticated).toBe(false);
        await expect(
            __modelManager.discoverFallback(harness.ctx, { apiKey: 'backup-key' }, vi.fn()),
        ).rejects.toMatchObject({ code: 'unauthenticated' });
        expect(harness.stored).toBe('local-key');
    });

    it('discovers fallback with a verified local login and no primary catalog request', async () => {
        const harness = credentialHarness('local-key', true);
        const request = vi.fn(async (url: string) => {
            expect(url).toBe('https://backup.example/v1/models');
            return { status: 200, json: async () => ({ data: [{ id: 'backup-chat' }] }) };
        });
        const result = await __modelManager.discoverFallback(
            harness.ctx,
            {
                baseURL: 'https://backup.example/v1',
                apiKey: 'backup-key',
            },
            request,
        );
        expect(result.models).toEqual([{ id: 'backup-chat', name: 'backup-chat' }]);
        expect(request).toHaveBeenCalledTimes(1);
    });

    for (const primary of [true, false]) {
        const label = primary ? 'primary' : 'fallback';
        const validate = (request: unknown) =>
            primary
                ? __modelManager.validateManagedCredential('test-key', request)
                : __modelManager.validateFallbackCredential(
                      'test-key',
                      'https://backup.example/v1',
                      request,
                  );
        for (const status of [401, 403, 500, 503]) {
            it(`${label} preserves HTTP ${status} without reading its body`, async () => {
                const json = vi.fn();
                await expect(validate(async () => ({ status, json }))).rejects.toMatchObject({
                    code: status < 500 ? 'invalid_key' : 'upstream',
                });
                expect(json).not.toHaveBeenCalled();
            });
        }
        for (const payload of [
            { data: [] },
            {},
            { data: [{ id: 'video', supported_endpoint_types: ['video'] }] },
        ]) {
            it(`${label} rejects unsupported catalog ${JSON.stringify(payload)}`, async () => {
                await expect(
                    validate(async () => ({ status: 200, json: async () => payload })),
                ).rejects.toMatchObject({ code: 'upstream' });
            });
        }
        it(`${label} rejects invalid JSON and accepts normal catalogs`, async () => {
            await expect(
                validate(async () => ({
                    status: 200,
                    json: async () => {
                        throw new SyntaxError('secret');
                    },
                })),
            ).rejects.toMatchObject({ code: 'upstream' });
            expect(
                await validate(async () => ({
                    status: 200,
                    json: async () => ({ data: [{ id: 'chat' }] }),
                })),
            ).toEqual([expect.objectContaining({ id: 'chat' })]);
        });
        for (const [code, category] of [
            ['ENOTFOUND', 'dns'],
            ['ECONNRESET', 'connection'],
            ['CERT_HAS_EXPIRED', 'tls'],
            ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
        ]) {
            it(`${label} safely diagnoses ${code}`, async () => {
                const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
                await expect(
                    validate(async () => {
                        throw Object.assign(
                            new Error('Authorization Bearer SECRET https://bad/?api_key=SECRET'),
                            { cause: { code } },
                        );
                    }),
                ).rejects.toMatchObject({ code: 'unreachable' });
                const text = JSON.stringify(log.mock.calls);
                expect(text).toContain(category);
                expect(text).not.toMatch(/SECRET|Authorization|test-key|api_key/);
            });
        }
        it(`${label} cancels a stalled body and removes caller listeners`, async () => {
            vi.useFakeTimers();
            const controller = new AbortController();
            const remove = vi.spyOn(controller.signal, 'removeEventListener');
            const request = async () => ({ status: 200, json: () => new Promise(() => {}) });
            const result = (
                primary
                    ? __modelManager.validateManagedCredential(
                          'test-key',
                          request,
                          controller.signal,
                      )
                    : __modelManager.validateFallbackCredential(
                          'test-key',
                          'https://backup.example/v1',
                          request,
                          controller.signal,
                      )
            ).catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(0);
            controller.abort();
            expect(await result).toMatchObject({ code: 'unreachable' });
            expect(remove).toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        });
        for (const stage of ['headers', 'body']) {
            it(`${label} bounds stalled ${stage} even if fetch ignores abort`, async () => {
                vi.useFakeTimers();
                let signal: AbortSignal | undefined;
                const never = new Promise(() => {});
                const request = vi.fn((_url, options) => {
                    signal = options.signal;
                    return stage === 'headers'
                        ? never
                        : Promise.resolve({ status: 200, json: () => never });
                });
                const result = validate(request).catch((error: unknown) => error);
                await vi.advanceTimersByTimeAsync(20_001);
                expect(signal?.aborted).toBe(true);
                expect(
                    await Promise.race([result, Promise.resolve('still pending')]),
                ).toMatchObject({ code: 'unreachable' });
                expect(vi.getTimerCount()).toBe(0);
            });
        }
        it(`${label} distinguishes body transport failure from invalid JSON`, async () => {
            const broken = Object.assign(new TypeError('secret response'), {
                cause: { code: 'ECONNRESET' },
            });
            await expect(
                validate(async () => ({
                    status: 200,
                    json: async () => {
                        throw broken;
                    },
                })),
            ).rejects.toMatchObject({ code: 'unreachable' });
        });
    }
});

const API_MODELS = [
    {
        // The product default since 0.2.29. Its image support comes from the
        // plugin's own capability table (the catalogue declares no modalities).
        id: 'deepseek-v4-flash-vision-exp',
        name: 'DeepSeek V4 Flash Vision (Experimental)',
        ownedBy: 'deepseek',
        endpointTypes: ['openai', 'openai-response', 'anthropic'],
        contextWindow: 262144,
        maxTokens: 32768,
    },
    {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        ownedBy: 'deepseek',
        endpointTypes: ['openai', 'openai-response', 'anthropic'],
        contextWindow: 262144,
        maxTokens: 32768,
    },
    {
        id: 'qwen3.6-35b-a3b',
        name: 'Qwen 3.6 Vision',
        ownedBy: 'qwen',
        endpointTypes: ['openai', 'openai-response'],
    },
    {
        id: 'qwen3.8-flash-next',
        name: 'Qwen 3.8 Flash Next',
        ownedBy: 'qwen',
        endpointTypes: ['openai', 'openai-response'],
    },
    {
        id: 'deepseek-v3.2',
        name: 'DeepSeek V3.2',
        ownedBy: 'deepseek',
        endpointTypes: ['openai', 'openai-response'],
    },
    {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        ownedBy: 'vertex-ai',
        endpointTypes: ['anthropic', 'openai'],
    },
    {
        id: 'gpt-5.5',
        name: 'GPT 5.5',
        ownedBy: 'openai',
        endpointTypes: ['openai'],
    },
];

// gpt-* is listed by TokensAPI but kept out by default (allowGptModels: false);
// the tests that exercise its Responses-only route turn the switch on.
const PUBLIC_API_MODELS = gptAware(false);

function gptAware(allowGpt: boolean) {
    return API_MODELS.filter((model) => allowGpt || !model.id.startsWith('gpt-')).map(
        publicApiModel,
    );
}

function publicApiModel(model: (typeof API_MODELS)[number]) {
    const protocols = model.id.startsWith('claude-')
        ? [{ id: 'anthropic-messages', label: 'Anthropic Messages' }]
        : /^(?:gpt-|codex-)/i.test(model.id)
          ? [{ id: 'openai-responses', label: 'Responses API' }]
          : [
                { id: 'openai-completions', label: 'Chat Completions' },
                ...(model.endpointTypes.includes('openai-response')
                    ? [{ id: 'openai-responses', label: 'Responses API' }]
                    : []),
                ...(model.endpointTypes.includes('anthropic')
                    ? [{ id: 'anthropic-messages', label: 'Anthropic Messages' }]
                    : []),
            ];
    return {
        ...model,
        api: protocols[0].id,
        protocols,
        visionMode: [
            'deepseek-v4-flash-vision-exp',
            'qwen3.6-35b-a3b',
            'qwen3.8-flash-next',
            'claude-opus-4-7',
            'gpt-5.5',
        ].includes(model.id)
            ? 'native'
            : 'bridge',
        visionCapabilitySource: 'builtin',
    };
}

function directPublic(models: ReturnType<typeof gptAware>) {
    return models.map((model) => ({
        ...model,
        visionMode: model.visionMode === 'bridge' ? 'direct' : model.visionMode,
    }));
}

const VALID_RESPONSE = async () => ({
    status: 200,
    json: async () => ({
        data: API_MODELS.map((model) => ({
            id: model.id,
            name: model.name,
            owned_by: model.ownedBy,
            supported_endpoint_types: model.endpointTypes,
            context_window: model.contextWindow,
            max_output_tokens: model.maxTokens,
        })),
    }),
});

const VALID_RESPONSE_AND_PROTOCOL = async (
    _url?: URL | string,
    options?: Record<string, unknown>,
) => {
    if (options?.method === 'POST') {
        return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });
    }
    return VALID_RESPONSE();
};

const FUTURE_MODEL_ID = 'future-omni-2027';

function managedResponseWithFuture(inputModalities?: string[]) {
    return async () => ({
        status: 200,
        json: async () => ({
            data: [
                ...API_MODELS.map((model) => ({
                    id: model.id,
                    name: model.name,
                    owned_by: model.ownedBy,
                    supported_endpoint_types: model.endpointTypes,
                    context_window: model.contextWindow,
                    max_output_tokens: model.maxTokens,
                })),
                {
                    id: FUTURE_MODEL_ID,
                    name: 'Future Omni 2027',
                    owned_by: 'future-vendor',
                    supported_endpoint_types: ['openai'],
                    ...(inputModalities === undefined ? {} : { input_modalities: inputModalities }),
                },
            ],
        }),
    });
}

const FALLBACK_MODELS = [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    { id: 'custom-multimodal', name: 'Custom Multimodal' },
];

const FALLBACK_RESPONSE = async () => ({
    status: 200,
    json: async () => ({
        data: FALLBACK_MODELS.map((model) => ({ id: model.id, name: model.name })),
    }),
});

const VALID_KEYS = Array.from({ length: 50 }, (_, index) => {
    const serial = String(index + 1).padStart(2, '0');
    return {
        name: `valid business key ${serial}`,
        input: `  tk-live-${serial}-AbCdEf0123456789._-  `,
        stored: `tk-live-${serial}-AbCdEf0123456789._-`,
    };
});

const NON_STRING_VALUES: unknown[] = [
    undefined,
    null,
    0,
    1,
    -1,
    true,
    false,
    {},
    [],
    Symbol('key'),
];
const WHITESPACE_VALUES = ['', ' ', '  ', '\t', '\n', '\r', '\r\n', ' \t ', ' \n ', ' \r\n '];
const CONTROL_VALUES = Array.from(
    { length: 29 },
    (_, index) => `tk-live-${String.fromCharCode(index + 1)}-secret`,
);
const NEGATIVE_KEYS: Array<{ name: string; input: unknown }> = [
    ...NON_STRING_VALUES.map((input, index) => ({
        name: `non-string ${String(index + 1)}`,
        input,
    })),
    ...WHITESPACE_VALUES.map((input, index) => ({ name: `blank ${String(index + 1)}`, input })),
    ...CONTROL_VALUES.map((input, index) => ({
        name: `control character ${String(index + 1)}`,
        input,
    })),
    { name: 'oversized key', input: 'k'.repeat(513) },
];

describe('TokensAPI credential gate: 50 positive cases', () => {
    for (const testCase of VALID_KEYS) {
        it(testCase.name, async () => {
            const harness = credentialHarness();
            const status = await __modelManager.setManagedCredential(
                harness.ctx,
                testCase.input,
                VALID_RESPONSE,
            );
            expect(harness.stored).toBe(testCase.stored);
            expect(harness.verification).toBe(
                __modelManager.managedCredentialFingerprint(testCase.stored),
            );
            expect(status).toEqual({
                configured: true,
                authenticated: true,
                writable: true,
                provider: 'TokensAPI',
                channel: 'tokensapi',
                // The default reads images itself, so it takes the direct
                // route rather than the vision-bridge wrapper.
                mainModel: 'deepseek-v4-flash-vision-exp',
                api: 'openai-completions',
                mainProvider: 'tokensapi',
                activeMainModel: 'deepseek-v4-flash-vision-exp',
                visionMode: 'native',
                visionModel: 'qwen3.8-flash-next',
                models: PUBLIC_API_MODELS,
                modelsAvailable: true,
                baseURL: 'https://tokensapi.ai/v1',
                official: {
                    configured: false,
                    writable: true,
                    active: false,
                    provider: 'modlens-tokens-fallback',
                    upstreamProvider: 'tokens-fallback',
                    baseURL: 'https://api.deepseek.com',
                    mainModel: '',
                    models: [],
                    modelsChecked: false,
                },
            });
            expect(JSON.stringify(status)).not.toContain(testCase.stored);
        });
    }
});

describe('TokensAPI credential gate: 50 negative cases', () => {
    expect(NEGATIVE_KEYS).toHaveLength(50);
    for (const testCase of NEGATIVE_KEYS) {
        it(testCase.name, async () => {
            const harness = credentialHarness('previous-key-remains');
            await expect(
                __modelManager.setManagedCredential(harness.ctx, testCase.input),
            ).rejects.toThrow();
            expect(harness.stored).toBe('previous-key-remains');
        });
    }
});

describe('TokensAPI managed vision configuration', () => {
    it('uses the product default vision model when no model override is supplied', () => {
        expect(
            resolveProviderSettings(
                'openai',
                {},
                {
                    TOKENS_MODEL_MANAGER: '1',
                    TOKENSAPI_API_KEY: 'managed-key',
                },
            ),
        ).toEqual({
            apiKey: 'managed-key',
            baseUrl: 'https://tokensapi.ai/v1',
            model: 'qwen3.8-flash-next',
        });
    });

    it('uses the DSH-managed child-process facts instead of an existing ModLens file profile', () => {
        expect(
            resolveProviderSettings(
                'openai',
                {
                    providers: {
                        openai: {
                            apiKey: 'stale-file-key',
                            baseUrl: 'https://wrong.example/v1',
                            model: 'wrong-model',
                        },
                    },
                },
                {
                    TOKENS_MODEL_MANAGER: '1',
                    TOKENSAPI_API_KEY: 'managed-key',
                    TOKENSAPI_BASE_URL: 'https://tokensapi.ai/v1',
                    TOKENSAPI_VISION_MODEL: 'qwen3.6-35b-a3b',
                },
            ),
        ).toEqual({
            apiKey: 'managed-key',
            baseUrl: 'https://tokensapi.ai/v1',
            model: 'qwen3.6-35b-a3b',
        });
    });

    it('fails closed when managed mode has no key', () => {
        expect(resolveProviderSettings('openai', {}, { TOKENS_MODEL_MANAGER: '1' })).toEqual({});
    });

    it('does not start a vision subprocess for an unverified legacy key', async () => {
        const harness = credentialHarness('legacy-unverified-key');
        await expect(
            __modelManager.runManagedVision(harness.ctx, [], undefined),
        ).rejects.toMatchObject({ code: 'TOKENSAPI_MISSING_CREDENTIAL' });
    });

    it('never exposes a stored key in status', async () => {
        const harness = credentialHarness('super-secret-key', true);
        const status = await __modelManager.modelManagerStatus(harness.ctx, VALID_RESPONSE);
        expect(status.configured).toBe(true);
        expect(status.authenticated).toBe(true);
        expect(JSON.stringify(status)).not.toContain('super-secret-key');
        expect(status).not.toHaveProperty('apiKey');
    });
});

describe('independent fallback route', () => {
    it('stores the official key independently and never returns it in status', async () => {
        const harness = credentialHarness('tk-primary', true);
        const status = await __modelManager.setOfficialCredential(
            harness.ctx,
            '  sk-deepseek-official  ',
            VALID_RESPONSE,
        );
        expect(harness.stored).toBe('tk-primary');
        expect(harness.official).toBe('sk-deepseek-official');
        expect(status.official).toMatchObject({ configured: true, active: false });
        expect(JSON.stringify(status)).not.toContain('sk-deepseek-official');
    });

    it('reveals the official key only through the explicit action', async () => {
        const harness = credentialHarness('tk-primary', true);
        harness.official = 'sk-deepseek-reveal';
        await expect(__modelManager.revealOfficialCredential(harness.ctx)).resolves.toEqual({
            apiKey: 'sk-deepseek-reveal',
        });
        harness.official = undefined;
        await expect(__modelManager.revealOfficialCredential(harness.ctx)).rejects.toMatchObject({
            code: 'unauthenticated',
        });
    });

    it('discovers the real model catalog with the entered key without persisting or switching', async () => {
        const harness = credentialHarness('tk-login-stays', true);
        const requests: Array<{ url: string; authorization: string }> = [];
        const request = async (url: unknown, init?: { headers?: { authorization?: string } }) => {
            if (String(url) === `${TOKENSAPI.baseURL}/models`) return VALID_RESPONSE();
            requests.push({
                url: String(url),
                authorization: String(init?.headers?.authorization ?? ''),
            });
            return FALLBACK_RESPONSE();
        };

        await expect(
            __modelManager.discoverFallback(
                harness.ctx,
                {
                    baseURL: 'https://backup.example/v1/',
                    apiKey: 'sk-unsaved-backup',
                },
                request,
            ),
        ).resolves.toEqual({
            baseURL: 'https://backup.example/v1',
            models: FALLBACK_MODELS,
        });
        expect(requests).toEqual([
            {
                url: 'https://backup.example/v1/models',
                authorization: 'Bearer sk-unsaved-backup',
            },
        ]);
        expect(harness.stored).toBe('tk-login-stays');
        expect(harness.official).toBeUndefined();
        await expect(
            __modelManager.modelManagerStatus(harness.ctx, VALID_RESPONSE),
        ).resolves.toMatchObject({
            channel: 'tokensapi',
            mainProvider: TOKENSAPI.providerId,
            official: {
                baseURL: DEEPSEEK_OFFICIAL.baseURL,
                mainModel: '',
                models: [],
            },
        });
    });

    it('uses the saved fallback key to discover models without exposing or replacing it', async () => {
        const harness = credentialHarness('tk-primary', true);
        harness.official = 'sk-saved-backup';
        const requests: Array<{ url: string; authorization: string }> = [];
        const request = async (url: unknown, init?: { headers?: { authorization?: string } }) => {
            if (String(url) === `${TOKENSAPI.baseURL}/models`) return VALID_RESPONSE();
            requests.push({
                url: String(url),
                authorization: String(init?.headers?.authorization ?? ''),
            });
            return FALLBACK_RESPONSE();
        };

        await expect(
            __modelManager.discoverFallback(
                harness.ctx,
                { baseURL: 'https://saved-backup.example/v1' },
                request,
            ),
        ).resolves.toEqual({
            baseURL: 'https://saved-backup.example/v1',
            models: FALLBACK_MODELS,
        });
        expect(requests).toEqual([
            {
                url: 'https://saved-backup.example/v1/models',
                authorization: 'Bearer sk-saved-backup',
            },
        ]);
        expect(harness.stored).toBe('tk-primary');
        expect(harness.official).toBe('sk-saved-backup');
    });

    it('refuses model discovery when no fallback key is available', async () => {
        const harness = credentialHarness('tk-primary', true);
        await expect(
            __modelManager.discoverFallback(
                harness.ctx,
                { baseURL: 'https://backup.example/v1' },
                VALID_RESPONSE,
            ),
        ).rejects.toMatchObject({ code: 'unauthenticated' });
        expect(harness.stored).toBe('tk-primary');
        expect(harness.official).toBeUndefined();
    });

    for (const testCase of [
        {
            name: 'an unauthorized endpoint',
            code: 'invalid_key',
            response: async () => ({ status: 401, json: async () => ({}) }),
        },
        {
            name: 'an unavailable endpoint',
            code: 'upstream',
            response: async () => ({ status: 503, json: async () => ({}) }),
        },
        {
            name: 'a malformed model response',
            code: 'upstream',
            response: async () => ({
                status: 200,
                json: async () => {
                    throw new SyntaxError('invalid JSON');
                },
            }),
        },
        {
            name: 'an empty model response',
            code: 'upstream',
            response: async () => ({ status: 200, json: async () => ({ data: [] }) }),
        },
    ]) {
        it(`keeps both routes unchanged after ${testCase.name}`, async () => {
            const harness = credentialHarness('tk-primary', true);
            harness.official = 'sk-existing-backup';
            const request = async (url: unknown) =>
                String(url) === `${TOKENSAPI.baseURL}/models`
                    ? VALID_RESPONSE()
                    : testCase.response();

            await expect(
                __modelManager.discoverFallback(
                    harness.ctx,
                    {
                        baseURL: 'https://broken.example/v1',
                        apiKey: 'sk-replacement-not-saved',
                    },
                    request,
                ),
            ).rejects.toMatchObject({ code: testCase.code });
            expect(harness.stored).toBe('tk-primary');
            expect(harness.official).toBe('sk-existing-backup');
            await expect(
                __modelManager.modelManagerStatus(harness.ctx, VALID_RESPONSE),
            ).resolves.toMatchObject({
                channel: 'tokensapi',
                mainProvider: TOKENSAPI.providerId,
                official: {
                    baseURL: DEEPSEEK_OFFICIAL.baseURL,
                    mainModel: '',
                },
            });
        });
    }

    it('refuses to switch before an official key is stored', async () => {
        const harness = credentialHarness('tk-primary', true);
        await expect(
            __modelManager.switchToOfficial(harness.ctx, VALID_RESPONSE),
        ).rejects.toMatchObject({ code: 'unauthenticated' });
        await expect(
            __modelManager.modelManagerStatus(harness.ctx, VALID_RESPONSE),
        ).resolves.toMatchObject({
            channel: 'tokensapi',
            mainProvider: TOKENSAPI.providerId,
        });
    });

    it('refuses to switch before a fallback model has been discovered and selected', async () => {
        const harness = credentialHarness('tk-primary', true);
        harness.official = 'sk-deepseek';
        await expect(
            __modelManager.switchToOfficial(harness.ctx, VALID_RESPONSE),
        ).rejects.toMatchObject({ code: 'invalid_model' });
        await expect(
            __modelManager.modelManagerStatus(harness.ctx, VALID_RESPONSE),
        ).resolves.toMatchObject({
            channel: 'tokensapi',
            mainProvider: TOKENSAPI.providerId,
        });
    });

    it('keeps the TokensAPI sign-in gate mandatory for the official fallback', async () => {
        const harness = credentialHarness();
        harness.official = 'sk-deepseek';
        await expect(
            __modelManager.switchToOfficial(harness.ctx, VALID_RESPONSE),
        ).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('configures an independent endpoint, model, and key without touching the login key', async () => {
        const harness = credentialHarness('tk-login-stays', true);
        const requests: Array<{ url: string; authorization: string }> = [];
        const request = async (url: unknown, init?: { headers?: { authorization?: string } }) => {
            requests.push({
                url: String(url),
                authorization: String(init?.headers?.authorization ?? ''),
            });
            return VALID_RESPONSE();
        };
        const status = await __modelManager.configureFallback(
            harness.ctx,
            {
                baseURL: 'https://backup.example/v1/',
                mainModel: 'deepseek-v3.2',
                apiKey: 'sk-backup-only',
            },
            request,
        );

        expect(harness.stored).toBe('tk-login-stays');
        expect(harness.official).toBe('sk-backup-only');
        expect(requests).toContainEqual({
            url: 'https://backup.example/v1/models',
            authorization: 'Bearer sk-backup-only',
        });
        expect(status).toMatchObject({
            channel: 'official',
            activeMainModel: 'deepseek-v3.2',
            mainProvider: 'modlens-tokens-fallback',
            official: {
                active: true,
                baseURL: 'https://backup.example/v1',
                mainModel: 'deepseek-v3.2',
                configured: true,
            },
        });
        expect(JSON.stringify(status)).not.toContain('sk-backup-only');
        expect(JSON.stringify(status)).not.toContain('tk-login-stays');
    });

    it('uses the bundled llm-pi-ai namespace when llm-deepseek is not installed', async () => {
        const credential = credentialHarness('tk-primary', true);
        const registered = new Set<string>([TOKENSAPI.llmSettingsNamespace]);
        const values = new Map<string, Record<string, unknown>>([
            [
                TOKENSAPI.llmSettingsNamespace,
                {
                    providers: {
                        [DEEPSEEK_OFFICIAL.upstreamProviderId]: {
                            displayName: 'stale fallback from the previous run',
                        },
                    },
                },
            ],
        ]);
        const updates: Array<{ namespace: string; patch: Record<string, unknown> }> = [];
        const mutations: Array<{
            namespace: string;
            operations: Array<{ op: string; path: string[] }>;
        }> = [];
        const fallbackProvider = () => {
            const providers = values.get(TOKENSAPI.llmSettingsNamespace)?.providers;
            return (
                typeof providers === 'object' && providers !== null
                    ? (providers as Record<string, unknown>)
                    : {}
            )[DEEPSEEK_OFFICIAL.upstreamProviderId];
        };
        const settings = {
            register: (
                namespace: string,
                _schema: unknown,
                options?: { base?: Record<string, unknown> },
            ) => {
                registered.add(namespace);
                if (!values.has(namespace)) values.set(namespace, { ...(options?.base ?? {}) });
                return { get: () => values.get(namespace) };
            },
            get: (namespace: string) => values.get(namespace),
            update: async (namespace: string, patch: Record<string, unknown>) => {
                if (!registered.has(namespace)) {
                    throw new Error(`settings namespace "${namespace}" is not registered`);
                }
                updates.push({ namespace, patch });
                const previous = values.get(namespace) ?? {};
                const next = { ...previous, ...patch };
                if (
                    typeof previous.providers === 'object' &&
                    previous.providers !== null &&
                    typeof patch.providers === 'object' &&
                    patch.providers !== null
                ) {
                    next.providers = {
                        ...(previous.providers as Record<string, unknown>),
                        ...(patch.providers as Record<string, unknown>),
                    };
                }
                values.set(namespace, next);
            },
            mutate: async (
                namespace: string,
                operations: Array<{ op: string; path: string[] }>,
            ) => {
                if (!registered.has(namespace)) {
                    throw new Error(`settings namespace "${namespace}" is not registered`);
                }
                mutations.push({ namespace, operations });
                const current = values.get(namespace) ?? {};
                const providers = {
                    ...((current.providers as Record<string, unknown> | undefined) ?? {}),
                };
                for (const operation of operations) {
                    if (
                        operation.op === 'unset' &&
                        operation.path[0] === 'providers' &&
                        operation.path[1]
                    ) {
                        delete providers[operation.path[1]];
                    }
                }
                values.set(namespace, { ...current, providers });
            },
        };
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.includes('settings')) callback({ settings });
            },
        };
        apply(ctx, { visionProvider: false, settingsCard: false, pasteToPath: false });

        await expect(__modelManager.modelManagerStatus(ctx, VALID_RESPONSE)).resolves.toMatchObject(
            { channel: 'tokensapi' },
        );
        expect(fallbackProvider()).toBeUndefined();

        await expect(
            __modelManager.configureFallback(
                ctx,
                {
                    baseURL: 'https://backup.example/v1/',
                    mainModel: 'deepseek-v3.2',
                    apiKey: 'sk-backup-only',
                },
                VALID_RESPONSE,
            ),
        ).resolves.toMatchObject({
            channel: 'official',
            mainProvider: DEEPSEEK_OFFICIAL.providerId,
        });
        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            activeChannel: 'official',
        });

        expect(updates.some((entry) => entry.namespace === 'llm-deepseek')).toBe(false);
        const fallbackUpdate = [...updates]
            .reverse()
            .find(
                (entry) =>
                    entry.namespace === TOKENSAPI.llmSettingsNamespace &&
                    (entry.patch.providers as Record<string, unknown> | undefined)?.[
                        DEEPSEEK_OFFICIAL.upstreamProviderId
                    ] !== undefined,
            );
        expect(fallbackUpdate?.patch).toMatchObject({
            providers: {
                [DEEPSEEK_OFFICIAL.upstreamProviderId]: {
                    displayName: '备用线路',
                    apiKeyEnv: DEEPSEEK_OFFICIAL.credentialRef,
                    api: 'openai-completions',
                    baseURL: 'https://backup.example/v1',
                    models: expect.arrayContaining([
                        expect.objectContaining({ id: 'deepseek-v3.2', input: ['text'] }),
                    ]),
                },
            },
        });
        // TokensAPI lists gpt-5.5, but it is kept out by default (allowGptModels).
        const routeProviders = fallbackUpdate?.patch.providers as
            | Record<string, { models: Array<{ id: string }> }>
            | undefined;
        const routeModels = routeProviders?.[DEEPSEEK_OFFICIAL.upstreamProviderId]?.models ?? [];
        expect(routeModels.map((model) => model.id)).toContain('deepseek-v3.2');
        expect(routeModels.map((model) => model.id)).not.toContain('gpt-5.5');
        expect(credential.stored).toBe('tk-primary');
        expect(credential.official).toBe('sk-backup-only');

        await expect(__modelManager.switchToTokensAPI(ctx, VALID_RESPONSE)).resolves.toMatchObject({
            channel: 'tokensapi',
            mainProvider: TOKENSAPI.providerId,
            official: { active: false, configured: true },
        });
        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            activeChannel: 'tokensapi',
        });
        expect(fallbackProvider()).toBeUndefined();
        expect(mutations).toContainEqual({
            namespace: TOKENSAPI.llmSettingsNamespace,
            operations: [
                {
                    op: 'unset',
                    path: ['providers', DEEPSEEK_OFFICIAL.upstreamProviderId],
                },
            ],
        });

        await expect(__modelManager.switchToOfficial(ctx, VALID_RESPONSE)).resolves.toMatchObject({
            channel: 'official',
            mainProvider: DEEPSEEK_OFFICIAL.providerId,
        });
        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            activeChannel: 'official',
        });
        expect(fallbackProvider()).toMatchObject({
            displayName: '备用线路',
            baseURL: 'https://backup.example/v1',
        });
    });

    it('writes the LLM route through DSH 0.2 profile settings, which have no namespace registry', async () => {
        // DSH 0.2 removed settings.register/get. Live settings are volatile
        // fields of profile entries: written with update(entryId, patch), read
        // back through describe(). Before this branch existed the manager got no
        // settings handle on 0.2, so every route write was silently skipped.
        const credential = credentialHarness('tk-dsh02', true);
        const profile = new Map<string, Record<string, unknown>>([
            ['agent-default-model', { provider: TOKENSAPI.providerId, model: 'deepseek-v3.2' }],
            ['llm-pi-ai', { providers: {} }],
        ]);
        const writes: Array<{ ns: string; patch: Record<string, unknown> }> = [];
        const settings = {
            describe: () => [...profile].map(([ns, value]) => ({ ns, value })),
            update: async (ns: string, patch: Record<string, unknown>) => {
                writes.push({ ns, patch });
                profile.set(ns, { ...(profile.get(ns) ?? {}), ...patch });
            },
            mutate: async () => {},
        };
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.length === 1 && services[0] === 'settings') callback({ settings });
            },
        };
        apply(ctx, { allowGptModels: true, settingsCard: false, pasteToPath: false });
        // Route writes run in the background, and a Claude route also starts the
        // loopback proxy (real I/O), so let the event loop turn, not just microtasks.
        const settle = async () => {
            for (let index = 0; index < 10; index++)
                await new Promise((resolve) => setTimeout(resolve, 5));
        };
        await settle();

        const routeWrites = () =>
            writes.filter((entry) => entry.ns === TOKENSAPI.llmSettingsNamespace);
        type RoutePatch = {
            providers: Record<string, { api: string; models: Array<{ id: string }> }>;
        };
        const lastRoute = () => {
            const patch = routeWrites().at(-1)?.patch as RoutePatch | undefined;
            if (!patch) throw new Error('no route write reached the settings service');
            return patch.providers[TOKENSAPI.providerId];
        };
        // Startup restored the Host's persisted default instead of overwriting it.
        expect(routeWrites().length).toBeGreaterThan(0);
        expect(lastRoute().models[0]?.id).toBe('deepseek-v3.2');

        await __modelManager.selectMainModel(
            ctx,
            { provider: TOKENSAPI.agentProviderId, model: 'claude-opus-4-7' },
            VALID_RESPONSE,
        );
        await settle();
        // The route now carries every managed model and speaks the new protocol.
        expect(lastRoute().api).toBe('anthropic-messages');
        expect(lastRoute().models.map((model) => model.id)).toEqual(
            expect.arrayContaining(['claude-opus-4-7', 'gpt-5.5', 'deepseek-v3.2']),
        );
        // The plugin's own choices have no profile entry on 0.2, so they never
        // reach the Host settings service (which would reject them).
        expect(writes.some((entry) => entry.ns === TOKENSAPI.settingsNamespace)).toBe(false);

        // A route write costs about a second on 0.2 and holds the picker, so it
        // happens only when the route changes: switching protocol writes...
        await __modelManager.selectMainModel(
            ctx,
            { provider: TOKENSAPI.agentProviderId, model: 'qwen3.6-35b-a3b' },
            VALID_RESPONSE,
        );
        await settle();
        expect(lastRoute().api).toBe('openai-completions');
        const writesAfterSwitch = routeWrites().length;
        // ...while another model of the same protocol leaves the route as it is.
        await __modelManager.selectMainModel(
            ctx,
            { provider: TOKENSAPI.agentProviderId, model: 'qwen3.8-flash-next' },
            VALID_RESPONSE,
        );
        await settle();
        expect(routeWrites().length).toBe(writesAfterSwitch);
    });

    it('switches the route in the background on DSH 0.2 and holds model calls until it lands', async () => {
        const credential = credentialHarness('tk-dsh02-bg', true);
        const profile = new Map<string, Record<string, unknown>>([
            ['agent-default-model', { provider: TOKENSAPI.providerId, model: 'deepseek-v3.2' }],
            ['llm-pi-ai', { providers: {} }],
        ]);
        type RouteWrite = {
            api: string;
            resolve: () => void;
            reject: (error: Error) => void;
        };
        const pending: RouteWrite[] = [];
        const landed: string[] = [];
        let holdWrites = false;
        const settings = {
            describe: () => [...profile].map(([ns, value]) => ({ ns, value })),
            update: (ns: string, patch: Record<string, unknown>) => {
                const apply = () => profile.set(ns, { ...(profile.get(ns) ?? {}), ...patch });
                const route = (patch as { providers?: Record<string, { api: string }> })
                    .providers?.[TOKENSAPI.providerId];
                if (!holdWrites || !route) {
                    apply();
                    return Promise.resolve();
                }
                return new Promise<void>((resolve, reject) => {
                    pending.push({
                        api: route.api,
                        resolve: () => {
                            apply();
                            landed.push(route.api);
                            resolve();
                        },
                        reject,
                    });
                });
            },
            mutate: async () => {},
        };
        let gate:
            | ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>)
            | undefined;
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            on: (name: string, listener: typeof gate) => {
                if (name === 'llm/stream') gate = listener;
            },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.length === 1 && services[0] === 'settings') callback({ settings });
            },
        };
        apply(ctx, { allowGptModels: true, settingsCard: false, pasteToPath: false });
        // Route writes run in the background, and a Claude route also starts the
        // loopback proxy (real I/O), so let the event loop turn, not just microtasks.
        const settle = async () => {
            for (let index = 0; index < 10; index++)
                await new Promise((resolve) => setTimeout(resolve, 5));
        };
        await settle();
        // Load the full catalog through one ordinary pick before holding writes.
        await __modelManager.selectMainModel(
            ctx,
            { provider: TOKENSAPI.agentProviderId, model: 'qwen3.6-35b-a3b' },
            VALID_RESPONSE,
        );
        await settle();
        if (!gate) throw new Error('the llm/stream gate was not registered');
        holdWrites = true;

        // 1. Selecting answers before the slow route write has finished.
        const status = await __modelManager.selectMainModel(
            ctx,
            { provider: TOKENSAPI.agentProviderId, model: 'claude-opus-4-7' },
            VALID_RESPONSE,
        );
        expect(status).toMatchObject({ mainModel: 'claude-opus-4-7' });
        await settle();
        expect(pending.map((write) => write.api)).toEqual(['anthropic-messages']);

        // 2. A model call made now waits for the write, then dispatches.
        const order: string[] = [];
        const call = (async () => {
            const chunks: unknown[] = [];
            for await (const chunk of gate(
                { provider: TOKENSAPI.providerId, model: 'claude-opus-4-7' },
                () =>
                    (async function* () {
                        order.push(`dispatched after ${landed.join(',') || 'nothing'}`);
                        yield { type: 'text-delta' };
                    })(),
            )) {
                chunks.push(chunk);
            }
            return chunks;
        })();
        await settle();
        expect(order).toEqual([]);

        // 3. Rapid picks: B is replaced by C while A is still being written.
        await __modelManager.selectMainModel(
            ctx,
            { provider: TOKENSAPI.agentProviderId, model: 'gpt-5.5' },
            VALID_RESPONSE,
        );
        await __modelManager.selectMainModel(
            ctx,
            { provider: TOKENSAPI.agentProviderId, model: 'qwen3.8-flash-next' },
            VALID_RESPONSE,
        );
        pending.shift()?.resolve();
        await settle();
        // Only the last choice is written next; the intermediate one is dropped.
        expect(pending.map((write) => write.api)).toEqual(['openai-completions']);
        pending.shift()?.resolve();
        await settle();
        expect(landed).toEqual(['anthropic-messages', 'openai-completions']);
        expect(order).toEqual(['dispatched after anthropic-messages,openai-completions']);
        expect(await call).toEqual([{ type: 'text-delta' }]);

        // 4. A failed background write rolls back and is reported, never silent.
        await __modelManager.selectMainModel(
            ctx,
            { provider: TOKENSAPI.agentProviderId, model: 'claude-opus-4-7' },
            VALID_RESPONSE,
        );
        await settle();
        pending.shift()?.reject(new Error('profile write refused'));
        await settle();
        const failed: unknown[] = [];
        for await (const chunk of gate(
            { provider: TOKENSAPI.providerId, model: 'claude-opus-4-7' },
            () =>
                (async function* () {
                    yield { type: 'text-delta' };
                })(),
        )) {
            failed.push(chunk);
        }
        expect(failed).toEqual([
            {
                type: 'finish',
                reason: {
                    kind: 'error',
                    failure: {
                        code: 'INVALID_CONFIG',
                        message: expect.stringContaining('profile write refused'),
                    },
                },
            },
        ]);
        expect(
            String(
                (failed[0] as { reason: { failure: { message: string } } }).reason.failure.message,
            ),
        ).toContain('qwen3.8-flash-next');
        // The manager is back on the last route that did persist.
        expect(
            await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE, { refreshModels: false }),
        ).toMatchObject({
            mainModel: 'qwen3.8-flash-next',
        });
    });

    it('persists a TokensAPI model chosen from the conversation selector', async () => {
        const harness = credentialHarness('tk-primary', true);
        await expect(
            __modelManager.selectMainModel(
                harness.ctx,
                { provider: TOKENSAPI.agentProviderId, model: 'deepseek-v3.2' },
                VALID_RESPONSE,
            ),
        ).resolves.toMatchObject({
            channel: 'tokensapi',
            mainModel: 'deepseek-v3.2',
            activeMainModel: 'deepseek-v3.2',
            mainProvider: TOKENSAPI.agentProviderId,
        });
    });

    it('updates only the active fallback model when its conversation group is selected', async () => {
        const harness = credentialHarness('tk-primary', true);
        const request = async (url: unknown) =>
            String(url) === `${TOKENSAPI.baseURL}/models` ? VALID_RESPONSE() : FALLBACK_RESPONSE();
        harness.official = 'sk-fallback';
        await __modelManager.configureFallback(
            harness.ctx,
            { baseURL: 'https://backup.example/v1', mainModel: 'deepseek-chat' },
            request,
        );

        await expect(
            __modelManager.selectMainModel(
                harness.ctx,
                { provider: DEEPSEEK_OFFICIAL.providerId, model: 'deepseek-reasoner' },
                request,
            ),
        ).resolves.toMatchObject({
            channel: 'official',
            mainModel: 'deepseek-v4-flash-vision-exp',
            activeMainModel: 'deepseek-reasoner',
            mainProvider: DEEPSEEK_OFFICIAL.providerId,
            official: { mainModel: 'deepseek-reasoner' },
        });
    });

    it('restores the saved fallback channel before the initial model is displayed', async () => {
        const credential = credentialHarness('tk-primary', true);
        credential.official = 'sk-fallback';
        const selections: Array<{ provider: string; model: string }> = [];
        const values = new Map<string, Record<string, unknown>>([
            [
                TOKENSAPI.settingsNamespace,
                {
                    baseURL: TOKENSAPI.baseURL,
                    mainModel: 'deepseek-v4-flash',
                    visionModel: TOKENSAPI.visionModel,
                    fallbackBaseURL: 'https://api.deepseek.com',
                    fallbackModel: 'deepseek-v4-pro',
                    activeChannel: 'official',
                },
            ],
            [TOKENSAPI.llmSettingsNamespace, { providers: {} }],
        ]);
        const settings = {
            register: (
                namespace: string,
                _schema: unknown,
                options?: { base?: Record<string, unknown> },
            ) => {
                if (!values.has(namespace)) values.set(namespace, { ...(options?.base ?? {}) });
                return { get: () => values.get(namespace) };
            },
            get: (namespace: string) => values.get(namespace),
            update: async (namespace: string, patch: Record<string, unknown>) => {
                const previous = values.get(namespace) ?? {};
                const next = { ...previous, ...patch };
                if (
                    typeof previous.providers === 'object' &&
                    previous.providers !== null &&
                    typeof patch.providers === 'object' &&
                    patch.providers !== null
                ) {
                    next.providers = {
                        ...(previous.providers as Record<string, unknown>),
                        ...(patch.providers as Record<string, unknown>),
                    };
                }
                values.set(namespace, next);
            },
        };
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.includes('settings')) callback({ settings });
                if (services.includes('agentDefaultModel')) {
                    callback({
                        agentDefaultModel: {
                            saveSelection: async (selection: {
                                provider: string;
                                model: string;
                            }) => {
                                selections.push(selection);
                            },
                        },
                    });
                }
            },
        };

        apply(ctx, { visionProvider: false, settingsCard: false, pasteToPath: false });
        // The fallback endpoint still offers the saved model.
        const request = async (url: unknown) =>
            String(url) === `${TOKENSAPI.baseURL}/models`
                ? VALID_RESPONSE()
                : {
                      status: 200,
                      json: async () => ({
                          data: [{ id: 'deepseek-chat' }, { id: 'deepseek-v4-pro' }],
                      }),
                  };
        const status = await __modelManager.modelManagerStatus(ctx, request);
        await Promise.resolve();

        expect(status).toMatchObject({
            channel: 'official',
            activeMainModel: 'deepseek-v4-pro',
            mainProvider: DEEPSEEK_OFFICIAL.providerId,
            official: {
                active: true,
                mainModel: 'deepseek-v4-pro',
            },
        });
        expect(values.get(TOKENSAPI.llmSettingsNamespace)).toMatchObject({
            providers: {
                [DEEPSEEK_OFFICIAL.upstreamProviderId]: {
                    displayName: '备用线路',
                    baseURL: 'https://api.deepseek.com',
                    models: [{ id: 'deepseek-v4-pro' }],
                },
            },
        });
        expect(selections.at(-1)).toEqual({
            provider: DEEPSEEK_OFFICIAL.providerId,
            model: 'deepseek-v4-pro',
        });
    });

    it('does not replace the backup key or route when endpoint validation fails', async () => {
        const harness = credentialHarness('tk-login-stays', true);
        harness.official = 'sk-previous-backup';
        const request = async (url: unknown) =>
            String(url) === `${TOKENSAPI.baseURL}/models`
                ? VALID_RESPONSE()
                : { status: 401, json: async () => ({}) };
        await expect(
            __modelManager.configureFallback(
                harness.ctx,
                {
                    baseURL: 'https://broken.example/v1',
                    mainModel: 'deepseek-v4-flash',
                    apiKey: 'sk-invalid-replacement',
                },
                request,
            ),
        ).rejects.toMatchObject({ code: 'invalid_key' });
        expect(harness.stored).toBe('tk-login-stays');
        expect(harness.official).toBe('sk-previous-backup');
        await expect(
            __modelManager.modelManagerStatus(harness.ctx, request),
        ).resolves.toMatchObject({
            channel: 'tokensapi',
            official: {
                baseURL: DEEPSEEK_OFFICIAL.baseURL,
                mainModel: DEEPSEEK_OFFICIAL.mainModel,
            },
        });
    });

    it('switches chat to the official vision wrapper and restores the parked TokensAPI route', async () => {
        const harness = credentialHarness('tk-primary', true);
        await __modelManager.modelManagerStatus(harness.ctx, VALID_RESPONSE);
        await __modelManager.setManagedModels(
            harness.ctx,
            { mainModel: 'deepseek-v3.2', visionModel: 'qwen3.6-35b-a3b' },
            VALID_RESPONSE,
        );
        await __modelManager.configureFallback(
            harness.ctx,
            {
                baseURL: DEEPSEEK_OFFICIAL.baseURL,
                mainModel: 'deepseek-v3.2',
                apiKey: 'sk-deepseek',
            },
            VALID_RESPONSE,
        );
        await __modelManager.switchToTokensAPI(harness.ctx, VALID_RESPONSE);

        const official = await __modelManager.switchToOfficial(harness.ctx, VALID_RESPONSE);
        expect(official).toMatchObject({
            channel: 'official',
            mainModel: 'deepseek-v3.2',
            activeMainModel: 'deepseek-v3.2',
            mainProvider: DEEPSEEK_OFFICIAL.providerId,
            visionModel: 'qwen3.6-35b-a3b',
            official: { active: true, configured: true },
        });

        const restored = await __modelManager.switchToTokensAPI(harness.ctx, VALID_RESPONSE);
        expect(restored).toMatchObject({
            channel: 'tokensapi',
            mainModel: 'deepseek-v3.2',
            activeMainModel: 'deepseek-v3.2',
            mainProvider: TOKENSAPI.agentProviderId,
            official: { active: false, configured: true },
        });
    });

    for (const value of ['', ' ', '\t', 'x'.repeat(513)]) {
        it(`rejects an invalid official key: ${JSON.stringify(value).slice(0, 40)}`, async () => {
            const harness = credentialHarness('tk-primary', true);
            await expect(
                __modelManager.setOfficialCredential(harness.ctx, value, VALID_RESPONSE),
            ).rejects.toThrow();
            expect(harness.official).toBeUndefined();
        });
    }
});

describe('manager settings persistence on DSH 0.2', () => {
    const requireTest = createRequire(import.meta.url);
    // The schemastery each product line ships: DSH 0.1 (TokensCowork 0.5) and
    // DSH 0.2 (TokensCowork 0.6). Both are the real published packages.
    const dsh01 = () => requireTest('schemastery-dsh01');
    const dsh02 = () => requireTest('@deepseek-ai/schemastery');
    const ENTRY = {
        upstream: 'tokensapi',
        providerId: 'modlens-tokensapi',
        settingsCard: false,
        pasteToPath: false,
    };
    type Section = Record<string, unknown>;

    /** A DSH 0.2 profile: entries validated through the plugin Config on start. */
    function dsh02Profile(initial: Record<string, Section> = {}, documentPath = '') {
        const profile = new Map<string, Section>(
            Object.entries({
                'agent-default-model': { provider: TOKENSAPI.providerId, model: 'deepseek-v3.2' },
                'llm-pi-ai': { providers: {} },
                ...initial,
            }),
        );
        const replaced: Section[] = [];
        const settings = {
            documentPath,
            describe: () => [...profile].map(([ns, value]) => ({ ns, value })),
            update: async (ns: string, patch: Section) => {
                profile.set(ns, { ...(profile.get(ns) ?? {}), ...patch });
            },
            replace: async (ns: string, section: Section) => {
                replaced.push(JSON.parse(JSON.stringify(section)));
                profile.set(ns, JSON.parse(JSON.stringify(section)));
            },
            mutate: async () => {},
            configure: () => () => {},
        };
        // What the Loader hands apply(): the entry config validated by Config.
        const start = () => {
            const validated = (
                Config as { '~standard': { validate: (value: unknown) => { value: Section } } }
            )['~standard'].validate({
                ...ENTRY,
                ...(profile.get(TOKENSAPI.settingsNamespace) ?? {}),
            }).value;
            const credential = credentialHarness('tk-persist', true);
            const ctx = {
                ...credential.ctx,
                tools: { register: () => {} },
                inject: (
                    services: string[],
                    callback: (scope: Record<string, unknown>) => void,
                ) => {
                    if (services.length === 1 && services[0] === 'settings') callback({ settings });
                },
            };
            apply(ctx, { ...validated, settingsCard: false, pasteToPath: false });
            return ctx;
        };
        return { profile, replaced, settings, start };
    }
    const settle = async () => {
        for (let index = 0; index < 10; index++)
            await new Promise((resolve) => setTimeout(resolve, 5));
    };

    it('declares a volatile Config only where the Host schemastery supports it', () => {
        // DSH 0.1: no volatile(), so no Config; its Loader then behaves as before.
        expect(volatileSchemastery(dsh01)).toBeNull();
        expect(createManagerConfig(volatileSchemastery(dsh01))).toBeUndefined();
        expect(
            volatileSchemastery(() => {
                throw new Error('not installed');
            }),
        ).toBeNull();

        // DSH 0.2: the eight settings are volatile; the entry's own keys pass
        // through validation unchanged (the Loader validates non-strictly).
        const schema = createManagerConfig(volatileSchemastery(dsh02)) as {
            '~standard': {
                validate: (value: unknown) => { value: Record<string, { get?: () => unknown }> };
            };
        };
        expect(schema).toBeDefined();
        const value = schema['~standard'].validate({
            ...ENTRY,
            visionModel: 'qwen3.6-35b-a3b',
            visionModeByModel: { 'kimi-k3': 'native' },
        }).value;
        expect(value.upstream).toBe('tokensapi');
        expect(value.providerId).toBe('modlens-tokensapi');
        expect(value.settingsCard).toBe(false);
        expect(value.pasteToPath).toBe(false);
        expect(value.visionModel.get?.()).toBe('qwen3.6-35b-a3b');
        expect(value.visionModeByModel.get?.()).toEqual({ 'kimi-k3': 'native' });
        expect(value.baseURL.get?.()).toBeUndefined();
        // The module itself picked up the DSH 0.2 package installed for tests.
        expect(Config).toBeDefined();
    });

    it('keeps every manager setting across a DSH 0.2 restart', async () => {
        const run = dsh02Profile();
        const first = run.start();
        await settle();
        const response = managedResponseWithFuture();
        await __modelManager.setManagedCredential(first, 'tk-persist', response);
        await __modelManager.setManagedModels(
            first,
            {
                baseURL: 'https://gateway.example/v1',
                mainModel: FUTURE_MODEL_ID,
                visionModel: 'qwen3.6-35b-a3b',
                visionMode: 'native',
            },
            response,
        );
        await settle();
        // Saved as the complete settings, through replace.
        expect(run.profile.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            baseURL: 'https://gateway.example/v1',
            visionModel: 'qwen3.6-35b-a3b',
            visionModeByModel: { [FUTURE_MODEL_ID]: 'native' },
        });

        // A new start reads them back from the profile, not from memory.
        const second = run.start();
        await settle();
        const status = await __modelManager.modelManagerStatus(second, response, {
            refreshModels: false,
        });
        expect(status).toMatchObject({
            baseURL: 'https://gateway.example/v1',
            visionModel: 'qwen3.6-35b-a3b',
        });
        await expect(
            __modelManager.resolveManagedMainRoute(second, FUTURE_MODEL_ID),
        ).resolves.toMatchObject({
            visionMode: 'native',
            input: ['text', 'image'],
        });
    });

    it('saves a removed per-model override as removed, not merged back', async () => {
        const run = dsh02Profile();
        const ctx = run.start();
        await settle();
        const settings = __modelManager.managerSettingsAdapter(ctx);
        await settings.update(TOKENSAPI.settingsNamespace, {
            visionModeByModel: { a: 'native', b: 'bridge' },
        });
        await settings.update(TOKENSAPI.settingsNamespace, { visionModeByModel: { b: 'bridge' } });
        // A merge would keep "a"; the complete replacement does not.
        expect(run.profile.get(TOKENSAPI.settingsNamespace)?.visionModeByModel).toEqual({
            b: 'bridge',
        });
        // Every save carries the whole settings, so no field is lost either.
        expect(Object.keys(run.replaced.at(-1) ?? {}).sort()).toEqual(
            [
                'activeChannel',
                'baseURL',
                'fallbackBaseURL',
                'fallbackModel',
                'mainModel',
                'protocolByModel',
                'visionModeByModel',
                'visionModel',
            ].sort(),
        );
    });

    it('restores the backup route as it was left', async () => {
        const run = dsh02Profile({
            [TOKENSAPI.settingsNamespace]: {
                activeChannel: 'official',
                fallbackBaseURL: 'https://backup.example/v1',
                fallbackModel: 'deepseek-chat',
            },
        });
        const ctx = run.start();
        await settle();
        const status = await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE, {
            refreshModels: false,
        });
        expect(status).toMatchObject({ channel: 'official' });
        // The backup route is written into the Host again, not hidden.
        expect(
            (run.profile.get('llm-pi-ai') as { providers?: Record<string, unknown> }).providers?.[
                DEEPSEEK_OFFICIAL.upstreamProviderId
            ],
        ).toMatchObject({ baseURL: 'https://backup.example/v1' });
    });

    it('brings earlier settings over once, and never over newer ones', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
        try {
            const documentPath = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml');
            fs.mkdirSync(path.dirname(documentPath), { recursive: true });
            const legacy = path.join(home, 'settings.yaml.imported');
            const legacyText = [
                'desktop-notifications:',
                '  enabled: true',
                'tokens-model-manager:',
                '  baseURL: https://legacy.example/v1',
                '  visionModel: qwen3.6-35b-a3b',
                '  visionModeByModel:',
                `    ${FUTURE_MODEL_ID}: native`,
                '  activeChannel: tokensapi',
                '',
            ].join('\n');
            fs.writeFileSync(legacy, legacyText);

            // No saved settings in the profile: the earlier ones come over and
            // are saved into the profile once.
            const fresh = dsh02Profile({}, documentPath);
            const ctx = fresh.start();
            await settle();
            const status = await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE, {
                refreshModels: false,
            });
            expect(status).toMatchObject({
                baseURL: 'https://legacy.example/v1',
                visionModel: 'qwen3.6-35b-a3b',
            });
            expect(fresh.replaced).toHaveLength(1);
            expect(fresh.profile.get(TOKENSAPI.settingsNamespace)).toMatchObject({
                baseURL: 'https://legacy.example/v1',
                visionModeByModel: { [FUTURE_MODEL_ID]: 'native' },
            });
            // The earlier file is left exactly as it was.
            expect(fs.readFileSync(legacy, 'utf8')).toBe(legacyText);

            // The profile already has settings: the earlier file is not used.
            const saved = dsh02Profile(
                { [TOKENSAPI.settingsNamespace]: { baseURL: 'https://newer.example/v1' } },
                documentPath,
            );
            const savedCtx = saved.start();
            await settle();
            const newer = await __modelManager.modelManagerStatus(savedCtx, VALID_RESPONSE, {
                refreshModels: false,
            });
            expect(newer).toMatchObject({ baseURL: 'https://newer.example/v1' });
            expect(saved.replaced).toHaveLength(0);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('TokensAPI editable endpoint', () => {
    it('keeps the official endpoint as the default and normalizes a saved HTTPS URL', () => {
        expect(__modelManager.normalizeManagedBaseURL(undefined)).toBe(TOKENSAPI.baseURL);
        expect(__modelManager.normalizeManagedBaseURL(' https://gateway.example/api/v1/// ')).toBe(
            'https://gateway.example/api/v1',
        );
        expect(__modelManager.normalizeManagedBaseURL('http://localhost:8787/v1/')).toBe(
            'http://localhost:8787/v1',
        );
    });

    for (const value of [
        '',
        'not a URL',
        'http://gateway.example/v1',
        'https://user:pass@gateway.example/v1',
        'https://gateway.example/v1?key=value',
        'https://gateway.example/v1#fragment',
    ]) {
        it(`rejects an unsafe endpoint: ${value || '(blank)'}`, () => {
            expect(() => __modelManager.normalizeManagedBaseURL(value)).toThrow();
        });
    }

    it('uses the saved endpoint for managed vision while login verification stays official', async () => {
        const harness = credentialHarness('tk-custom-endpoint', true);
        await __modelManager.modelManagerStatus(harness.ctx, VALID_RESPONSE);
        await __modelManager.setManagedModels(
            harness.ctx,
            {
                baseURL: 'https://gateway.example/v1/',
                mainModel: TOKENSAPI.mainModel,
                visionModel: TOKENSAPI.visionModel,
            },
            VALID_RESPONSE,
        );

        let verificationUrl = '';
        await __modelManager.validateManagedCredential(
            'tk-custom-endpoint',
            async (url: unknown) => {
                verificationUrl = String(url);
                return { status: 200, json: async () => ({ data: API_MODELS }) };
            },
        );
        expect(verificationUrl).toBe(`${TOKENSAPI.baseURL}/models`);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-endpoint-'));
        const script = path.join(dir, 'print-endpoint.cjs');
        fs.writeFileSync(script, "process.stdout.write(process.env.TOKENSAPI_BASE_URL || '')");
        try {
            const result = await __modelManager.runManagedVision(harness.ctx, [script], undefined);
            expect(result.code).toBe(0);
            expect(result.stdout).toBe('https://gateway.example/v1');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('TokensAPI remote API-key verification', () => {
    it('calls the immutable models endpoint without leaking the key in the URL', async () => {
        let capturedUrl = '';
        let capturedAuth = '';
        await __modelManager.validateManagedCredential(
            'tk-private-value',
            async (url: unknown, init: { headers?: { authorization?: string } } | undefined) => {
                capturedUrl = String(url);
                capturedAuth = String(init?.headers?.authorization ?? '');
                return { status: 200, json: async () => ({ data: API_MODELS }) };
            },
        );
        expect(capturedUrl).toBe('https://tokensapi.ai/v1/models');
        expect(capturedUrl).not.toContain('tk-private-value');
        expect(capturedAuth).toBe('Bearer tk-private-value');
    });

    for (const status of [401, 403]) {
        it(`keeps the gate locked and does not save on HTTP ${status}`, async () => {
            const harness = credentialHarness('previous-key', true);
            await expect(
                __modelManager.setManagedCredential(harness.ctx, 'replacement-key', async () => ({
                    status,
                })),
            ).rejects.toMatchObject({ code: 'invalid_key' });
            expect(harness.stored).toBe('previous-key');
        });
    }

    for (const status of [400, 404, 408, 429, 500, 502, 503]) {
        it(`classifies HTTP ${status} as an upstream failure without saving`, async () => {
            const harness = credentialHarness();
            await expect(
                __modelManager.setManagedCredential(harness.ctx, 'candidate-key', async () => ({
                    status,
                })),
            ).rejects.toMatchObject({ code: 'upstream' });
            expect(harness.stored).toBeUndefined();
        });
    }

    it('classifies transport failures as unreachable and does not save', async () => {
        const harness = credentialHarness();
        await expect(
            __modelManager.setManagedCredential(harness.ctx, 'candidate-key', async () => {
                throw new Error('offline');
            }),
        ).rejects.toMatchObject({ code: 'unreachable' });
        expect(harness.stored).toBeUndefined();
    });

    it('requires an exact verification fingerprint before startup unlocks', async () => {
        const legacy = credentialHarness('legacy-unverified-key');
        expect(await __modelManager.modelManagerStatus(legacy.ctx)).toMatchObject({
            configured: true,
            authenticated: false,
        });
        legacy.verification = 'sha256:not-the-current-key';
        expect(await __modelManager.modelManagerStatus(legacy.ctx)).toMatchObject({
            configured: true,
            authenticated: false,
        });
    });
});

describe('TokensAPI model discovery and selection', () => {
    it('hides exactly the ids on the explicit hidden list, from both the settings and the composer lists', () => {
        const runtime = {
            models: [
                { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', endpointTypes: ['openai'] },
                { id: 'kimi-k3', name: 'kimi-k3', endpointTypes: ['openai'] },
                { id: 'claude-opus-4-7', name: 'claude-opus-4-7', endpointTypes: ['anthropic'] },
            ],
            mainModel: 'deepseek-v4-flash',
            visionModel: 'deepseek-v4-flash',
            protocolByModel: {},
            visionModeByModel: {},
            visionProviderEnabled: true,
        };
        const ids = (models: Array<{ id: string }>) => models.map((model) => model.id).sort();
        const hidden: Set<string> = __modelManager.hiddenManagedModelIds;
        // Shipped empty: every model the API returns is shown by default.
        expect(hidden.size).toBe(0);
        expect(ids(__modelManager.publicModels(runtime))).toEqual([
            'claude-opus-4-7',
            'deepseek-v4-flash',
            'kimi-k3',
        ]);
        expect(
            ids(
                __modelManager.managedConversationModels(
                    runtime,
                    runtime.models,
                    'openai-completions',
                ),
            ),
        ).toEqual(['claude-opus-4-7', 'deepseek-v4-flash', 'kimi-k3']);
        hidden.add('kimi-k3');
        try {
            // One list in one place: both the settings page and the composer drop it.
            expect(ids(__modelManager.publicModels(runtime))).toEqual([
                'claude-opus-4-7',
                'deepseek-v4-flash',
            ]);
            expect(
                ids(
                    __modelManager.managedConversationModels(
                        runtime,
                        runtime.models,
                        'openai-completions',
                    ),
                ),
            ).toEqual(['claude-opus-4-7', 'deepseek-v4-flash']);
        } finally {
            hidden.delete('kimi-k3');
        }
    });

    it('waits for persisted model settings before exposing startup status', async () => {
        const credential = credentialHarness('tk-startup-settings', true);
        const values = new Map<string, Record<string, unknown>>([
            [
                TOKENSAPI.settingsNamespace,
                {
                    mainModel: 'gpt-5.5',
                    protocolByModel: { 'gpt-5.5': 'openai-responses' },
                    visionModel: 'qwen3.6-35b-a3b',
                },
            ],
        ]);
        let settingsInjection: ((scope: Record<string, unknown>) => void) | undefined;
        const settings = {
            register: (
                namespace: string,
                _schema: unknown,
                options?: { base?: Record<string, unknown> },
            ) => {
                if (!values.has(namespace)) values.set(namespace, { ...(options?.base ?? {}) });
                return { get: () => values.get(namespace) };
            },
            get: (namespace: string) => values.get(namespace),
            update: async (namespace: string, patch: Record<string, unknown>) => {
                values.set(namespace, { ...(values.get(namespace) ?? {}), ...patch });
            },
        };
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.includes('settings')) settingsInjection = callback;
            },
        };
        apply(ctx, { allowGptModels: true, settingsCard: false, pasteToPath: false });

        let completed = false;
        const statusPromise = __modelManager
            .modelManagerStatus(ctx, VALID_RESPONSE)
            .then((status: Record<string, unknown>) => {
                completed = true;
                return status;
            });
        await Promise.resolve();
        expect(completed).toBe(false);

        settingsInjection?.({ settings });
        await expect(statusPromise).resolves.toMatchObject({
            mainModel: 'gpt-5.5',
            api: 'openai-responses',
            mainProvider: TOKENSAPI.providerId,
            visionMode: 'native',
            visionModel: 'qwen3.6-35b-a3b',
        });
    });

    it('migrates a stale kimi-k3 bridge choice to native vision on startup', async () => {
        const credential = credentialHarness('tk-kimi-native-migration', true);
        const values = new Map<string, Record<string, unknown>>([
            [
                TOKENSAPI.settingsNamespace,
                {
                    mainModel: 'kimi-k3',
                    visionModeByModel: { 'kimi-k3': 'bridge' },
                    visionModel: TOKENSAPI.visionModel,
                },
            ],
        ]);
        const updates: Array<{ namespace: string; patch: Record<string, unknown> }> = [];
        const settings = {
            register: (
                namespace: string,
                _schema: unknown,
                options?: { base?: Record<string, unknown> },
            ) => {
                if (!values.has(namespace)) values.set(namespace, { ...(options?.base ?? {}) });
                return { get: () => values.get(namespace) };
            },
            get: (namespace: string) => values.get(namespace),
            update: async (namespace: string, patch: Record<string, unknown>) => {
                updates.push({ namespace, patch });
                values.set(namespace, { ...(values.get(namespace) ?? {}), ...patch });
            },
        };
        const response = async () => ({
            status: 200,
            json: async () => ({
                data: [
                    {
                        id: 'kimi-k3',
                        object: 'model',
                        created: 1626777600,
                        owned_by: 'custom',
                        supported_endpoint_types: [
                            'openai',
                            'openai-response',
                            'openai-response-compact',
                            'anthropic',
                            'gemini',
                        ],
                    },
                ],
            }),
        });
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.includes('settings')) callback({ settings });
            },
        };
        apply(ctx, { settingsCard: false, pasteToPath: false });

        const status = await __modelManager.modelManagerStatus(ctx, response);

        expect(status).toMatchObject({
            mainModel: 'kimi-k3',
            visionMode: 'native',
            models: expect.arrayContaining([
                expect.objectContaining({
                    id: 'kimi-k3',
                    visionMode: 'native',
                    visionCapabilitySource: 'builtin',
                }),
            ]),
        });
        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            visionModeByModel: {},
        });
        expect(updates).toContainEqual({
            namespace: TOKENSAPI.settingsNamespace,
            patch: { visionModeByModel: {} },
        });
        await expect(__modelManager.resolveManagedMainRoute(ctx, 'kimi-k3')).resolves.toMatchObject(
            { visionMode: 'native', input: ['text', 'image'] },
        );
    });

    it('keeps a persisted alternative protocol for a non-native model family', async () => {
        const credential = credentialHarness('tk-startup-protocol', true);
        const values = new Map<string, Record<string, unknown>>([
            [
                TOKENSAPI.settingsNamespace,
                {
                    mainModel: 'deepseek-v4-flash',
                    protocolByModel: { 'deepseek-v4-flash': 'openai-responses' },
                    visionModel: TOKENSAPI.visionModel,
                },
            ],
        ]);
        const updates: Array<{ namespace: string; patch: Record<string, unknown> }> = [];
        const settings = {
            register: (
                namespace: string,
                _schema: unknown,
                options?: { base?: Record<string, unknown> },
            ) => {
                if (!values.has(namespace)) values.set(namespace, { ...(options?.base ?? {}) });
                return { get: () => values.get(namespace) };
            },
            get: (namespace: string) => values.get(namespace),
            update: async (namespace: string, patch: Record<string, unknown>) => {
                updates.push({ namespace, patch });
                values.set(namespace, { ...(values.get(namespace) ?? {}), ...patch });
            },
        };
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.includes('settings')) callback({ settings });
            },
        };

        apply(ctx, { settingsCard: false, pasteToPath: false });
        await expect(__modelManager.modelManagerStatus(ctx, VALID_RESPONSE)).resolves.toMatchObject(
            {
                mainModel: 'deepseek-v4-flash',
                api: 'openai-responses',
            },
        );
        expect(
            [...updates]
                .reverse()
                .find((entry) => entry.namespace === TOKENSAPI.llmSettingsNamespace)?.patch,
        ).toMatchObject({
            providers: {
                tokensapi: {
                    api: 'openai-responses',
                    defaultContextWindow: 262144,
                    models: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'deepseek-v4-flash',
                            contextWindow: 262144,
                            maxTokens: 32768,
                        }),
                        expect.objectContaining({ id: 'deepseek-v3.2' }),
                        expect.objectContaining({ id: 'qwen3.6-35b-a3b' }),
                    ]),
                },
            },
        });
    });

    it('uses the bridge only for supported text-only model families', () => {
        expect(
            __modelManager.modelUsesVisionBridge({
                id: 'deepseek-v4-flash',
                inputModalities: ['text'],
            }),
        ).toBe(true);
        expect(
            __modelManager.modelUsesVisionBridge({
                id: 'deepseek-vl-2',
                inputModalities: ['text', 'image'],
            }),
        ).toBe(false);
        expect(
            __modelManager.modelUsesVisionBridge({
                id: 'claude-opus-4-6',
                inputModalities: ['text', 'image'],
            }),
        ).toBe(false);
    });

    it('respects provider metadata and the verified fallback table', () => {
        expect(
            __modelManager.managedVisionMode({
                id: 'claude-opus-4-6',
                inputModalities: ['text', 'image'],
            }),
        ).toBe('native');
        expect(
            __modelManager.managedVisionMode({
                id: 'deepseek-v4-flash',
                inputModalities: ['text'],
            }),
        ).toBe('bridge');
        expect(
            __modelManager.managedVisionMode({
                id: 'claude-opus-4-6',
                inputModalities: ['text'],
            }),
        ).toBe('bridge');
        expect(
            __modelManager.managedVisionMode({
                id: 'gpt-5.5',
            }),
        ).toBe('native');
        expect(
            __modelManager.managedVisionMode({
                id: 'unclassified-future-model',
            }),
        ).toBe('unknown');
    });

    it.each(['native', 'bridge'])(
        'uses declared capabilities for the reported vision model (%s)',
        async (mode) => {
            const harness = credentialHarness();
            const model = 'deepseek-v4-flash-vision-exp';
            const input = mode === 'native' ? ['text', 'image'] : ['text'];
            await __modelManager.setManagedCredential(
                harness.ctx,
                'synthetic-vision-key',
                async () => ({
                    status: 200,
                    json: async () => ({
                        data: [{ id: model, input, supported_endpoint_types: ['openai'] }],
                    }),
                }),
            );
            await expect(
                __modelManager.resolveManagedMainRoute(harness.ctx, model),
            ).resolves.toMatchObject({
                provider: mode === 'native' ? TOKENSAPI.providerId : TOKENSAPI.agentProviderId,
                visionMode: mode,
                input,
            });
        },
    );

    it('routes native models directly and only bridges text-only models', async () => {
        await expect(
            __modelManager.resolveManagedMainRoute({}, 'deepseek-v4-flash'),
        ).resolves.toEqual({
            provider: TOKENSAPI.agentProviderId,
            visionMode: 'bridge',
            api: 'openai-completions',
            input: ['text'],
        });
        await expect(
            __modelManager.resolveManagedMainRoute({}, 'claude-opus-4-7'),
        ).resolves.toEqual({
            provider: TOKENSAPI.providerId,
            visionMode: 'native',
            api: 'anthropic-messages',
            input: ['text', 'image'],
        });
        const harness = credentialHarness();
        await __modelManager.setManagedCredential(
            harness.ctx,
            'tk-gpt-native-route',
            VALID_RESPONSE,
        );
        await expect(
            __modelManager.resolveManagedMainRoute(harness.ctx, 'gpt-5.5'),
        ).resolves.toEqual({
            provider: TOKENSAPI.providerId,
            visionMode: 'native',
            api: 'openai-responses',
            input: ['text', 'image'],
        });
    });

    it('routes an undeclared model through the vision bridge by default', async () => {
        // Selecting a model must never fail for want of a capability the API did
        // not declare: the bridge keeps the main model text-only and sends
        // images to the vision model, which works whatever it really supports.
        await expect(
            __modelManager.resolveManagedMainRoute({}, 'unclassified-text-model'),
        ).resolves.toMatchObject({
            provider: TOKENSAPI.agentProviderId,
            visionMode: 'bridge',
            input: ['text'],
        });

        // The raw capability still reports the undeclared state, so the settings
        // page can show it and offer native handling.
        expect(__modelManager.managedModelCapability({ id: 'unclassified-text-model' })).toEqual({
            input: ['text'],
            visionMode: 'unknown',
            source: 'unknown',
        });
        expect(
            __modelManager.managedModelCapability({ id: 'unclassified-text-model' }, 'native'),
        ).toEqual({ input: ['text', 'image'], visionMode: 'native', source: 'override' });
        expect(
            __modelManager.managedModelCapability({ id: 'unclassified-text-model' }, 'bridge'),
        ).toEqual({ input: ['text'], visionMode: 'bridge', source: 'override' });

        const credential = credentialHarness();
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: () => {},
        };
        apply(ctx, { visionProvider: false, settingsCard: false, pasteToPath: false });
        await expect(
            __modelManager.resolveManagedMainRoute(ctx, 'deepseek-v4-flash'),
        ).resolves.toEqual({
            provider: TOKENSAPI.providerId,
            visionMode: 'direct',
            api: 'openai-completions',
            input: ['text'],
        });
    });

    it('defaults a future model to the bridge and still honours an explicit choice', async () => {
        const harness = credentialHarness();
        const response = managedResponseWithFuture();
        await __modelManager.setManagedCredential(harness.ctx, 'tk-future-route', response);

        // No explicit choice: the model is usable immediately, through the bridge.
        const defaulted = await __modelManager.setManagedModels(
            harness.ctx,
            { mainModel: FUTURE_MODEL_ID, visionModel: TOKENSAPI.visionModel },
            response,
        );
        expect(
            defaulted.models.find((model: { id: string }) => model.id === FUTURE_MODEL_ID),
        ).toMatchObject({ visionMode: 'bridge' });
        await expect(
            __modelManager.resolveManagedMainRoute(harness.ctx, FUTURE_MODEL_ID),
        ).resolves.toMatchObject({
            provider: TOKENSAPI.agentProviderId,
            visionMode: 'bridge',
            input: ['text'],
        });

        const native = await __modelManager.setManagedModels(
            harness.ctx,
            {
                mainModel: FUTURE_MODEL_ID,
                visionModel: TOKENSAPI.visionModel,
                visionMode: 'native',
            },
            response,
        );
        expect(
            native.models.find((model: { id: string }) => model.id === FUTURE_MODEL_ID),
        ).toMatchObject({
            visionMode: 'native',
            visionCapabilitySource: 'override',
        });
        await expect(
            __modelManager.resolveManagedMainRoute(harness.ctx, FUTURE_MODEL_ID),
        ).resolves.toMatchObject({
            provider: TOKENSAPI.providerId,
            visionMode: 'native',
            input: ['text', 'image'],
        });

        const bridged = await __modelManager.setManagedModels(
            harness.ctx,
            {
                mainModel: FUTURE_MODEL_ID,
                visionModel: TOKENSAPI.visionModel,
                visionMode: 'bridge',
            },
            response,
        );
        expect(
            bridged.models.find((model: { id: string }) => model.id === FUTURE_MODEL_ID),
        ).toMatchObject({
            visionMode: 'bridge',
            visionCapabilitySource: 'override',
        });
        await expect(
            __modelManager.resolveManagedMainRoute(harness.ctx, FUTURE_MODEL_ID),
        ).resolves.toMatchObject({
            provider: TOKENSAPI.agentProviderId,
            visionMode: 'bridge',
            input: ['text'],
        });
    });

    it('persists a future-model decision, restores it, and lists unconfirmed models as text-only', async () => {
        const values = new Map<string, Record<string, unknown>>();
        const updates: Array<{ namespace: string; patch: Record<string, unknown> }> = [];
        const settings = {
            register: (
                namespace: string,
                _schema: unknown,
                options?: { base?: Record<string, unknown> },
            ) => {
                if (!values.has(namespace)) values.set(namespace, { ...(options?.base ?? {}) });
                return { get: () => values.get(namespace) };
            },
            get: (namespace: string) => values.get(namespace),
            update: async (namespace: string, patch: Record<string, unknown>) => {
                updates.push({ namespace, patch });
                values.set(namespace, { ...(values.get(namespace) ?? {}), ...patch });
            },
        };
        const createContext = (credential: CredentialHarness) => ({
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.includes('settings')) callback({ settings });
            },
        });
        const response = managedResponseWithFuture();
        const credential = credentialHarness();
        const ctx = createContext(credential);
        apply(ctx, { settingsCard: false, pasteToPath: false });

        await __modelManager.setManagedCredential(ctx, 'tk-future-persist', response);
        const beforeConfirmation = [...updates]
            .reverse()
            .find((entry) => entry.namespace === TOKENSAPI.llmSettingsNamespace)?.patch;
        // The route advertises every managed model, so the composer lists exactly
        // what the settings page lists. A model with no declared image capability
        // is registered text-only; selecting it is refused with a message asking
        // for an image handling mode rather than silently disappearing.
        expect(beforeConfirmation).toMatchObject({
            providers: {
                [TOKENSAPI.providerId]: {
                    models: expect.arrayContaining([
                        expect.objectContaining({ id: FUTURE_MODEL_ID, input: ['text'] }),
                    ]),
                },
            },
        });

        await __modelManager.setManagedModels(
            ctx,
            {
                mainModel: FUTURE_MODEL_ID,
                visionModel: TOKENSAPI.visionModel,
                visionMode: 'native',
            },
            response,
        );
        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            mainModel: FUTURE_MODEL_ID,
            visionModeByModel: { [FUTURE_MODEL_ID]: 'native' },
        });
        const afterConfirmation = [...updates]
            .reverse()
            .find((entry) => entry.namespace === TOKENSAPI.llmSettingsNamespace)?.patch;
        expect(afterConfirmation).toMatchObject({
            providers: {
                tokensapi: {
                    models: expect.arrayContaining([
                        expect.objectContaining({
                            id: FUTURE_MODEL_ID,
                            input: ['text', 'image'],
                        }),
                    ]),
                },
            },
        });

        const restartedCredential = credentialHarness('tk-future-persist', true);
        const restartedCtx = createContext(restartedCredential);
        apply(restartedCtx, { settingsCard: false, pasteToPath: false });
        await expect(
            __modelManager.modelManagerStatus(restartedCtx, response),
        ).resolves.toMatchObject({
            mainModel: FUTURE_MODEL_ID,
            models: expect.arrayContaining([
                expect.objectContaining({
                    id: FUTURE_MODEL_ID,
                    visionMode: 'native',
                    visionCapabilitySource: 'override',
                }),
            ]),
        });
        await expect(
            __modelManager.resolveManagedMainRoute(restartedCtx, FUTURE_MODEL_ID),
        ).resolves.toMatchObject({ visionMode: 'native', input: ['text', 'image'] });
    });

    it('lets later provider metadata replace and clear an old manual decision', async () => {
        const values = new Map<string, Record<string, unknown>>();
        const settings = {
            register: (
                namespace: string,
                _schema: unknown,
                options?: { base?: Record<string, unknown> },
            ) => {
                if (!values.has(namespace)) values.set(namespace, { ...(options?.base ?? {}) });
                return { get: () => values.get(namespace) };
            },
            get: (namespace: string) => values.get(namespace),
            update: async (namespace: string, patch: Record<string, unknown>) => {
                values.set(namespace, { ...(values.get(namespace) ?? {}), ...patch });
            },
        };
        const credential = credentialHarness();
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.includes('settings')) callback({ settings });
            },
        };
        const unknownResponse = managedResponseWithFuture();
        apply(ctx, { settingsCard: false, pasteToPath: false });
        await __modelManager.setManagedCredential(ctx, 'tk-provider-wins', unknownResponse);
        await __modelManager.setManagedModels(
            ctx,
            {
                mainModel: FUTURE_MODEL_ID,
                visionModel: TOKENSAPI.visionModel,
                visionMode: 'native',
            },
            unknownResponse,
        );

        const declaredTextResponse = managedResponseWithFuture(['text']);
        const status = await __modelManager.setManagedCredential(
            ctx,
            'tk-provider-wins',
            declaredTextResponse,
        );
        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            visionModeByModel: {},
        });
        expect(
            status.models.find((model: { id: string }) => model.id === FUTURE_MODEL_ID),
        ).toMatchObject({
            visionMode: 'bridge',
            visionCapabilitySource: 'provider',
        });
    });

    it('defaults to Chat Completions and validates explicit protocol choices', () => {
        expect(
            __modelManager.managedModelApi({
                id: 'claude-opus-4-7',
                endpointTypes: ['anthropic', 'openai'],
            }),
        ).toBe('anthropic-messages');
        expect(
            __modelManager.managedModelApi({
                id: 'deepseek-v4-flash',
                endpointTypes: ['openai', 'openai-response'],
            }),
        ).toBe('openai-completions');
        expect(
            __modelManager.managedModelApi(
                {
                    id: 'deepseek-v3.2',
                    endpointTypes: ['openai', 'openai-response'],
                },
                'openai-responses',
            ),
        ).toBe('openai-responses');
        expect(__modelManager.managedModelApi({ id: 'catalog-without-metadata' })).toBe(
            'openai-completions',
        );
        expect(
            __modelManager.managedModelApi({ id: 'openai-only', endpointTypes: ['openai'] }),
        ).toBe('openai-completions');
        expect(
            __modelManager.managedModelApis({
                id: 'gpt-5.6-sol',
                endpointTypes: ['openai', 'openai-response'],
            }),
        ).toEqual(['openai-responses']);
        expect(
            __modelManager.managedModelApis({
                id: 'codex-auto-review',
                endpointTypes: ['openai', 'openai-response'],
            }),
        ).toEqual(['openai-responses']);
        expect(
            __modelManager.managedModelApis({
                id: 'qwen3.8-flash-next',
                endpointTypes: ['openai', 'openai-response'],
            }),
        ).toEqual(['openai-completions', 'openai-responses']);
        expect(
            __modelManager.managedModelApis({
                id: 'qwen3.6-35b-a3b',
                endpointTypes: ['openai', 'openai-response'],
            }),
        ).toEqual(['openai-completions', 'openai-responses']);
        expect(() =>
            __modelManager.managedModelApi({ id: 'gemini-only', endpointTypes: ['gemini'] }),
        ).toThrow(/暂不支持 DSH/);
        expect(() =>
            __modelManager.managedModelApi({ id: 'unknown-only', endpointTypes: ['future-api'] }),
        ).toThrow(/暂不支持 DSH/);
        expect(() =>
            __modelManager.managedModelApi(
                { id: 'openai-only', endpointTypes: ['openai'] },
                'openai-responses',
            ),
        ).toThrow(/不支持所选请求协议/);
    });

    it('classifies future model versions by family and keeps unknown families extensible', () => {
        expect(
            __modelManager.managedModelApis({
                id: 'gpt-7-future',
                endpointTypes: ['openai', 'openai-response', 'anthropic'],
            }),
        ).toEqual(['openai-responses']);
        expect(
            __modelManager.managedModelApis({
                id: 'codex-next-2028',
                endpointTypes: ['openai', 'openai-response', 'anthropic'],
            }),
        ).toEqual(['openai-responses']);
        expect(
            __modelManager.managedModelApis({
                id: 'openai/gpt-7-future',
                endpointTypes: ['openai', 'openai-response', 'anthropic'],
            }),
        ).toEqual(['openai-responses']);
        expect(
            __modelManager.managedModelApis({
                id: 'claude-opus-6',
                endpointTypes: ['openai', 'openai-response', 'anthropic'],
            }),
        ).toEqual(['anthropic-messages']);
        expect(
            __modelManager.managedModelApis({
                id: 'vertex-ai/claude-opus-6',
                endpointTypes: ['openai', 'openai-response', 'anthropic'],
            }),
        ).toEqual(['anthropic-messages']);
        expect(__modelManager.managedModelApis({ id: 'future-family-v1' })).toEqual([
            'openai-completions',
            'openai-responses',
            'anthropic-messages',
        ]);
        expect(
            __modelManager.managedModelApis({
                id: 'future-family-v2',
                endpointTypes: ['openai', 'openai-response', 'anthropic'],
            }),
        ).toEqual(['openai-completions', 'openai-responses', 'anthropic-messages']);
    });

    it('probes alternative protocols with their real streamed wire contracts', async () => {
        const harness = credentialHarness('tk-protocol-probe', true);
        const calls: Array<{ url: URL; options: Record<string, unknown> }> = [];
        const request = vi.fn(async (url: URL, options: Record<string, unknown>) => {
            calls.push({ url, options });
            const body = JSON.parse(String(options.body));
            if (url.pathname.endsWith('/chat/completions')) {
                expect(body.stream_options).toEqual({ include_usage: true });
                return new Response('data: {"finish_reason":"stop"}\n\ndata: [DONE]\n\n');
            }
            if (url.pathname.endsWith('/responses')) {
                return new Response(
                    'event: response.completed\ndata: {"type":"response.completed"}\n\n',
                );
            }
            expect(url.pathname).toBe('/v1/messages');
            return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        });

        await __modelManager.probeManagedProtocol(
            harness.ctx,
            'future-family-v1',
            'openai-completions',
            request,
        );
        await __modelManager.probeManagedProtocol(
            harness.ctx,
            'future-family-v1',
            'openai-responses',
            request,
        );
        await __modelManager.probeManagedProtocol(
            harness.ctx,
            'future-family-v1',
            'anthropic-messages',
            request,
        );

        expect(calls.map((entry) => entry.url.pathname)).toEqual([
            '/v1/chat/completions',
            '/v1/responses',
            '/v1/messages',
        ]);
        expect(calls[2]?.options).toMatchObject({
            headers: expect.objectContaining({
                'x-api-key': 'tk-protocol-probe',
                'user-agent': expect.stringMatching(/^claude-cli\//),
            }),
        });
    });

    it('distinguishes hard incompatibility from temporary protocol failures', async () => {
        const harness = credentialHarness('tk-protocol-errors', true);
        await expect(
            __modelManager.probeManagedProtocol(
                harness.ctx,
                'future-family-v1',
                'openai-responses',
                async () => new Response('{}', { status: 400 }),
            ),
        ).rejects.toMatchObject({ code: 'unsupported_protocol' });
        await expect(
            __modelManager.probeManagedProtocol(
                harness.ctx,
                'future-family-v1',
                'openai-responses',
                async () => new Response('{}', { status: 503 }),
            ),
        ).rejects.toMatchObject({ code: 'protocol_temporary' });
        await expect(
            __modelManager.probeManagedProtocol(
                harness.ctx,
                'future-family-v1',
                'openai-responses',
                async () => new Response('event: response.output_text.delta\n\n'),
            ),
        ).rejects.toMatchObject({ code: 'unsupported_protocol' });
        await expect(
            __modelManager.probeManagedProtocol(
                harness.ctx,
                'future-family-v1',
                'openai-responses',
                async () => {
                    throw new TypeError('connection reset');
                },
            ),
        ).rejects.toMatchObject({ code: 'protocol_temporary' });
    });

    it('bounds both stalled protocol headers and stalled response bodies', async () => {
        vi.useFakeTimers();
        try {
            const harness = credentialHarness('tk-protocol-timeout', true);
            for (const stage of ['headers', 'body']) {
                const never = new Promise(() => {});
                const request = vi.fn(() =>
                    stage === 'headers'
                        ? never
                        : Promise.resolve({ ok: true, status: 200, text: () => never }),
                );
                const result = __modelManager
                    .probeManagedProtocol(
                        harness.ctx,
                        'future-family-v1',
                        'openai-responses',
                        request,
                    )
                    .catch((error: unknown) => error);
                await vi.advanceTimersByTimeAsync(20_001);
                await expect(result).resolves.toMatchObject({ code: 'protocol_temporary' });
                expect(vi.getTimerCount()).toBe(0);
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the saved route unchanged when an alternative protocol probe fails', async () => {
        const harness = credentialHarness();
        await __modelManager.setManagedCredential(
            harness.ctx,
            'tk-protocol-rollback',
            VALID_RESPONSE,
        );
        await expect(
            __modelManager.setManagedModels(
                harness.ctx,
                {
                    mainModel: 'deepseek-v3.2',
                    api: 'openai-responses',
                    visionModel: TOKENSAPI.visionModel,
                },
                async () => new Response('{}', { status: 503 }),
            ),
        ).rejects.toMatchObject({ code: 'protocol_temporary' });
        await expect(
            __modelManager.modelManagerStatus(harness.ctx, VALID_RESPONSE),
        ).resolves.toMatchObject({
            mainModel: TOKENSAPI.mainModel,
            api: 'openai-completions',
        });
    });

    it('declares verified native multimodal models as accepting image input', () => {
        expect(__modelManager.managedModelInput({ id: 'claude-opus-4-7' })).toEqual([
            'text',
            'image',
        ]);
        expect(__modelManager.managedModelInput({ id: 'qwen3.6-35b-a3b' })).toEqual([
            'text',
            'image',
        ]);
        expect(__modelManager.managedModelInput({ id: 'gpt-5.5' })).toEqual(['text', 'image']);
        expect(__modelManager.managedModelInput({ id: 'kimi-k3' })).toEqual(['text', 'image']);
        expect(__modelManager.managedModelInput({ id: 'tokensapi/kimi-k3-preview' })).toEqual([
            'text',
            'image',
        ]);
        expect(__modelManager.managedModelInput({ id: 'deepseek-v4-flash' })).toEqual(['text']);
    });

    it('keeps provider modality metadata authoritative over the builtin fallback', () => {
        expect(
            __modelManager.managedModelInput({ id: 'kimi-k3', input: ['text', 'image'] }),
        ).toEqual(['text', 'image']);
        expect(__modelManager.managedModelInput({ id: 'kimi-k3', input: ['text'] })).toEqual([
            'text',
        ]);
        expect(
            __modelManager.managedModelInput({
                id: 'unlisted-future-model',
                input: ['text', 'image'],
            }),
        ).toEqual(['text', 'image']);
        expect(
            __modelManager.managedModelCapability({ id: 'kimi-k3', input: ['text'] }, 'native'),
        ).toEqual({ input: ['text'], visionMode: 'bridge', source: 'provider' });
    });

    it('classifies the exact current TokensAPI kimi-k3 catalog shape as native vision', async () => {
        const [model] = await __modelManager.parseManagedModels({
            json: async () => ({
                data: [
                    {
                        id: 'kimi-k3',
                        object: 'model',
                        created: 1626777600,
                        owned_by: 'custom',
                        supported_endpoint_types: [
                            'openai',
                            'openai-response',
                            'openai-response-compact',
                            'anthropic',
                            'gemini',
                        ],
                    },
                ],
            }),
        });

        expect(model).not.toHaveProperty('input');
        expect(__modelManager.managedModelInput(model)).toEqual(['text', 'image']);
        expect(__modelManager.managedVisionMode(model)).toBe('native');
    });

    it('uses the production capacity for DeepSeek V4 Flash', () => {
        expect(__modelManager.managedModelContextWindow({ id: 'deepseek-v4-flash' })).toBe(262144);
        expect(__modelManager.managedModelMaxTokens({ id: 'deepseek-v4-flash' })).toBe(32768);
        expect(
            __modelManager.managedModelContextWindow({
                id: 'deepseek-v4-flash',
                context_window: 196608,
            }),
        ).toBe(196608);
        expect(
            __modelManager.managedModelContextWindow({
                id: 'deepseek-v4-flash',
                context_window: -1,
            }),
        ).toBe(262144);
        expect(
            __modelManager.managedModelMaxTokens({
                id: 'deepseek-v4-flash',
                max_output_tokens: 65536,
            }),
        ).toBe(65536);
        expect(
            __modelManager.managedModelMaxTokens({
                id: 'deepseek-v4-flash',
                max_output_tokens: 0,
            }),
        ).toBe(32768);
    });

    it('defaults non-native families to Chat while keeping declared alternatives selectable', () => {
        const model = {
            id: 'deepseek-v4-flash',
            endpointTypes: ['openai', 'openai-response', 'openai-response-compact'],
        };
        expect(__modelManager.managedModelApis(model)).toEqual([
            'openai-completions',
            'openai-responses',
        ]);
        expect(__modelManager.managedModelApi(model, 'openai-completions')).toBe(
            'openai-completions',
        );
        expect(__modelManager.managedModelApi(model, 'openai-responses')).toBe('openai-responses');
        expect(
            __modelManager.normalizeProtocolByModel({
                'deepseek-v4-flash': 'openai-responses',
                'qwen3.6-35b-a3b': 'openai-responses',
                'gpt-6-astra': 'openai-completions',
                'claude-opus-5': 'openai-completions',
            }),
        ).toEqual({
            'deepseek-v4-flash': 'openai-responses',
            'qwen3.6-35b-a3b': 'openai-responses',
            'gpt-6-astra': 'openai-responses',
            'claude-opus-5': 'anthropic-messages',
        });
    });

    it('parses, trims and deduplicates the OpenAI-compatible model list', async () => {
        const models = await __modelManager.parseManagedModels({
            json: async () => ({
                data: [
                    {
                        id: ' deepseek-v4-flash ',
                        name: ' DeepSeek V4 Flash ',
                        owned_by: ' deepseek ',
                        supported_endpoint_types: [
                            'openai-response',
                            'OPENAI',
                            'unknown',
                            42,
                            'openai-response',
                        ],
                        input_modalities: ['text', 'image', 'audio', 'image'],
                        context_window: 196608,
                        max_output_tokens: 16384,
                    },
                    { id: 'deepseek-v4-flash', name: 'duplicate' },
                    { id: '' },
                    null,
                    {
                        id: 'qwen_image',
                        supported_endpoint_types: ['image-generation'],
                    },
                    {
                        id: 'ltx_2_3',
                        supported_endpoint_types: ['openai-video'],
                    },
                    { id: 'qwen3.6-35b-a3b' },
                ],
            }),
        });
        expect(models).toEqual([
            {
                id: 'deepseek-v4-flash',
                name: 'DeepSeek V4 Flash',
                ownedBy: 'deepseek',
                endpointTypes: ['openai-response', 'openai'],
                input: ['text', 'image'],
                contextWindow: 196608,
                maxTokens: 16384,
            },
            { id: 'qwen3.6-35b-a3b', name: 'qwen3.6-35b-a3b' },
        ]);
    });

    it('filters pure image and video models from managed and fallback catalogs', async () => {
        const data = [
            { id: 'qwen_image', supported_endpoint_types: ['image-generation'] },
            { id: 'ltx_2_3', supported_endpoint_types: ['openai-video'] },
            {
                id: 'hybrid-chat-model',
                supported_endpoint_types: ['image-generation', 'openai-response'],
            },
            { id: 'metadata-free-chat-model' },
        ];

        await expect(
            __modelManager.parseManagedModels({ json: async () => ({ data }) }),
        ).resolves.toEqual([
            {
                id: 'hybrid-chat-model',
                name: 'hybrid-chat-model',
                endpointTypes: ['openai-response'],
            },
            { id: 'metadata-free-chat-model', name: 'metadata-free-chat-model' },
        ]);
        await expect(
            __modelManager.parseFallbackModels({ json: async () => ({ data }) }),
        ).resolves.toEqual([
            { id: 'hybrid-chat-model', name: 'hybrid-chat-model' },
            { id: 'metadata-free-chat-model', name: 'metadata-free-chat-model' },
        ]);
    });

    it('filters speech-recognition models from the conversation catalog', async () => {
        const models = await __modelManager.parseManagedModels({
            json: async () => ({
                data: [
                    { id: 'qwen3-asr', supported_endpoint_types: ['openai'] },
                    { id: 'meeting-asr', supported_endpoint_types: ['openai'] },
                    { id: 'deepseek-v4-flash', supported_endpoint_types: ['openai'] },
                ],
            }),
        });
        expect(models.map((model: { id: string }) => model.id)).toEqual(['deepseek-v4-flash']);
    });

    it('rejects catalogs containing only non-chat models', async () => {
        const data = [
            { id: 'qwen_image', supported_endpoint_types: ['image-generation'] },
            { id: 'ltx_2_3', supported_endpoint_types: ['openai-video'] },
        ];

        await expect(
            __modelManager.parseManagedModels({ json: async () => ({ data }) }),
        ).rejects.toMatchObject({ code: 'upstream' });
        await expect(
            __modelManager.parseFallbackModels({ json: async () => ({ data }) }),
        ).rejects.toMatchObject({ code: 'upstream' });
    });

    it('rejects a malformed successful response', async () => {
        await expect(
            __modelManager.parseManagedModels({ json: async () => ({ models: [] }) }),
        ).rejects.toMatchObject({ code: 'upstream' });
    });

    it('keeps settings reachable when the saved model loses every supported DSH protocol', async () => {
        const harness = credentialHarness('tk-capability-drift', true);
        const status = await __modelManager.modelManagerStatus(harness.ctx, async () => ({
            status: 200,
            json: async () => ({
                data: [
                    {
                        id: TOKENSAPI.mainModel,
                        supported_endpoint_types: ['gemini'],
                    },
                    {
                        id: TOKENSAPI.visionModel,
                        supported_endpoint_types: ['openai'],
                    },
                ],
            }),
        }));

        expect(status).toMatchObject({
            authenticated: true,
            api: '',
            modelsAvailable: true,
        });
        expect(status.modelListError).toMatch(/暂不支持 DSH/);
        expect(status.modelListErrorCode).toBe('unsupported_model');
    });

    it('rejects an empty usable model list', async () => {
        await expect(
            __modelManager.parseManagedModels({ json: async () => ({ data: [{ id: '' }, {}] }) }),
        ).rejects.toMatchObject({ code: 'upstream' });
    });

    it('rejects an implausibly large model list', async () => {
        await expect(
            __modelManager.parseManagedModels({
                json: async () => ({
                    data: Array.from({ length: 1001 }, (_, id) => ({ id: String(id) })),
                }),
            }),
        ).rejects.toMatchObject({ code: 'upstream' });
    });

    it('keeps both documented defaults after the first verified key', async () => {
        const harness = credentialHarness();
        const status = await __modelManager.setManagedCredential(
            harness.ctx,
            'tk-default-models',
            VALID_RESPONSE,
        );
        expect(status.mainModel).toBe(TOKENSAPI.mainModel);
        expect(status.visionModel).toBe(TOKENSAPI.visionModel);
    });

    it('accepts two choices from the discovered list', async () => {
        const harness = credentialHarness();
        await __modelManager.setManagedCredential(harness.ctx, 'tk-model-choice', VALID_RESPONSE);
        const status = await __modelManager.setManagedModels(
            harness.ctx,
            { mainModel: 'deepseek-v3.2', visionModel: 'qwen3.6-35b-a3b' },
            VALID_RESPONSE,
        );
        expect(status).toMatchObject({
            mainModel: 'deepseek-v3.2',
            api: 'openai-completions',
            visionModel: 'qwen3.6-35b-a3b',
            modelsAvailable: true,
        });
        expect(__modelManager.selectedVisionModel(harness.ctx)).toBe('qwen3.6-35b-a3b');
    });

    it('persists a protocol per model and restores it when switching back', async () => {
        const harness = credentialHarness();
        await __modelManager.setManagedCredential(
            harness.ctx,
            'tk-protocol-choice',
            VALID_RESPONSE,
        );

        const responses = await __modelManager.setManagedModels(
            harness.ctx,
            {
                mainModel: 'deepseek-v3.2',
                api: 'openai-responses',
                visionModel: TOKENSAPI.visionModel,
            },
            VALID_RESPONSE_AND_PROTOCOL,
        );
        expect(responses.api).toBe('openai-responses');
        expect(
            responses.models.find((model: { id: string }) => model.id === 'deepseek-v3.2'),
        ).toMatchObject({
            api: 'openai-responses',
        });

        await __modelManager.setManagedModels(
            harness.ctx,
            {
                mainModel: 'qwen3.6-35b-a3b',
                api: 'openai-completions',
                visionModel: TOKENSAPI.visionModel,
            },
            VALID_RESPONSE,
        );
        const restored = await __modelManager.setManagedModels(
            harness.ctx,
            { mainModel: 'deepseek-v3.2', visionModel: TOKENSAPI.visionModel },
            VALID_RESPONSE,
        );
        expect(restored.api).toBe('openai-responses');
    });

    it('rejects a protocol that the selected model cannot serve', async () => {
        const harness = credentialHarness();
        // gpt-5.5 is the Responses-only model here; it is listed only with the switch on.
        __modelManager.allowGptModels(harness.ctx, true);
        await __modelManager.setManagedCredential(
            harness.ctx,
            'tk-invalid-protocol',
            VALID_RESPONSE,
        );
        await expect(
            __modelManager.setManagedModels(
                harness.ctx,
                {
                    mainModel: 'gpt-5.5',
                    api: 'openai-completions',
                    visionModel: TOKENSAPI.visionModel,
                },
                VALID_RESPONSE,
            ),
        ).rejects.toMatchObject({ code: 'unsupported_protocol' });
    });

    it('rejects a model id that was not returned by TokensAPI', async () => {
        const harness = credentialHarness();
        await __modelManager.setManagedCredential(harness.ctx, 'tk-model-choice', VALID_RESPONSE);
        await expect(
            __modelManager.setManagedModels(
                harness.ctx,
                { mainModel: 'attacker/model', visionModel: TOKENSAPI.visionModel },
                VALID_RESPONSE,
            ),
        ).rejects.toMatchObject({ code: 'invalid_model' });
    });

    it('does not return the key while returning public model metadata', async () => {
        const harness = credentialHarness();
        const status = await __modelManager.setManagedCredential(
            harness.ctx,
            'tk-never-return-this',
            VALID_RESPONSE,
        );
        expect(status.models).toEqual(PUBLIC_API_MODELS);
        expect(JSON.stringify(status)).not.toContain('tk-never-return-this');
    });

    it('reveals a saved key only through the explicit verified-key action', async () => {
        const harness = credentialHarness('tk-explicit-reveal', true);
        await expect(__modelManager.revealManagedCredential(harness.ctx)).resolves.toEqual({
            apiKey: 'tk-explicit-reveal',
        });
        harness.verification = 'sha256:not-the-key';
        await expect(__modelManager.revealManagedCredential(harness.ctx)).rejects.toMatchObject({
            code: 'unauthenticated',
        });
    });

    it('persists choices and updates the live chat provider plus Agent default', async () => {
        const credential = credentialHarness();
        const values = new Map<string, Record<string, unknown>>();
        const updates: Array<{ namespace: string; patch: Record<string, unknown> }> = [];
        const selections: Array<{ provider: string; model: string }> = [];
        const registeredRoutes: Array<{ name?: string; kind?: string; path?: string }> = [];
        const settings = {
            register: (
                namespace: string,
                _schema: unknown,
                options?: { base?: Record<string, unknown> },
            ) => {
                if (!values.has(namespace)) values.set(namespace, { ...(options?.base ?? {}) });
                return { get: () => values.get(namespace) };
            },
            get: (namespace: string) => values.get(namespace),
            update: async (namespace: string, patch: Record<string, unknown>) => {
                updates.push({ namespace, patch });
                values.set(namespace, { ...(values.get(namespace) ?? {}), ...patch });
            },
        };
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.includes('settings')) callback({ settings });
                if (services.includes('webServer')) {
                    callback({
                        webServer: {
                            port: 43120,
                            register: (route: { name?: string; kind?: string; path?: string }) => {
                                registeredRoutes.push(route);
                                return () => {};
                            },
                        },
                    });
                }
                if (services.includes('agentDefaultModel')) {
                    callback({
                        agentDefaultModel: {
                            saveSelection: async (selection: {
                                provider: string;
                                model: string;
                            }) => {
                                selections.push(selection);
                            },
                        },
                    });
                }
            },
        };
        apply(ctx, {
            allowGptModels: true,
            visionProvider: false,
            settingsCard: false,
            pasteToPath: false,
        });
        await Promise.resolve();
        expect(registeredRoutes).not.toContainEqual(
            expect.objectContaining({ name: 'tokens-model-manager-claude-proxy' }),
        );
        await __modelManager.setManagedCredential(ctx, 'tk-live-settings', VALID_RESPONSE);
        const status = await __modelManager.setManagedModels(
            ctx,
            {
                baseURL: 'https://gateway.example/v1/',
                mainModel: 'deepseek-v3.2',
                visionModel: 'qwen3.6-35b-a3b',
            },
            VALID_RESPONSE,
        );

        const managedPatch = [...updates]
            .reverse()
            .find((entry) => entry.namespace === TOKENSAPI.llmSettingsNamespace)?.patch as
            | {
                  providers?: { tokensapi?: { models?: Array<{ id: string }> } };
              }
            | undefined;
        const managedModels = managedPatch?.providers?.tokensapi?.models;

        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            baseURL: 'https://gateway.example/v1',
            mainModel: 'deepseek-v3.2',
            visionModel: 'qwen3.6-35b-a3b',
        });
        expect(
            [...updates]
                .reverse()
                .find((entry) => entry.namespace === TOKENSAPI.llmSettingsNamespace)?.patch,
        ).toMatchObject({
            providers: {
                tokensapi: {
                    baseURL: 'https://gateway.example/v1',
                    api: 'openai-completions',
                    models: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'deepseek-v3.2',
                            name: 'DeepSeek V3.2',
                            input: ['text'],
                        }),
                        expect.objectContaining({ id: 'deepseek-v4-flash' }),
                        expect.objectContaining({ id: 'qwen3.6-35b-a3b' }),
                    ]),
                },
            },
        });
        // The route carries every selectable managed model, including the ones
        // whose protocol is not the one in force: DSH 0.2 refuses to select a
        // model the Host does not advertise, so narrowing this list by protocol
        // is what made cross-protocol models unselectable.
        expect(managedModels?.map((model) => model.id)).toEqual([
            'deepseek-v3.2',
            'deepseek-v4-flash-vision-exp',
            'deepseek-v4-flash',
            'qwen3.6-35b-a3b',
            'qwen3.8-flash-next',
            'claude-opus-4-7',
            'gpt-5.5',
        ]);
        // The conversation catalog now matches the settings selector.
        expect(status.models).toEqual(directPublic(gptAware(true)));
        // Same set as the settings selector; the route only reorders it so the
        // main model leads.
        expect([...(managedModels ?? [])].map((model) => model.id).sort()).toEqual(
            directPublic(gptAware(true))
                .map((model) => model.id)
                .sort(),
        );
        expect(status.baseURL).toBe('https://gateway.example/v1');
        expect(selections.at(-1)).toEqual({
            provider: TOKENSAPI.providerId,
            model: 'deepseek-v3.2',
        });

        await __modelManager.setManagedModels(
            ctx,
            { mainModel: 'gpt-5.5', visionModel: 'qwen3.6-35b-a3b' },
            VALID_RESPONSE,
        );
        expect(
            [...updates]
                .reverse()
                .find((entry) => entry.namespace === TOKENSAPI.llmSettingsNamespace)?.patch,
        ).toMatchObject({
            providers: {
                tokensapi: {
                    api: 'openai-responses',
                    baseURL: 'https://gateway.example/v1',
                    models: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'gpt-5.5',
                            compat: { supportsMaxOutputTokens: false },
                        }),
                    ]),
                },
            },
        });

        await __modelManager.setManagedModels(
            ctx,
            { mainModel: 'claude-opus-4-7', visionModel: 'qwen3.6-35b-a3b' },
            VALID_RESPONSE,
        );
        expect(
            [...updates]
                .reverse()
                .find((entry) => entry.namespace === TOKENSAPI.llmSettingsNamespace)?.patch,
        ).toMatchObject({
            providers: {
                tokensapi: {
                    api: 'anthropic-messages',
                    baseURL: expect.stringMatching(
                        /^http:\/\/127\.0\.0\.1:\d+\/tokens\/model-manager\/claude-proxy$/,
                    ),
                    models: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'claude-opus-4-7',
                            name: 'Claude Opus 4.7',
                            input: ['text', 'image'],
                        }),
                    ]),
                },
            },
        });
        expect(selections.at(-1)).toEqual({
            provider: TOKENSAPI.providerId,
            model: 'claude-opus-4-7',
        });
        await __modelManager.closeClaudeProxy(ctx);
    });
});

describe('models TokensAPI no longer offers (T0064)', () => {
    type Saved = Record<string, unknown>;
    type Selection = { provider: string; model: string };

    /** A started plugin whose saved choices are `saved`, with a Host default-model service. */
    function startWith(saved: Saved, official?: string, config: Saved = {}) {
        const credential = credentialHarness('tk-primary', true);
        if (official !== undefined) credential.official = official;
        const selections: Selection[] = [];
        const values = new Map<string, Record<string, unknown>>([
            [TOKENSAPI.settingsNamespace, { baseURL: TOKENSAPI.baseURL, ...saved }],
            [TOKENSAPI.llmSettingsNamespace, { providers: {} }],
        ]);
        const settings = {
            register: (namespace: string, _schema: unknown, options?: { base?: Saved }) => {
                if (!values.has(namespace)) values.set(namespace, { ...(options?.base ?? {}) });
                return { get: () => values.get(namespace) };
            },
            get: (namespace: string) => values.get(namespace),
            update: async (namespace: string, patch: Saved) => {
                values.set(namespace, { ...(values.get(namespace) ?? {}), ...patch });
            },
        };
        const ctx = {
            ...credential.ctx,
            tools: { register: () => {} },
            inject: (services: string[], callback: (scope: Record<string, unknown>) => void) => {
                if (services.includes('settings')) callback({ settings });
                if (services.includes('agentDefaultModel')) {
                    callback({
                        agentDefaultModel: {
                            saveSelection: async (selection: Selection) => {
                                selections.push(selection);
                            },
                        },
                    });
                }
            },
        };
        apply(ctx, { visionProvider: false, settingsCard: false, pasteToPath: false, ...config });
        return { ctx, credential, selections, values };
    }

    /** A TokensAPI catalogue with exactly these entries. */
    function catalog(entries: Array<Record<string, unknown>>) {
        return async () => ({ status: 200, json: async () => ({ data: entries }) });
    }
    const chat = (id: string) => ({ id, supported_endpoint_types: ['openai'] });
    const failures: Array<[string, () => Promise<unknown>]> = [
        ['HTTP 500', async () => ({ status: 500, json: async () => ({}) })],
        ['HTTP 503', async () => ({ status: 503, json: async () => ({}) })],
        ['a rejected key', async () => ({ status: 401, json: async () => ({}) })],
        [
            'a network failure',
            async () => {
                throw Object.assign(new TypeError('fetch failed'), {
                    cause: { code: 'ECONNRESET' },
                });
            },
        ],
        ['an unreadable body', async () => ({ status: 200, json: async () => ({ data: 'nope' }) })],
        ['an empty catalogue', async () => ({ status: 200, json: async () => ({ data: [] }) })],
    ];

    it('ships deepseek-v4-flash-vision-exp as the default, read natively with known limits', () => {
        expect(TOKENSAPI.mainModel).toBe('deepseek-v4-flash-vision-exp');
        expect(TOKENSAPI.visionModel).toBe('qwen3.8-flash-next');
        expect(__modelManager.managedVisionMode({ id: 'deepseek-v4-flash-vision-exp' })).toBe(
            'native',
        );
        // The text model of the same name keeps the bridge.
        expect(__modelManager.managedVisionMode({ id: 'deepseek-v4-flash' })).toBe('bridge');
        expect(
            __modelManager.managedModelContextWindow({ id: 'deepseek-v4-flash-vision-exp' }),
        ).toBe(262144);
        expect(__modelManager.managedModelMaxTokens({ id: 'deepseek-v4-flash-vision-exp' })).toBe(
            32768,
        );
        const patch = fs.readFileSync(path.join(__dirname, '..', 'cordis.patch.yml'), 'utf-8');
        expect(patch).toContain('model: deepseek-v4-flash-vision-exp');
        expect(patch).toContain('- id: deepseek-v4-flash-vision-exp');
        expect(patch).not.toMatch(/model: deepseek-v4-flash\s*$/m);
    });

    it('routes the default straight to TokensAPI, never through the vision bridge', async () => {
        const { ctx, selections } = startWith({});
        const status = await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE);
        expect(status).toMatchObject({
            mainModel: 'deepseek-v4-flash-vision-exp',
            mainProvider: TOKENSAPI.providerId,
            visionMode: 'native',
        });
        expect(status.modelNotice).toBeUndefined();
        expect(selections.at(-1)).toEqual({
            provider: TOKENSAPI.providerId,
            model: 'deepseek-v4-flash-vision-exp',
        });
    });

    it('replaces an offline main model with the default, saves the Host default and says so', async () => {
        const { ctx, selections, values } = startWith({ mainModel: 'retired-model-a' });
        // Start-up re-applies the saved default before any list is known.
        for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 5));
        const beforeRefresh = selections.length;
        const status = await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE);

        expect(status).toMatchObject({
            mainModel: 'deepseek-v4-flash-vision-exp',
            activeMainModel: 'deepseek-v4-flash-vision-exp',
            mainProvider: TOKENSAPI.providerId,
            modelNotice: {
                id: expect.any(String),
                changes: [
                    { kind: 'main', from: 'retired-model-a', to: 'deepseek-v4-flash-vision-exp' },
                ],
            },
        });
        // Host default and the manager's own copy both moved: no dropdown
        // showing A while the kernel fails on it.
        expect(selections.at(-1)).toEqual({
            provider: TOKENSAPI.providerId,
            model: 'deepseek-v4-flash-vision-exp',
        });
        expect(selections.slice(beforeRefresh).map((selection) => selection.model)).not.toContain(
            'retired-model-a',
        );
        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            mainModel: 'deepseek-v4-flash-vision-exp',
        });
        // The route the kernel resolves models from no longer carries A.
        const route = (
            values.get(TOKENSAPI.llmSettingsNamespace) as {
                providers: { tokensapi: { models: Array<{ id: string }> } };
            }
        ).providers.tokensapi;
        expect(route.models[0].id).toBe('deepseek-v4-flash-vision-exp');
        expect(route.models.map((model) => model.id)).not.toContain('retired-model-a');
        // The settings selector no longer offers A as if it were current.
        expect(status.models.map((model: { id: string }) => model.id)).not.toContain(
            'retired-model-a',
        );
    });

    it('falls back to the first usable chat model when the default is gone too', async () => {
        const { ctx, selections } = startWith({ mainModel: 'retired-model-a' });
        const status = await __modelManager.modelManagerStatus(
            ctx,
            catalog([
                // Not chat models: an ASR model and an image-only one.
                chat('whisper-asr'),
                { id: 'image-maker-2', supported_endpoint_types: ['image-generation'] },
                chat('glm-5.2'),
                chat('deepseek-v3.2'),
            ]),
        );
        expect(status).toMatchObject({
            mainModel: 'glm-5.2',
            modelNotice: { changes: [{ kind: 'main', from: 'retired-model-a', to: 'glm-5.2' }] },
        });
        expect(selections.at(-1)).toMatchObject({ model: 'glm-5.2' });
    });

    for (const [label, response] of failures) {
        it(`keeps every selection when the list fetch fails: ${label}`, async () => {
            const { ctx, selections, values } = startWith(
                {
                    mainModel: 'retired-model-a',
                    visionModel: 'retired-vision',
                    fallbackModel: 'gone-fallback',
                },
                'sk-fallback',
            );
            const status = await __modelManager.modelManagerStatus(ctx, response);
            expect(status.mainModel).toBe('retired-model-a');
            expect(status.visionModel).toBe('retired-vision');
            expect(status.official.mainModel).toBe('gone-fallback');
            expect(status.modelNotice).toBeUndefined();
            expect(status.modelsAvailable).toBe(false);
            expect(selections.every((selection) => selection.model === 'retired-model-a')).toBe(
                true,
            );
            expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
                mainModel: 'retired-model-a',
                visionModel: 'retired-vision',
                fallbackModel: 'gone-fallback',
            });
        });
    }

    it('keeps the selection when a new key cannot load the list', async () => {
        const { ctx } = startWith({ mainModel: 'retired-model-a' });
        await expect(
            __modelManager.setManagedCredential(ctx, 'tk-replacement', failures[0][1]),
        ).rejects.toMatchObject({ code: 'upstream' });
        const status = await __modelManager.modelManagerStatus(ctx, failures[0][1], {
            refreshModels: false,
        });
        expect(status.mainModel).toBe('retired-model-a');
        expect(status.modelNotice).toBeUndefined();
    });

    it('replaces an offline model when a new key loads the list', async () => {
        const { ctx, selections } = startWith({ mainModel: 'retired-model-a' });
        const status = await __modelManager.setManagedCredential(
            ctx,
            'tk-replacement',
            VALID_RESPONSE,
        );
        expect(status).toMatchObject({
            mainModel: 'deepseek-v4-flash-vision-exp',
            modelNotice: { changes: [{ kind: 'main', from: 'retired-model-a' }] },
        });
        expect(selections.at(-1)).toMatchObject({ model: 'deepseek-v4-flash-vision-exp' });
    });

    it('keeps a model that is still listed, without a notice', async () => {
        const { ctx, selections } = startWith({
            mainModel: 'deepseek-v3.2',
            visionModel: 'qwen3.6-35b-a3b',
        });
        const status = await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE);
        expect(status).toMatchObject({
            mainModel: 'deepseek-v3.2',
            visionModel: 'qwen3.6-35b-a3b',
        });
        expect(status.modelNotice).toBeUndefined();
        expect(selections.at(-1)).toMatchObject({ model: 'deepseek-v3.2' });
    });

    it('replaces an offline vision model with its default, then with the first one that sees images', async () => {
        const first = startWith({ mainModel: 'deepseek-v3.2', visionModel: 'retired-vision' });
        const status = await __modelManager.modelManagerStatus(first.ctx, VALID_RESPONSE);
        expect(status).toMatchObject({
            mainModel: 'deepseek-v3.2',
            visionModel: 'qwen3.8-flash-next',
            modelNotice: {
                changes: [{ kind: 'vision', from: 'retired-vision', to: 'qwen3.8-flash-next' }],
            },
        });
        expect(first.values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            visionModel: 'qwen3.8-flash-next',
        });

        // Default gone as well: a text model would read nothing, so the first
        // listed model that accepts images is taken, not the first listed.
        const second = startWith({ mainModel: 'deepseek-v3.2', visionModel: 'retired-vision' });
        const narrowed = await __modelManager.modelManagerStatus(
            second.ctx,
            catalog([chat('deepseek-v3.2'), chat('glm-5.2'), chat('kimi-k3')]),
        );
        expect(narrowed.visionModel).toBe('kimi-k3');
    });

    it('reports main and vision replacements in one notice', async () => {
        const { ctx } = startWith({ mainModel: 'retired-model-a', visionModel: 'retired-vision' });
        const status = await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE);
        expect(status.modelNotice.changes).toEqual([
            {
                kind: 'main',
                from: 'retired-model-a',
                to: 'deepseek-v4-flash-vision-exp',
                reason: 'offline',
            },
            { kind: 'vision', from: 'retired-vision', to: 'qwen3.8-flash-next', reason: 'offline' },
        ]);
    });

    it('replaces an offline fallback model and moves the Host default while that route is active', async () => {
        const { ctx, selections, values } = startWith(
            {
                fallbackModel: 'gone-fallback',
                fallbackBaseURL: 'https://backup.example/v1',
                activeChannel: 'official',
            },
            'sk-fallback',
        );
        const request = async (url: unknown) =>
            String(url) === `${TOKENSAPI.baseURL}/models` ? VALID_RESPONSE() : FALLBACK_RESPONSE();
        const status = await __modelManager.modelManagerStatus(ctx, request);
        expect(status).toMatchObject({
            channel: 'official',
            activeMainModel: 'deepseek-chat',
            official: { mainModel: 'deepseek-chat', modelsChecked: true },
            modelNotice: {
                changes: [{ kind: 'fallback', from: 'gone-fallback', to: 'deepseek-chat' }],
            },
        });
        expect(selections.at(-1)).toEqual({
            provider: DEEPSEEK_OFFICIAL.providerId,
            model: 'deepseek-chat',
        });
        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            fallbackModel: 'deepseek-chat',
        });
        expect(values.get(TOKENSAPI.llmSettingsNamespace)).toMatchObject({
            providers: {
                [DEEPSEEK_OFFICIAL.upstreamProviderId]: {
                    models: expect.arrayContaining([
                        expect.objectContaining({ id: 'deepseek-chat' }),
                    ]),
                },
            },
        });
    });

    it('replaces a parked fallback model without touching the active TokensAPI default', async () => {
        const { ctx, selections } = startWith(
            { mainModel: 'deepseek-v3.2', fallbackModel: 'gone-fallback' },
            'sk-fallback',
        );
        const request = async (url: unknown) =>
            String(url) === `${TOKENSAPI.baseURL}/models` ? VALID_RESPONSE() : FALLBACK_RESPONSE();
        const status = await __modelManager.modelManagerStatus(ctx, request);
        expect(status).toMatchObject({
            channel: 'tokensapi',
            official: { mainModel: 'deepseek-chat' },
        });
        expect(selections.at(-1)).toMatchObject({ model: 'deepseek-v3.2' });
        expect(
            selections.some((selection) => selection.provider === DEEPSEEK_OFFICIAL.providerId),
        ).toBe(false);
    });

    it('keeps the fallback model when only its list fails, and checks again on the next refresh', async () => {
        const { ctx } = startWith(
            { fallbackModel: 'gone-fallback', activeChannel: 'official' },
            'sk-fallback',
        );
        let fallbackUp = false;
        const request = async (url: unknown) =>
            String(url) === `${TOKENSAPI.baseURL}/models`
                ? VALID_RESPONSE()
                : fallbackUp
                  ? FALLBACK_RESPONSE()
                  : { status: 503, json: async () => ({}) };
        const down = await __modelManager.modelManagerStatus(ctx, request);
        expect(down.official).toMatchObject({ mainModel: 'gone-fallback', modelsChecked: false });
        expect(down.modelNotice).toBeUndefined();
        fallbackUp = true;
        const up = await __modelManager.modelManagerStatus(ctx, request);
        expect(up.official).toMatchObject({ mainModel: 'deepseek-chat', modelsChecked: true });
    });

    it('keeps the notice until the user dismisses it or saves the settings page', async () => {
        const { ctx } = startWith({ mainModel: 'retired-model-a' });
        const replaced = await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE);
        const id = replaced.modelNotice.id;
        // Reads and stale dismissals leave it in place.
        expect((await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE)).modelNotice?.id).toBe(
            id,
        );
        expect(
            (await __modelManager.dismissModelNotice(ctx, { id: 'older' }, VALID_RESPONSE))
                .modelNotice?.id,
        ).toBe(id);
        expect(
            (await __modelManager.dismissModelNotice(ctx, { id }, VALID_RESPONSE)).modelNotice,
        ).toBeUndefined();

        const again = startWith({ mainModel: 'retired-model-a' });
        await __modelManager.modelManagerStatus(again.ctx, VALID_RESPONSE);
        const saved = await __modelManager.setManagedModels(
            again.ctx,
            { mainModel: 'deepseek-v3.2', visionModel: 'qwen3.8-flash-next' },
            VALID_RESPONSE,
        );
        expect(saved.modelNotice).toBeUndefined();
    });

    // ---- 追加 1: models that are not conversation models never load ----

    // One per rule at least; the user's own list (2026-11-03) is in here verbatim.
    const EXCLUDED: Array<[string, string]> = [
        ['gpt-5.5', 'gpt'],
        ['gpt-5.6-sol', 'gpt'],
        ['gpt-5.6-luna', 'gpt'],
        ['gpt-5.6-terra', 'gpt'],
        ['gpt-6-sol', 'gpt'],
        ['gpt-6-astra', 'gpt'],
        ['gpt-6.1-sol', 'gpt'],
        ['GPT-7_Future', 'gpt'],
        ['openai/gpt-7-future', 'gpt'],
        ['codex-auto-review', 'codex'],
        ['acme-codex-mini', 'codex'],
        ['qwen3-embedding', 'embedding'],
        ['text-embedding-3-small', 'embedding'],
        ['nomic-embed-text', 'embedding'],
        ['bge-reranker-v2-m3', 'embedding'],
        ['jina-rerank-m0', 'embedding'],
        ['qwen3-asr', 'speech'],
        ['whisper-1', 'speech'],
        ['cosyvoice-tts', 'speech'],
        ['qwen-audio-turbo', 'speech'],
        ['azure-speech-2', 'speech'],
        ['dall-e-3', 'media'],
        ['acme-image-gen-1', 'media'],
        ['flux.1-dev', 'media'],
        ['sora-2', 'media'],
        ['doubao-seedream-4.0', 'media'],
        ['doubao-seedance-1.0-pro', 'media'],
        ['wanx-v1', 'media'],
        ['kling-v2', 'media'],
        ['cogview-t2i', 'media'],
        ['hunyuan-t2v', 'media'],
        ['omni-moderation-latest', 'moderation'],
        ['startlux-27b', 'decision'],
        ['StartLux-9b', 'decision'],
    ];
    // Must never be caught: the ticket's list, plus near misses of each rule.
    const KEPT = [
        'deepseek-v4-flash-vision-exp',
        'qwen3.8-flash-next',
        'qwen3-vl-plus',
        'kimi-k3',
        'claude-opus-5-5',
        'glm-5.3-flashx',
        'gemma-4-27b-a4b',
        'nemotron-3.5-lightning-30b-a3b',
        'ornith1.5-35b-a3b',
        'deepseek-v3.2',
        'qwen3.6-35b-a3b',
        // A rule word inside a longer segment is not that segment.
        'speechless-llama2-13b',
        'embedded-coder-7b',
        'sparkling-chat-8b',
    ];

    it('names one rule for every excluded kind, and leaves conversation models alone', () => {
        for (const [id, kind] of EXCLUDED) {
            expect(__modelManager.excludedModelKind(id), id).toBe(kind);
        }
        for (const id of KEPT) expect(__modelManager.excludedModelKind(id), id).toBe('');
        const kinds = new Set(
            __modelManager.excludedModelRules.map((rule: { kind: string }) => rule.kind),
        );
        expect([...kinds].sort()).toEqual(
            ['codex', 'decision', 'embedding', 'gpt', 'media', 'moderation', 'speech'].sort(),
        );
        // The switch lifts gpt-* only; Codex and the rest stay out.
        expect(__modelManager.excludedModelKind('gpt-6-sol', { allowGpt: true })).toBe('');
        expect(__modelManager.excludedModelKind('codex-auto-review', { allowGpt: true })).toBe(
            'codex',
        );
        expect(__modelManager.excludedModelKind('qwen3-embedding', { allowGpt: true })).toBe(
            'embedding',
        );
    });

    it('drops excluded models from both catalogues, and brings gpt-* back only when allowed', async () => {
        const data = [...EXCLUDED.map(([id]) => chat(id)), ...KEPT.map(chat)];
        const response = { json: async () => ({ data }) };
        const ids = (models: Array<{ id: string }>) => models.map((model) => model.id);
        expect(ids(await __modelManager.parseManagedModels(response))).toEqual(KEPT);
        expect(ids(await __modelManager.parseFallbackModels(response))).toEqual(KEPT);
        const gpt = EXCLUDED.filter(([, kind]) => kind === 'gpt').map(([id]) => id);
        expect(ids(await __modelManager.parseManagedModels(response, { allowGpt: true }))).toEqual([
            ...gpt,
            ...KEPT,
        ]);
        expect(ids(await __modelManager.parseFallbackModels(response, { allowGpt: true }))).toEqual(
            [...gpt, ...KEPT],
        );
    });

    /** The user's catalogue from 2026-11-03, trimmed: what TokensAPI lists today. */
    const userCatalog = () =>
        catalog(
            [
                'gpt-5.5',
                'gpt-6-sol',
                'gpt-6-astra',
                'codex-auto-review',
                'qwen3-embedding',
                'qwen3-asr',
                'startlux-27b',
                'deepseek-v4-flash-vision-exp',
                'qwen3.8-flash-next',
                'kimi-k3',
            ].map(chat),
        );

    it('moves a user on gpt-6-sol to the default on upgrade, and says it is not offered here', async () => {
        const { ctx, selections, values } = startWith({ mainModel: 'gpt-6-sol' });
        const status = await __modelManager.modelManagerStatus(ctx, userCatalog());
        expect(status).toMatchObject({
            mainModel: 'deepseek-v4-flash-vision-exp',
            activeMainModel: 'deepseek-v4-flash-vision-exp',
            modelNotice: {
                changes: [
                    {
                        kind: 'main',
                        from: 'gpt-6-sol',
                        to: 'deepseek-v4-flash-vision-exp',
                        reason: 'filtered',
                    },
                ],
            },
        });
        expect(selections.at(-1)).toEqual({
            provider: TOKENSAPI.providerId,
            model: 'deepseek-v4-flash-vision-exp',
        });
        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
            mainModel: 'deepseek-v4-flash-vision-exp',
        });
        // Neither the settings selector nor the route the composer reads offers them.
        const offered = ['deepseek-v4-flash-vision-exp', 'qwen3.8-flash-next', 'kimi-k3'];
        expect(status.models.map((model: { id: string }) => model.id).sort()).toEqual(
            offered.sort(),
        );
        const route = (
            values.get(TOKENSAPI.llmSettingsNamespace) as {
                providers: { tokensapi: { models: Array<{ id: string }> } };
            }
        ).providers.tokensapi;
        expect(route.models.map((model) => model.id).sort()).toEqual(offered.sort());
    });

    it('keeps gpt-6-sol and lists gpt-* when allowGptModels is on', async () => {
        const { ctx, selections } = startWith({ mainModel: 'gpt-6-sol' }, undefined, {
            allowGptModels: true,
        });
        const status = await __modelManager.modelManagerStatus(ctx, userCatalog());
        expect(status.mainModel).toBe('gpt-6-sol');
        expect(status.modelNotice).toBeUndefined();
        expect(selections.at(-1)?.model).toBe('gpt-6-sol');
        const listed = status.models.map((model: { id: string }) => model.id);
        expect(listed).toEqual(expect.arrayContaining(['gpt-5.5', 'gpt-6-sol', 'gpt-6-astra']));
        // Only gpt-* comes back.
        for (const id of ['codex-auto-review', 'qwen3-embedding', 'qwen3-asr', 'startlux-27b']) {
            expect(listed).not.toContain(id);
        }
    });

    it('moves a filtered vision model back to the default vision model', async () => {
        const { ctx } = startWith({ mainModel: 'kimi-k3', visionModel: 'gpt-6-astra' });
        const status = await __modelManager.modelManagerStatus(ctx, userCatalog());
        expect(status.mainModel).toBe('kimi-k3');
        expect(status.visionModel).toBe('qwen3.8-flash-next');
        expect(status.modelNotice.changes).toEqual([
            { kind: 'vision', from: 'gpt-6-astra', to: 'qwen3.8-flash-next', reason: 'filtered' },
        ]);
    });

    it('moves a filtered fallback model to the first usable one of its catalogue', async () => {
        const { ctx, selections } = startWith(
            {
                fallbackModel: 'gpt-5.5',
                fallbackBaseURL: 'https://backup.example/v1',
                activeChannel: 'official',
            },
            'sk-fallback',
        );
        const fallback = catalog([chat('gpt-5.5'), chat('qwen3-embedding'), chat('deepseek-chat')]);
        const request = async (url: unknown) =>
            String(url) === `${TOKENSAPI.baseURL}/models` ? VALID_RESPONSE() : fallback();
        const status = await __modelManager.modelManagerStatus(ctx, request);
        expect(status.official).toMatchObject({ mainModel: 'deepseek-chat', modelsChecked: true });
        expect(status.official.models.map((model: { id: string }) => model.id)).toEqual([
            'deepseek-chat',
        ]);
        expect(status.modelNotice.changes).toEqual([
            { kind: 'fallback', from: 'gpt-5.5', to: 'deepseek-chat', reason: 'filtered' },
        ]);
        expect(selections.at(-1)).toEqual({
            provider: DEEPSEEK_OFFICIAL.providerId,
            model: 'deepseek-chat',
        });
    });
});
