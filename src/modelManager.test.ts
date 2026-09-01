import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The DSH entry is deliberately dependency-free plain JS.
import { __modelManager, apply, DEEPSEEK_OFFICIAL, TOKENSAPI } from '../dsh/index.js';
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

const API_MODELS = [
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

const PUBLIC_API_MODELS = API_MODELS.map((model) => {
    const protocols = model.id.startsWith('claude-')
        ? [{ id: 'anthropic-messages', label: 'Anthropic Messages' }]
        : [
              { id: 'openai-completions', label: 'Chat Completions' },
              ...(model.id !== 'deepseek-v4-flash' &&
              model.endpointTypes.includes('openai-response')
                  ? [{ id: 'openai-responses', label: 'Responses API' }]
                  : []),
          ];
    return {
        ...model,
        api: protocols[0].id,
        protocols,
        visionMode: ['qwen3.6-35b-a3b', 'claude-opus-4-7', 'gpt-5.5'].includes(model.id)
            ? 'native'
            : 'bridge',
        visionCapabilitySource: 'builtin',
    };
});

const DIRECT_PUBLIC_API_MODELS = PUBLIC_API_MODELS.map((model) => ({
    ...model,
    visionMode: model.visionMode === 'bridge' ? 'direct' : model.visionMode,
}));

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
                mainModel: 'deepseek-v4-flash',
                api: 'openai-completions',
                mainProvider: 'modlens-tokensapi',
                activeMainModel: 'deepseek-v4-flash',
                visionMode: 'bridge',
                visionModel: 'qwen3.6-35b-a3b',
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
            mainProvider: TOKENSAPI.agentProviderId,
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
                    throw new Error('invalid JSON');
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
                mainProvider: TOKENSAPI.agentProviderId,
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
            mainProvider: 'modlens-tokensapi',
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
            mainProvider: TOKENSAPI.agentProviderId,
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
                        expect.objectContaining({ id: 'gpt-5.5', input: ['text'] }),
                    ]),
                },
            },
        });
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
        const status = await __modelManager.modelManagerStatus(ctx, VALID_RESPONSE);
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
        apply(ctx, { settingsCard: false, pasteToPath: false });

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
            api: 'openai-completions',
            mainProvider: TOKENSAPI.agentProviderId,
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

    it('migrates a persisted Flash Responses choice before the first conversation request', async () => {
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
                api: 'openai-completions',
            },
        );
        expect(
            [...updates]
                .reverse()
                .find((entry) => entry.namespace === TOKENSAPI.llmSettingsNamespace)?.patch,
        ).toMatchObject({
            providers: {
                tokensapi: {
                    api: 'openai-completions',
                    defaultContextWindow: 262144,
                    models: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'deepseek-v4-flash',
                            contextWindow: 262144,
                            maxTokens: 32768,
                        }),
                        expect.objectContaining({ id: 'deepseek-v3.2' }),
                        expect.objectContaining({ id: 'qwen3.6-35b-a3b' }),
                        expect.objectContaining({ id: 'gpt-5.5' }),
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

    it('routes native and bridged models through one managed provider', async () => {
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
            provider: TOKENSAPI.agentProviderId,
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
            provider: TOKENSAPI.agentProviderId,
            visionMode: 'native',
            api: 'openai-completions',
            input: ['text', 'image'],
        });
    });

    it('rejects an unknown model until its image handling is explicitly confirmed', async () => {
        await expect(
            __modelManager.resolveManagedMainRoute({}, 'unclassified-text-model'),
        ).rejects.toMatchObject({ code: 'unknown_capability' });

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

    it('routes a future model only after the user chooses native or bridge handling', async () => {
        const harness = credentialHarness();
        const response = managedResponseWithFuture();
        await __modelManager.setManagedCredential(harness.ctx, 'tk-future-route', response);

        await expect(
            __modelManager.setManagedModels(
                harness.ctx,
                { mainModel: FUTURE_MODEL_ID, visionModel: TOKENSAPI.visionModel },
                response,
            ),
        ).rejects.toMatchObject({ code: 'unknown_capability' });

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
        ).resolves.toMatchObject({ visionMode: 'native', input: ['text', 'image'] });

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
        ).resolves.toMatchObject({ visionMode: 'bridge', input: ['text'] });
    });

    it('persists a future-model decision, restores it, and hides unconfirmed models from chat', async () => {
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
        expect(JSON.stringify(beforeConfirmation)).not.toContain(FUTURE_MODEL_ID);

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

    it('keeps DeepSeek V4 Flash on Chat Completions after Responses failures', () => {
        const model = {
            id: 'deepseek-v4-flash',
            endpointTypes: ['openai', 'openai-response', 'openai-response-compact'],
        };
        expect(__modelManager.managedModelApis(model)).toEqual(['openai-completions']);
        expect(__modelManager.managedModelApi(model, 'openai-completions')).toBe(
            'openai-completions',
        );
        expect(() => __modelManager.managedModelApi(model, 'openai-responses')).toThrow(
            '不支持所选请求协议',
        );
        expect(
            __modelManager.normalizeProtocolByModel({
                'deepseek-v4-flash': 'openai-responses',
                'qwen3.6-35b-a3b': 'openai-responses',
            }),
        ).toEqual({
            'deepseek-v4-flash': 'openai-completions',
            'qwen3.6-35b-a3b': 'openai-responses',
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
            VALID_RESPONSE,
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

    it('rejects a protocol that the selected model does not advertise', async () => {
        const harness = credentialHarness();
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
                    api: 'openai-responses',
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
        await Promise.resolve();
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
                        expect.objectContaining({ id: 'gpt-5.5' }),
                    ]),
                },
            },
        });
        // The settings page still receives every API model for its own
        // selector; only the conversation catalog is narrowed.
        expect(status.models).toEqual(DIRECT_PUBLIC_API_MODELS);
        expect(status.baseURL).toBe('https://gateway.example/v1');
        expect(selections.at(-1)).toEqual({
            provider: TOKENSAPI.providerId,
            model: 'deepseek-v3.2',
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
                    models: [
                        {
                            id: 'claude-opus-4-7',
                            name: 'Claude Opus 4.7',
                            input: ['text', 'image'],
                        },
                    ],
                },
            },
        });
        expect(selections.at(-1)).toEqual({
            provider: TOKENSAPI.providerId,
            model: 'claude-opus-4-7',
        });
    });
});
