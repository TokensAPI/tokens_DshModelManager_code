import { describe, expect, it } from 'vitest';
// @ts-expect-error The DSH entry is deliberately dependency-free plain JS.
import { __modelManager, TOKENSAPI } from '../dsh/index.js';
import { resolveProviderSettings } from './config.ts';

interface CredentialHarness {
    stored: string | undefined;
    ctx: {
        credentials: {
            describe: () => Promise<{ configured: boolean; writable: boolean; source?: string }>;
            set: (ref: string, value: string) => Promise<void>;
        };
    };
}

function credentialHarness(initial?: string): CredentialHarness {
    const harness: CredentialHarness = {
        stored: initial,
        ctx: {
            credentials: {
                describe: async () => ({
                    configured: harness.stored !== undefined,
                    writable: true,
                    ...(harness.stored === undefined ? {} : { source: 'file' }),
                }),
                set: async (ref, value) => {
                    expect(ref).toBe(TOKENSAPI.credentialRef);
                    harness.stored = value;
                },
            },
        },
    };
    return harness;
}

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
    { name: 'oversized key', input: 'k'.repeat(16 * 1024 + 1) },
];

describe('TokensAPI credential gate: 50 positive cases', () => {
    for (const testCase of VALID_KEYS) {
        it(testCase.name, async () => {
            const harness = credentialHarness();
            const status = await __modelManager.setManagedCredential(harness.ctx, testCase.input);
            expect(harness.stored).toBe(testCase.stored);
            expect(status).toEqual({
                configured: true,
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

    it('never exposes a stored key in status', async () => {
        const harness = credentialHarness('super-secret-key');
        const status = await __modelManager.modelManagerStatus(harness.ctx);
        expect(status.configured).toBe(true);
        expect(JSON.stringify(status)).not.toContain('super-secret-key');
        expect(status).not.toHaveProperty('apiKey');
    });
});
