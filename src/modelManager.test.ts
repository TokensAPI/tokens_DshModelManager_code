import { describe, expect, it } from 'vitest';
// @ts-expect-error The DSH entry is deliberately dependency-free plain JS.
import { __modelManager, apply, TOKENSAPI } from '../dsh/index.js';
import { resolveProviderSettings } from './config.ts';

interface CredentialHarness {
    stored: string | undefined;
    verification: string | undefined;
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
        ctx: {
            credentials: {
                describe: async (ref) => ({
                    configured:
                        ref === TOKENSAPI.credentialRef
                            ? harness.stored !== undefined
                            : harness.verification !== undefined,
                    writable: true,
                    ...(harness.stored === undefined && harness.verification === undefined
                        ? {}
                        : { source: 'file' }),
                }),
                resolve: async (ref) => {
                    const value =
                        ref === TOKENSAPI.credentialRef ? harness.stored : harness.verification;
                    return value === undefined ? undefined : { value };
                },
                set: async (ref, value) => {
                    if (ref === TOKENSAPI.credentialRef) harness.stored = value;
                    else if (ref === TOKENSAPI.verificationRef) harness.verification = value;
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
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'qwen3.6-35b-a3b', name: 'Qwen 3.6 Vision' },
    { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
];

const VALID_RESPONSE = async () => ({
    status: 200,
    json: async () => ({ data: API_MODELS }),
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
                mainModel: 'deepseek-v4-flash',
                visionModel: 'qwen3.6-35b-a3b',
                models: API_MODELS,
                modelsAvailable: true,
                baseURL: 'https://tokensapi.ai/v1',
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
    it('parses, trims and deduplicates the OpenAI-compatible model list', async () => {
        const models = await __modelManager.parseManagedModels({
            json: async () => ({
                data: [
                    { id: ' deepseek-v4-flash ', name: ' DeepSeek V4 Flash ' },
                    { id: 'deepseek-v4-flash', name: 'duplicate' },
                    { id: '' },
                    null,
                    { id: 'qwen3.6-35b-a3b' },
                ],
            }),
        });
        expect(models).toEqual([
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
            { id: 'qwen3.6-35b-a3b', name: 'qwen3.6-35b-a3b' },
        ]);
    });

    it('rejects a malformed successful response', async () => {
        await expect(
            __modelManager.parseManagedModels({ json: async () => ({ models: [] }) }),
        ).rejects.toMatchObject({ code: 'upstream' });
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
            visionModel: 'qwen3.6-35b-a3b',
            modelsAvailable: true,
        });
        expect(__modelManager.selectedVisionModel(harness.ctx)).toBe('qwen3.6-35b-a3b');
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
        expect(status.models).toEqual(API_MODELS);
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
        await __modelManager.setManagedModels(
            ctx,
            { mainModel: 'deepseek-v3.2', visionModel: 'qwen3.6-35b-a3b' },
            VALID_RESPONSE,
        );

        expect(values.get(TOKENSAPI.settingsNamespace)).toMatchObject({
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
                    baseURL: TOKENSAPI.baseURL,
                    models: API_MODELS,
                },
            },
        });
        expect(selections.at(-1)).toEqual({
            provider: TOKENSAPI.agentProviderId,
            model: 'deepseek-v3.2',
        });
    });
});
