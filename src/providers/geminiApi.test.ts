import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeGeminiApi } from './geminiApi.ts';

const structured = { summary: 'ok', uncertainty: [] };
let tmpImage: string;

beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-gem-'));
    tmpImage = path.join(dir, 'x.png');
    fs.writeFileSync(tmpImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('executeGeminiApi', () => {
    it('demands an api key up front', async () => {
        await expect(
            executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: {},
            }),
        ).rejects.toThrow('GEMINI_API_KEY');
    });

    it('builds a generateContent call with responseJsonSchema and parses the output', async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(
                JSON.stringify({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }],
                    usageMetadata: { totalTokenCount: 9 },
                }),
                { status: 200 },
            );
        });

        const parsed = await executeGeminiApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: { apiKey: 'AIzaTest' },
        });

        expect(calls[0].url).toContain('/v1beta/models/gemini-3.6-flash:generateContent');
        const body = JSON.parse(String(calls[0].init.body));
        expect(body.generationConfig.responseJsonSchema.required).toContain('summary');
        expect(body.contents[0].parts[0].inline_data.data).toBe(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
        );
        expect(parsed.result).toEqual(structured);
        expect(parsed.meta.usage).toEqual({ totalTokenCount: 9 });
    });

    it('adds an extraBody thinking knob while keeping schema enforcement', async () => {
        const calls: Array<{ init: RequestInit }> = [];
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            calls.push({ init });
            return new Response(
                JSON.stringify({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }],
                }),
                { status: 200 },
            );
        });

        await executeGeminiApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: {
                apiKey: 'AIzaTest',
                extraBody: { generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } },
            },
        });

        const body = JSON.parse(String(calls[0].init.body));
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
        expect(body.generationConfig.responseJsonSchema.required).toContain('summary');
    });

    it('surfaces api errors with status and body', async () => {
        vi.stubGlobal('fetch', async () => new Response('quota exceeded', { status: 429 }));
        await expect(
            executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKey: 'AIzaTest' },
            }),
        ).rejects.toThrow('Gemini API error 429');
    });

    it('routes through a configured proxy dispatcher (#20)', async () => {
        const inits: Array<{ dispatcher?: unknown }> = [];
        vi.stubGlobal('fetch', async (_url: string, init: { dispatcher?: unknown }) => {
            inits.push(init);
            return new Response('{}', { status: 500 });
        });
        await executeGeminiApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: { apiKey: 'AIzaTest', proxy: 'http://127.0.0.1:7890' },
        }).catch(() => {});
        expect(inits[0].dispatcher).toBeDefined();
        // And without a proxy, fetch keeps its default direct path.
        await executeGeminiApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: { apiKey: 'AIzaTest' },
        }).catch(() => {});
        expect(inits[1].dispatcher).toBeUndefined();
    });

    it('turns a connect failure into the proxy hint instead of bare fetch failed (#20)', async () => {
        vi.stubGlobal('fetch', async () => {
            throw new TypeError('fetch failed', {
                cause: Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
            });
        });
        await expect(
            executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKey: 'AIzaTest' },
            }),
        ).rejects.toThrow(/HTTPS_PROXY/);
    });
});
