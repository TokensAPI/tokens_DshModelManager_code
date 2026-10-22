// Part of `npm run check:host`; also runnable directly with
// node --test --test-concurrency=1 scripts/verify-credential-catalog-refresh.mjs
// DSH_HOST_ROOT points at a staged Host's `dsh-plugin-desktop` directory;
// without it every case reports NOT EXECUTED and check:host exits non-zero.
// Run it once per supported Host line — the cases are the same, the Host
// artifact is not.
//
// What a provider route advertises stopped being a function of the adapter
// registry alone. Since DSH 0.2.1 the Host's pi-ai adapter resolves the route's
// apiKey reference inside listModels and advertises an EMPTY catalog while that
// reference does not resolve, so a profile with no key stored has an empty
// TokensAPI group — the ordinary first-run state on TokensCowork 0.7, not a
// failure. `credentials.set` emits no `llm/adapters-updated`, so everything
// this plugin reconciled on that event alone kept the answer it had computed
// before the key existed (T0033).
//
// These cases run against the Host's own llm service and its own file-backed
// credentials provider, so the notification path under test is the real one:
// the stand-in for pi-ai is the upstream route, and it mirrors exactly the one
// rule that matters here (an unresolved key means no models). That stand-in
// applies the rule on both Host lines, including 0.2.0-rc.2, where the real
// pi-ai does not — the 0.2.0 run asserts that this plugin's reconciliation is
// identical on that Host, not that 0.2.0 behaves like 0.2.1.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { __modelManager, apply } from '../dsh/index.js';
import { hostRoot, withoutHost } from './host-contract-harness.mjs';

const MAIN_MODEL = 'deepseek-v4-flash';
// Only a TokensAPI catalog read can produce this one: the plugin's public
// model list always carries the configured main and vision models, whether or
// not it holds a catalog, so "the list is non-empty" proves nothing on its own.
const FETCHED_ONLY_MODEL = 'deepseek-v4-pro';
const CATALOG = [MAIN_MODEL, FETCHED_ONLY_MODEL];
const KEY = 'synthetic-regression-key';

/** The model ids one status read reports. */
const reportedModels = (status) => status.models.map((model) => model.id);

/** The TokensAPI model list the plugin fetches for its own two lists. */
function catalogResponse(reads) {
    return async () => {
        reads.push('tokensapi-catalog');
        return {
            status: 200,
            json: async () => ({
                data: CATALOG.map((id) => ({
                    id,
                    input: ['text'],
                    supported_endpoint_types: ['openai'],
                    contextWindow: 262144,
                    maxTokens: 32768,
                })),
            }),
        };
    };
}

/**
 * Wait for a condition the plugin reaches on its own.
 *
 * The reconciliations under test are triggered by a Host notification and run
 * detached from the write that caused them, which is the whole point: nothing
 * in the user's flow awaits them. Polling is therefore what a caller can do,
 * and the deadline is what turns "never happens" into a failed assertion
 * instead of a hung run.
 *
 * @param describe - what is being waited for, used in the failure message.
 * @param ready - predicate, polled until it holds.
 */
async function until(describe, ready) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (await ready()) return;
        await new Promise((settle) => setTimeout(settle, 10));
    }
    assert.fail(`timed out waiting for ${describe}`);
}

/**
 * Boot the Host halves this plugin talks to: the real llm service, the real
 * file-backed credentials provider, and an upstream route shaped like the
 * Host's pi-ai adapter.
 *
 * The TokensAPI catalog read is served by a stub installed as the global
 * fetch, because the refresh a credential notification triggers has no caller
 * to hand one to — in Desktop it uses the global fetch, so a case that wants
 * to observe it has to replace that.
 *
 * @param t - the case, so the Host, its temporary home and the global fetch
 *   are always restored.
 * @param config - the plugin entry config to apply.
 * @returns the Host context, the plugin's context, the catalog stub, and the
 *   read counters.
 */
async function managedHost(t, config) {
    const require = createRequire(resolve(hostRoot(), 'package.json'));
    const load = (name) => import(pathToFileURL(require.resolve(name)));
    const { Context } = await load('@deepseek-ai/cordis');
    const { LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
    const { default: LocalCredentialProvider } = await load('@deepseek-ai/dsh-credentials-local');
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'modlens-credentials-')));
    const ctx = new Context();
    const llm = new LlmRuntime(ctx);
    new LocalCredentialProvider(ctx, {
        path: join(home, '.credentials.yaml'),
        dshHome: home,
        watch: false,
        debounceMs: 0,
    });
    const upstreamReads = [];
    const catalogReads = [];
    const request = catalogResponse(catalogReads);
    const hostFetch = globalThis.fetch;
    globalThis.fetch = request;
    t.after(() => {
        globalThis.fetch = hostFetch;
    });
    class PiAiShaped extends LlmAdapter {
        providerInfo(provider) {
            return { id: provider, name: 'TokensAPI' };
        }
        // The one upstream rule this case turns on: the route resolves its
        // apiKey reference here, and a reference that does not resolve makes it
        // advertise nothing at all (upstream pi-ai listModels answers `[]` on
        // MISSING_CREDENTIAL rather than failing).
        async listModels(provider) {
            upstreamReads.push(provider);
            const stored = await ctx.credentials.resolve('TOKENSAPI_API_KEY');
            if (!stored?.value) return [];
            return CATALOG.map((id) => ({ provider, id, name: id, inputModalities: ['text'] }));
        }
        async resolveModel(provider, model) {
            return { provider, id: model, name: model, inputModalities: ['text'] };
        }
        stream() {
            throw new Error('a catalog check must not reach the wire');
        }
    }
    llm.registerAdapter(['tokensapi'], new PiAiShaped());
    // No `inject`: this fixture mounts no settings service, so the plugin takes
    // its no-profile-settings path (the route write it would otherwise persist
    // is covered by the settings regressions). `on` is the Host's real bus,
    // which is what carries the credential notifications under test.
    const plugin = {
        llm,
        credentials: ctx.credentials,
        tools: { register() {} },
        on: (event, listener) => ctx.on(event, listener),
    };
    t.after(async () => {
        await ctx.fiber.dispose();
        rmSync(home, { recursive: true, force: true });
    });
    apply(plugin, { settingsCard: false, pasteToPath: false, ...config });
    return { ctx, llm, plugin, request, upstreamReads, catalogReads };
}

/** Whether the Host currently routes this provider id. */
function routed(llm, providerId) {
    return llm.listProviders().some((info) => info.id === providerId);
}

test('real DSH fills the managed group after a key is saved, without a restart', {
    skip: withoutHost(),
}, async (t) => {
    const { llm, plugin, request, catalogReads } = await managedHost(t, {
        upstream: 'tokensapi',
        providerId: 'modlens-tokensapi',
    });
    // The pinned wrapper registers against the route, not against its catalog,
    // so it is routed from the start — and empty, because the upstream route it
    // wraps advertises nothing while the key is missing. This is what a fresh
    // profile looks like on DSH 0.2.1.
    assert.ok(routed(llm, 'modlens-tokensapi'));
    assert.deepEqual(await llm.listModels('tokensapi'), []);
    assert.deepEqual(await llm.listModels('modlens-tokensapi'), []);
    const status = await __modelManager.setManagedCredential(plugin, KEY, request);
    assert.equal(status.authenticated, true);
    assert.ok(reportedModels(status).includes(FETCHED_ONLY_MODEL));
    // Nothing was restarted and no adapter was re-registered: the same wrapper
    // instance now answers with the catalog, because the key it forwards to
    // resolves.
    await until('the managed group to carry the catalog', async () => {
        const models = await llm.listModels('modlens-tokensapi');
        return models.length === CATALOG.length;
    });
    assert.deepEqual(
        (await llm.listModels('modlens-tokensapi')).map((model) => model.id),
        CATALOG,
    );
    // The plugin's own save already holds the catalog by the time the key
    // lands, so observing the write costs no second TokensAPI request.
    await __modelManager.credentialRefreshSettled(plugin);
    assert.equal(catalogReads.length, 1);
});

test('real DSH reloads the managed lists for a key stored outside this plugin', {
    skip: withoutHost(),
}, async (t) => {
    const { ctx, plugin, request, catalogReads } = await managedHost(t, {
        upstream: 'tokensapi',
        providerId: 'modlens-tokensapi',
    });
    const before = await __modelManager.modelManagerStatus(plugin, request);
    assert.equal(before.authenticated, false);
    assert.ok(!reportedModels(before).includes(FETCHED_ONLY_MODEL));
    assert.equal(catalogReads.length, 0);
    // A key can arrive from the terminal (`dsh credentials set`) or from the
    // sign-in plugin, which writes the same reference. Neither opens this
    // plugin's settings page, and neither emits llm/adapters-updated, so before
    // T0033 the main-model and vision-model lists stayed empty until the page
    // was opened or Desktop restarted.
    await ctx.credentials.set('TOKENSAPI_API_KEY', KEY);
    // The verified marker is the second half of the same credential, and the
    // route counts as authenticated only once both are stored; watching only
    // the key would refresh exactly once, too early, and stop.
    await ctx.credentials.set(
        'TOKENSAPI_API_KEY_VERIFIED_SHA256',
        __modelManager.managedCredentialFingerprint(KEY),
    );
    await until('the managed catalog to reload', async () => {
        await __modelManager.credentialRefreshSettled(plugin);
        const status = await __modelManager.modelManagerStatus(plugin, request, {
            refreshModels: false,
        });
        return reportedModels(status).includes(FETCHED_ONLY_MODEL);
    });
    const after = await __modelManager.modelManagerStatus(plugin, request, {
        refreshModels: false,
    });
    assert.equal(after.authenticated, true);
    for (const id of CATALOG) assert.ok(reportedModels(after).includes(id));
    assert.equal(after.mainModel, MAIN_MODEL);
    // Exactly one catalog read: the refresh fetches when it holds nothing, and
    // the later status reads find the list already loaded.
    assert.equal(catalogReads.length, 1);
});

test('real DSH wraps a discovered route once its stored key makes it answer', {
    skip: withoutHost(),
}, async (t) => {
    // Auto-discovery is the generic ModLens path: it wraps a route only when
    // that route advertises models it can bridge. An empty catalog is therefore
    // "nothing to wrap yet", and before T0033 the retry waited for a topology
    // change that a credential write never produces.
    const { ctx, llm } = await managedHost(t, { discover: ['tokensapi'] });
    await until('the first discovery sweep to settle', async () => llm.listProviders().length > 0);
    assert.equal(routed(llm, 'modlens-tokensapi'), false);
    await ctx.credentials.set('TOKENSAPI_API_KEY', KEY);
    await until('the discovered route to be wrapped', async () => routed(llm, 'modlens-tokensapi'));
    assert.deepEqual(
        (await llm.listModels('modlens-tokensapi')).map((model) => model.name),
        CATALOG.map((id) => `${id} (modlens vision)`),
    );
});
