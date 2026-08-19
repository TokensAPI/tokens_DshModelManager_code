import { describe, expect, it } from 'vitest';
// @ts-expect-error The DSH entry is deliberately dependency-free plain JS.
import { __modelManager, TOKENSAPI } from '../dsh/index.js';
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

const VALID_RESPONSE = async () => ({ status: 200 });

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
        const status = await __modelManager.modelManagerStatus(harness.ctx);
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
                return { status: 200 };
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
