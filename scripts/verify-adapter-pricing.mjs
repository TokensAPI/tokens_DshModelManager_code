// Run with node --test scripts/verify-adapter-pricing.mjs against an existing runtime.
// Optional contract integration against an existing Desktop runtime; no app build
// or live model requests. DSH_RUNTIME_ROOT points at its package directory.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { apply } from '../dsh/index.js';

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
