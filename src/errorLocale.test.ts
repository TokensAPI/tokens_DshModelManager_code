import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CLIENT_PATH = path.join(__dirname, '..', 'dsh', 'client.js');
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8');
const ENGLISH =
    'Image recognition failed. Please retry or switch the vision model in TokensAPI model settings.';
const CHINESE = '图片识别失败，请重试或在 TokensAPI 模型设置中切换视觉模型。';

describe('model-manager error localization', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('uses the saved host language for failed image reads and cached retries', async () => {
        // @ts-expect-error dependency-free runtime JS
        const plugin = await import('../dsh/index.js');
        let preference = 'en';
        let handler: CallableFunction = () => {};
        const readImage = vi.fn(async () => ({ ref: { mediaType: 'image/png' } }));
        const get = vi.fn((namespace: string) => {
            expect(namespace).toBe('locale');
            return { preference };
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        plugin.apply(
            {
                tools: { register: () => {} },
                settings: { get },
                attachments: { readImage },
                on: (event: string, fn: CallableFunction) => {
                    if (event === 'agent/pre-step') handler = fn;
                },
            },
            { autoRead: true, visionProvider: false },
        );
        const messages = [
            { role: 'user', content: [{ type: 'image', attachment: { id: 'locale-test-image' } }] },
        ];
        const run = () => handler({ messages }, async () => ({ kind: 'enter', messages }));
        for (const [language, message] of [
            ['en', ENGLISH],
            ['zh', CHINESE],
            ['en-US', ENGLISH],
            ['zh-CN', CHINESE],
            ['fr', ENGLISH],
        ]) {
            preference = language;
            await expect(run()).rejects.toMatchObject({
                code: 'MODLENS_VISION_READ_FAILED',
                message,
            });
        }
        expect(readImage).toHaveBeenCalledOnce();
        expect(messages[0].content[0].type).toBe('image');
    });

    it('keeps image failures visible when an older host has no locale namespace', async () => {
        // @ts-expect-error dependency-free runtime JS
        const plugin = await import('../dsh/index.js');
        let handler: CallableFunction = () => {};
        vi.spyOn(console, 'error').mockImplementation(() => {});
        plugin.apply(
            {
                tools: { register: () => {} },
                settings: {
                    get: () => {
                        throw new Error('unknown namespace');
                    },
                },
                attachments: { readImage: async () => ({}) },
                on: (event: string, fn: CallableFunction) => {
                    if (event === 'agent/pre-step') handler = fn;
                },
            },
            { autoRead: true, visionProvider: false },
        );
        const messages = [
            { role: 'user', content: [{ type: 'image', attachment: { id: 'old-host-image' } }] },
        ];
        await expect(
            handler({ messages }, async () => ({ kind: 'enter', messages })),
        ).rejects.toMatchObject({
            code: 'MODLENS_VISION_READ_FAILED',
            message: ENGLISH,
        });
    });

    it('localizes bridge failures before calling the upstream model', async () => {
        // @ts-expect-error dependency-free runtime JS
        const plugin = await import('../dsh/index.js');
        let adapter: Record<string, CallableFunction> = {};
        let preference = 'en';
        const stream = vi.fn(() => (async function* () {})());
        const readImage = vi.fn(async () => ({ ref: { mediaType: 'image/png' } }));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        plugin.apply(
            {
                tools: { register: () => {} },
                settings: { get: () => ({ preference }) },
                attachments: { readImage },
                on: () => {},
                llm: {
                    registerAdapter: (_ids: string[], value: Record<string, CallableFunction>) => {
                        adapter = value;
                    },
                    resolveModelInfo: async () => ({ inputModalities: ['text'] }),
                    providerRetryPolicy: () => undefined,
                    stream,
                },
            },
            { upstream: 'deepseek-official' },
        );
        const messages = [
            {
                role: 'user',
                content: [{ type: 'image', attachment: { id: 'bridge-locale-image' } }],
            },
        ];
        const run = async () => {
            for await (const _chunk of adapter.stream({
                provider: 'deepseek-modlens',
                model: 'deepseek-v4-flash',
                messages,
            })) {
                /* consume */
            }
        };
        await expect(run()).rejects.toMatchObject({
            code: 'MODLENS_VISION_READ_FAILED',
            message: ENGLISH,
        });
        preference = 'zh';
        await expect(run()).rejects.toMatchObject({
            code: 'MODLENS_VISION_READ_FAILED',
            message: CHINESE,
        });
        expect(stream).not.toHaveBeenCalled();
        expect(readImage).toHaveBeenCalledOnce();
    });

    function client(language: string, fetchMock: unknown = () => {}) {
        const document = { documentElement: { lang: language } };
        let definition: { factory: CallableFunction } | undefined;
        // A named script lets V8 attribute executable browser code to its
        // actual source instead of an anonymous Function coverage entry.
        new vm.Script(SOURCE, { filename: CLIENT_PATH }).runInNewContext({
            window: {
                __ModuleLoader__: {
                    load: (value: { factory: CallableFunction }) => {
                        definition = value;
                    },
                },
            },
            document,
            navigator: { language: 'zh-CN' },
            fetch: fetchMock,
            AbortController,
            setTimeout,
            clearTimeout,
        });
        return { document, manager: definition?.factory(() => ({})).__manager };
    }

    it('localizes settings errors by code and follows document language changes', () => {
        const { document, manager } = client('en');
        const codes = [
            'invalid_key',
            'unauthenticated',
            'unreachable',
            'protocol_temporary',
            'unsupported_protocol',
            'unsupported_model',
            'unknown_capability',
            'upstream',
            'invalid_model',
            'invalid_provider',
            'invalid_input',
        ];
        for (const code of codes) {
            document.documentElement.lang = 'en';
            const english = manager.responseError({ code, error: '后台中文错误' }).message;
            expect(english).not.toMatch(/[\u3400-\u9fff]/);
            document.documentElement.lang = 'zh';
            const chinese = manager.responseError({ code, error: 'backend English error' }).message;
            expect(chinese).toMatch(/[\u3400-\u9fff]/);
            expect(chinese).not.toBe(english);
        }
        document.documentElement.lang = 'en';
        const body = { code: 'unsupported_protocol', error: '模型不支持所选请求协议' };
        expect(manager.responseError(body)).toMatchObject({
            code: body.code,
            message: expect.stringContaining('request protocol'),
        });
        expect(
            manager.managerError('missingModel', { provider: 'tokensapi', model: 'model$&' })
                .message,
        ).toContain('tokensapi/model$&');
        document.documentElement.lang = 'zh-CN';
        expect(manager.responseError(body).message).toContain('请求协议');
        expect(manager.managerError('directory').message).toContain('尚未就绪');
        document.documentElement.lang = 'en-US';
        expect(manager.managerError('invalidSelection').message).toContain('invalid state');
        document.documentElement.lang = 'fr';
        expect(manager.managerError('refresh').message).toContain('refresh the model catalog');
        document.documentElement.lang = '';
        expect(manager.managerError('request').message).toBe('请求失败，请重试');
    });

    it('separates unknown diagnostics from localized HTTP and network errors', async () => {
        let networkFailure = false;
        const { document, manager } = client('en', async () => {
            if (networkFailure) throw new TypeError('原始网络诊断');
            return {
                ok: false,
                json: async () => ({ code: 'VENDOR_UNKNOWN', error: '原始上游诊断' }),
            };
        });
        const requests = manager.createManagerRequests();
        const error = vi.fn();
        for (const [language, message] of [
            ['en', 'Request failed. Please retry.'],
            ['zh', '请求失败，请重试'],
        ]) {
            document.documentElement.lang = language;
            networkFailure = false;
            await requests.run('/tokens/model-manager', {}, { error });
            expect(error.mock.calls.at(-1)?.[0]).toMatchObject({
                code: 'VENDOR_UNKNOWN',
                message,
                diagnostic: '原始上游诊断',
            });
            networkFailure = true;
            await requests.run('/tokens/model-manager', {}, { error });
            expect(error.mock.calls.at(-1)?.[0]).toMatchObject({
                message,
                diagnostic: '原始网络诊断',
            });
        }
        expect(requests.active).toBe(false);
    });

    it('shows English coded HTTP errors and timeouts through the real request controller', async () => {
        vi.useFakeTimers();
        let stall = false;
        const { manager } = client('en', async () => ({
            ok: false,
            json: () =>
                stall
                    ? new Promise(() => {})
                    : Promise.resolve({ code: 'invalid_key', error: 'API Key 无效' }),
        }));
        const requests = manager.createManagerRequests();
        const error = vi.fn();
        await requests.run('/tokens/model-manager', {}, { error });
        expect(error.mock.calls[0][0].message).toBe(
            'The API key was rejected. Check the key and retry.',
        );
        stall = true;
        const job = requests.run('/tokens/model-manager', {}, { error });
        await vi.advanceTimersByTimeAsync(25_001);
        await job;
        expect(error.mock.calls[1][0].message).toBe('Request timed out. Please retry.');
        expect(requests.active).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});
