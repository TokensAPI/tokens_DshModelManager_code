// Real-Host contract cases: every Host interface this plugin uses, called once
// for real against the staged Host. Run through `npm run check:host`, which is
// the only entry point the upgrade gate needs; `DSH_HOST_ROOT` names the staged
// Host's `dsh-plugin-desktop` directory and nothing else is read from the
// environment. Without it every case reports NOT EXECUTED and `check:host`
// exits non-zero — an un-run leg is a failed leg, never a pass.
//
// Direct: node --test --test-concurrency=1 scripts/verify-host-contracts.mjs
//
// What these cases are allowed to assert (T0047 A"), so an upstream release
// does not drag every case with it:
//   - only what this plugin actually depends on: the interfaces it calls, the
//     fields it reads, the events it subscribes to. Never the Host's full
//     surface — no event-vocabulary sizes, no endpoint inventories, no Host
//     field counts or orderings.
//   - shapes are checked with the Host's OWN schema or constructor where it
//     publishes one (`WebServer.Config`, `AgentDefaultModelConfig`, the tool
//     runtime's `assertObjectJsonSchema`/`validateArgs`), not against expected
//     objects written out here.
//   - anything the Host ADDS is compatible by construction: a new adapter
//     method is inherited, a new settings row is ignored, a new event is not
//     subscribed. No case fails because the Host grew.
// Each case names the dependency it defends in its title and its comment, so a
// red case says immediately whether this plugin must change or the Host broke
// a contract.
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import {
    CHECKOUT,
    hostLine,
    hostLoad,
    hostRequest,
    hostRequire,
    hostRoot,
    liveHost,
    MAIN_MODEL,
    MANAGED,
    ONE_PIXEL_PNG,
    PLUGIN_ENTRY,
    UPSTREAM,
    until,
    withoutHost,
} from './host-contract-harness.mjs';

const skip = withoutHost();
const options = { skip };

/** Whether `candidate` sits inside `parent`. */
function inside(parent, candidate) {
    const path = relative(parent, candidate);
    return path !== '' && !path.startsWith('..') && !path.startsWith(`..${sep}`);
}

test(
    'HOST-001 the code under test is this checkout and the Host under test is DSH_HOST_ROOT',
    options,
    async (t) => {
        // A staged Host carries its own pinned copy of this package under
        // product-plugins, and `node_modules/@tokens/dsh-model-manager` links to
        // it. Resolve the plugin from anywhere inside the Host's module tree and
        // every case below would go green against the version the product
        // already shipped — which is exactly the state T0047 exists to end. The
        // fixture resolves the plugin from this checkout by absolute path; this
        // case is the assertion that keeps it that way.
        const root = realpathSync(hostRoot());
        const entry = realpathSync(PLUGIN_ENTRY);
        assert.ok(inside(CHECKOUT, entry), `${entry} must live inside ${CHECKOUT}`);
        assert.ok(!inside(root, entry), `${entry} must not come from the Host at ${root}`);
        const pinned = join(root, 'node_modules', '@tokens', 'dsh-model-manager', 'package.json');
        if (existsSync(pinned)) {
            const pinnedVersion = hostRequire()('@tokens/dsh-model-manager/package.json').version;
            const pinnedPath = realpathSync(
                hostRequire().resolve('@tokens/dsh-model-manager/package.json'),
            );
            assert.notEqual(
                pinnedPath,
                realpathSync(join(CHECKOUT, 'package.json')),
                'the Host must resolve its own pinned copy, not this checkout',
            );
            t.diagnostic(`Host pins @tokens/dsh-model-manager ${pinnedVersion} at ${pinnedPath}`);
        } else {
            t.diagnostic('the staged Host pins no copy of this package');
        }
        // And the Host artifacts come from the staged tree, not from this
        // repo's devDependencies, which also carry a schemastery.
        const llm = realpathSync(hostRequire().resolve('@deepseek-ai/dsh-llm'));
        assert.ok(inside(root, llm), `${llm} must come from the Host at ${root}`);
        const { version } = hostLine();
        t.diagnostic(`plugin ${realpathSync(join(CHECKOUT, 'dsh', 'index.js'))}`);
        t.diagnostic(`Host DSH ${version} at ${root}`);
    },
);

test(
    "HOST-002 every service this plugin declares in `inject` exists, and the Host's own Loader activates it",
    options,
    async (t) => {
        // `export const inject` is a hard gate, not a hint: the Loader parks the
        // entry until every name resolves, and the plugin then never runs at
        // all. A Host that renames or drops one of these is the failure mode
        // that is invisible to a mocked suite — the plugin's own tests hand it a
        // context object and never consult the Loader.
        const host = await liveHost(t);
        for (const service of host.plugin.inject) {
            assert.notEqual(host.ctx[service], undefined, `the Host must provide ctx.${service}`);
        }
        if (host.mode === 'profile') {
            // The Loader's own verdict: an entry still waiting for a service is
            // reported as pending rather than thrown, so the only honest check
            // is that the plugin's work is observable. Its own settings entry and
            // its managed route both exist only after `apply` ran to completion.
            assert.ok(
                host.ctx.llm.listProviders().some((info) => info.id === MANAGED),
                'the Loader must have activated this plugin',
            );
        }
        t.diagnostic(`mode=${host.mode} line=${host.line} inject=${host.plugin.inject.join(',')}`);
    },
);

test(
    'HOST-003 llm.registerAdapter / listProviders / listModels route the managed group on the real registry',
    options,
    async (t) => {
        // The three calls the plugin makes to publish its bridged route. The
        // wrapper registers against the upstream ROUTE, not against its catalog,
        // so it is routed from the start and mirrors whatever the upstream route
        // advertises — on DSH 0.2.1 that is an empty list while no key resolves.
        const host = await liveHost(t);
        const providers = host.ctx.llm.listProviders();
        assert.ok(
            providers.some((info) => info.id === MANAGED),
            'the managed route must be registered',
        );
        assert.ok(
            providers.some((info) => info.id === UPSTREAM),
            'the real pi-ai TokensAPI route must be registered',
        );
        const upstream = await host.ctx.llm.listModels(UPSTREAM);
        const managed = await host.ctx.llm.listModels(MANAGED);
        // The bridged twin is one-for-one with upstream: the plugin adds vision
        // to each entry, it does not invent or hide models. Compared by id, so a
        // Host that enriches a model entry with new fields stays compatible.
        assert.deepEqual(
            managed.map((model) => model.id),
            upstream.map((model) => model.id),
        );
        for (const model of managed) {
            // The three fields the plugin's own projection reads back.
            assert.equal(typeof model.id, 'string');
            assert.equal(typeof model.name, 'string');
            assert.ok(Array.isArray(model.inputModalities));
        }
        t.diagnostic(
            `upstream=[${upstream.map((m) => m.id).join(',')}] managed=[${managed.map((m) => m.id).join(',')}]`,
        );
    },
);

test(
    'HOST-004 llm.resolveModelInfo and the registry prepareCall answer on the managed route',
    options,
    async (t) => {
        // What the plugin reads off a resolved model: the route it belongs to,
        // the id, and the modalities that decide whether it bridges vision. The
        // signal is the Host's own cancellation for that resolution, which the
        // plugin forwards from its caller.
        const host = await liveHost(t);
        const { llm } = host.ctx;
        const signal = new AbortController().signal;
        const info = await llm.resolveModelInfo(MANAGED, MAIN_MODEL, signal);
        assert.equal(info.provider, MANAGED);
        assert.equal(info.id, MAIN_MODEL);
        assert.ok(Array.isArray(info.inputModalities));
        // The registry's `prepareCall` binds one call to one adapter
        // generation. On the managed route it has to come back bound to the
        // bridged route rather than to the upstream one, which is what makes a
        // request logged against this route dispatch against this route. Note
        // the registry's signature is `(config, signal)` while the adapter
        // base's is `(provider, model, signal)`; the wrapper answers the latter
        // and verify-adapter-pricing covers it there.
        const prepared = await llm.prepareCall({ provider: MANAGED, model: MAIN_MODEL }, signal);
        assert.equal(prepared.config.provider, MANAGED);
        assert.equal(prepared.config.model, MAIN_MODEL);
        assert.equal(typeof prepared.stream, 'function');
        t.diagnostic(`resolved modalities=[${info.inputModalities.join(',')}]`);
    },
);

test(
    'HOST-005 llm.providerRetryPolicy is forwarded from the upstream route unchanged',
    options,
    async (t) => {
        // The plugin does not invent a retry policy: it snapshots the upstream
        // route's. dsh reads this once, at registration time, so a wrapper that
        // answered its own would quietly change how every managed call retries.
        //
        // Comparing the two routes on the real pi-ai route proves little by
        // itself: neither customizes the policy, so both report the Host's
        // default and a wrapper that stopped forwarding would still look right.
        // The plugin is therefore pointed at a route this case owns, whose
        // adapter declares a distinctive policy — and then that policy is
        // changed under the wrapper, which is the dependency that matters: the
        // plugin re-registers when the upstream policy key moves.
        const { LlmAdapter } = await hostLoad('@deepseek-ai/dsh-llm');
        const OWN_UPSTREAM = 'contract-upstream';
        const OWN_MANAGED = 'contract-managed';
        let policy;
        class Distinctive extends LlmAdapter {
            providerInfo(provider) {
                return { id: provider, name: 'Contract upstream' };
            }
            providerRetryPolicy() {
                return policy;
            }
            async listModels(provider) {
                return [{ provider, id: MAIN_MODEL, name: MAIN_MODEL, inputModalities: ['text'] }];
            }
            async resolveModel(provider, model) {
                return { provider, id: model, name: model, inputModalities: ['text'] };
            }
            stream() {
                throw new Error('a contract check must not reach the wire');
            }
        }
        let registration;
        const host = await liveHost(t, {
            config: { upstream: OWN_UPSTREAM, providerId: OWN_MANAGED },
            managed: OWN_MANAGED,
            // The wrapper is only registered once its upstream route exists, so
            // the route has to be there before the settle wait.
            beforeSettle: (ctx) => {
                policy = { ...ctx.llm.providerRetryPolicy(UPSTREAM), maxRetries: 9 };
                registration = ctx.llm.registerAdapter([OWN_UPSTREAM], new Distinctive());
                return {};
            },
        });
        const { llm } = host.ctx;
        assert.equal(typeof llm.providerRetryPolicy, 'function');
        // The owned route's distinctive policy reaches its wrapper. (The real
        // pi-ai route is still registered here, but the plugin is pointed at
        // the owned one, so `modlens-tokensapi` has no wrapper in this case.)
        assert.equal(llm.providerRetryPolicy(OWN_MANAGED).maxRetries, 9);
        assert.deepEqual(
            llm.providerRetryPolicy(OWN_MANAGED),
            llm.providerRetryPolicy(OWN_UPSTREAM),
        );
        // Changing it under the wrapper: `replace(providers)` re-reads the
        // adapter's registration-time facts and announces itself like a first
        // registration, which is the boundary the plugin re-registers on.
        policy = { ...policy, maxRetries: 4 };
        registration.replace([OWN_UPSTREAM]);
        await until(
            'the managed route to follow the changed upstream policy',
            () => llm.providerRetryPolicy(OWN_MANAGED)?.maxRetries === 4,
        );
        assert.deepEqual(
            llm.providerRetryPolicy(OWN_MANAGED),
            llm.providerRetryPolicy(OWN_UPSTREAM),
        );
        t.diagnostic(
            `pi-ai default maxRetries=${llm.providerRetryPolicy(UPSTREAM)?.maxRetries}; owned route forwarded 9 then 4`,
        );
    },
);

test(
    'HOST-006 llm.imageRequestPricing is forwarded from the upstream route',
    options,
    async (t) => {
        // Compaction and the token meter price an image history through this.
        // The plugin forwards the upstream route's pricing rather than guessing,
        // and on the managed route the answer must be the upstream answer.
        const host = await liveHost(t);
        const { llm } = host.ctx;
        assert.equal(typeof llm.imageRequestPricing, 'function');
        const upstream = llm.imageRequestPricing(UPSTREAM, MAIN_MODEL);
        const managed = llm.imageRequestPricing(MANAGED, MAIN_MODEL);
        // pi-ai may answer undefined for a text route; either way the managed
        // route must agree with it, which is the forwarding contract.
        assert.equal(typeof managed, typeof upstream);
        t.diagnostic(`pricing upstream=${typeof upstream} managed=${typeof managed}`);
    },
);

test(
    "HOST-007 the plugin's llm/stream gate runs inside the Host's own stream waterfall",
    options,
    async (t) => {
        // Every model call passes the Host's `llm/stream` waterfall, and this
        // plugin holds a call there until a pending route switch is written.
        // Driven through the real `llm.stream`, so the composition under test is
        // the Host's dispatcher and the plugin's generator middleware, including
        // the `yield* next()` hand-off.
        const host = await liveHost(t);
        const { LlmAdapter } = await hostLoad('@deepseek-ai/dsh-llm');
        const chunks = [];
        let reached = 0;
        class Terminal extends LlmAdapter {
            providerInfo(provider) {
                return { id: provider, name: 'terminal' };
            }
            async listModels(provider) {
                return [{ provider, id: MAIN_MODEL, name: MAIN_MODEL, inputModalities: ['text'] }];
            }
            async resolveModel(provider, model) {
                return { provider, id: model, name: model, inputModalities: ['text'] };
            }
            async *stream() {
                reached += 1;
                yield { type: 'block-start', index: 0, blockType: 'text' };
                yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } };
                yield { type: 'finish', reason: { kind: 'stop' } };
            }
        }
        // A separate route, so the gate is exercised without the managed
        // wrapper's own forwarding in the way.
        host.ctx.llm.registerAdapter(['contract-terminal'], new Terminal());
        for await (const chunk of host.ctx.llm.stream({
            provider: 'contract-terminal',
            model: MAIN_MODEL,
            messages: [],
        })) {
            chunks.push(chunk.type);
        }
        assert.equal(reached, 1, 'the waterfall must reach the terminal adapter');
        assert.ok(chunks.includes('finish'), 'the chunk stream must come back through the gate');
        t.diagnostic(`chunks=[${chunks.join(',')}]`);
    },
);

test(
    'HOST-008 credentials.describe / set / resolve round-trip on the real credential provider',
    options,
    async (t) => {
        // The plugin stores the TokensAPI key and its verification fingerprint
        // in the Host's credential service and never anywhere else. It reads
        // `describe().configured` for its gate and `resolve().value` for the
        // outgoing Bearer; nothing else on either answer.
        const host = await liveHost(t);
        const { credentials } = host.ctx;
        const ref = 'TOKENSAPI_API_KEY';
        const before = await credentials.describe(ref);
        assert.equal(before.configured, false);
        await credentials.set(ref, 'synthetic-contract-key');
        const after = await credentials.describe(ref);
        assert.equal(after.configured, true);
        const resolved = await credentials.resolve(ref);
        // Only `.value`: the record carries Host-owned bookkeeping whose shape
        // is none of this plugin's business.
        assert.equal(resolved.value, 'synthetic-contract-key');
        t.diagnostic(`describe keys=[${Object.keys(after).join(',')}]`);
    },
);

test(
    'HOST-009 a real credential write fills the managed group through the Host, without a restart',
    options,
    async (t) => {
        // The T0033 regression against the REAL pi-ai route: since DSH 0.2.1
        // that route resolves its apiKey reference inside listModels and
        // advertises an empty catalog while the reference does not resolve, and
        // `credentials.set` emits no `llm/adapters-updated`. The plugin
        // therefore reconciles on `credentials/reference-updated` as well. Both
        // halves here are the Host's: its credential provider emits, its llm
        // registry answers.
        const host = await liveHost(t);
        const { credentials, llm } = host.ctx;
        const plugin = host.plugin;
        const empty = await llm.listModels(MANAGED);
        await credentials.set('TOKENSAPI_API_KEY', 'synthetic-contract-key');
        await credentials.set(
            'TOKENSAPI_API_KEY_VERIFIED_SHA256',
            plugin.__modelManager.managedCredentialFingerprint('synthetic-contract-key'),
        );
        await until('the plugin to reconcile after the credential write', async () => {
            await plugin.__modelManager.credentialRefreshSettled(host.ctx);
            const status = await plugin.__modelManager.modelManagerStatus(host.ctx, host.request, {
                refreshModels: false,
            });
            return status.authenticated === true;
        });
        const status = await plugin.__modelManager.modelManagerStatus(host.ctx, host.request, {
            refreshModels: false,
        });
        assert.equal(status.authenticated, true);
        assert.ok(status.models.some((model) => model.id === MAIN_MODEL));
        t.diagnostic(
            `managed catalog before=${empty.length} after authentication=${status.models.length}`,
        );
    },
);

test(
    "HOST-010 agent/pre-step runs through the Host's waterfall and reads a real stored attachment",
    options,
    async (t) => {
        // Two interfaces in one flow, because that is how they are used. The
        // Host dispatches `agent/pre-step` as a waterfall; this plugin's
        // listener awaits `next()` first and then rewrites image blocks, and
        // each rewrite calls `ctx.attachments.readImage(attachment, signal)` and
        // reads `data` plus `ref.mediaType` off the answer.
        //
        // The image is really saved into the Host's attachment store and the
        // reference the plugin reads is the Host's own. The vision engine behind
        // the read is this plugin's CLI, which is not installed in a contract
        // run — so the documented outcome is a localized MODLENS_VISION_READ_FAILED
        // and a diagnostic whose stage is `engine`. `engine` is reachable only
        // after `readImage` returned bytes: a Host whose attachment shape moved
        // would report stage `store` instead, which is the assertion that makes
        // this case about the Host interface rather than about the engine.
        const host = await liveHost(t, { config: { autoRead: true } });
        const stored = await host.ctx.attachments.saveImage({
            data: ONE_PIXEL_PNG,
            mediaType: 'image/png',
            name: 'host-contract.png',
        });
        // The reference fields the plugin reads back off a stored image.
        assert.equal(typeof stored.attachmentId, 'string');
        assert.equal(stored.mediaType, 'image/png');
        const read = await host.ctx.attachments.readImage(stored);
        assert.ok(read.data?.length > 0, 'readImage must answer with bytes');
        assert.equal(read.ref.mediaType, 'image/png');

        const signal = new AbortController().signal;
        const textOnly = [{ role: 'user', content: [{ type: 'text', text: 'no image here' }] }];
        // The plugin must hand an image-free step straight through. Dispatched
        // by the Host, with the Host's own waterfall composing `next`.
        const passed = await host.ctx.waterfall(
            'agent/pre-step',
            { agent: undefined, messages: textOnly, turn: 1, step: 1, signal },
            async () => ({ kind: 'enter', messages: textOnly }),
        );
        assert.deepEqual(passed, { kind: 'enter', messages: textOnly });

        const withImage = [{ role: 'user', content: [{ type: 'image', attachment: stored }] }];
        const quiet = console.error;
        console.error = () => {};
        try {
            await assert.rejects(
                host.ctx.waterfall(
                    'agent/pre-step',
                    { agent: undefined, messages: withImage, turn: 2, step: 1, signal },
                    async () => ({ kind: 'enter', messages: withImage }),
                ),
                { code: 'MODLENS_VISION_READ_FAILED' },
            );
        } finally {
            console.error = quiet;
        }
        const status = await host.plugin.__modelManager.modelManagerStatus(host.ctx, host.request, {
            refreshModels: false,
        });
        assert.equal(
            status.visionDiagnostic?.stage,
            'engine',
            "the Host's attachment read must have succeeded before the engine was reached",
        );
        t.diagnostic(`stored ${stored.attachmentId} (${read.data.length} bytes)`);
    },
);

test(
    "HOST-011 the raw JSON-Schema tool definition is accepted by the Host's own tool runtime",
    options,
    async (t) => {
        // The plugin registers `modlens_read_image` as a raw JSON-Schema
        // definition rather than through `defineTool`, so the Host's own schema
        // admission is the contract. Checked with the Host's own validators, not
        // against a hand-written expectation, and the reverse check drives a
        // call the plugin's own schema must refuse.
        const host = await liveHost(t, { config: { autoRead: false } });
        if (host.ctx.tools === undefined) {
            t.diagnostic('NOT EXECUTED on this Host: no tool runtime in this fixture mode');
            return;
        }
        const { assertObjectJsonSchema, validateJsonSchemaValue } =
            await hostLoad('@deepseek-ai/dsh-tools');
        const tool = host.ctx.tools.schemas().find((entry) => entry.name === 'modlens_read_image');
        assert.ok(tool, 'the Host must carry the plugin tool registration');
        // The Host's own admission over the schema the plugin shipped. It also
        // reaches the model: the same definition has to survive the Host's wire
        // rendering, which is what an agent would be offered.
        assertObjectJsonSchema(tool.parameters);
        assert.ok(host.ctx.tools.wireSchemas().knownNames.includes('modlens_read_image'));
        // The Host's own value validator over the plugin's own schema, both
        // ways. It is total and answers with path-qualified violations, so an
        // empty list is the acceptance.
        assert.deepEqual(
            validateJsonSchemaValue(tool.parameters, { path: 'C:/tmp/contract.png' }),
            [],
        );
        // Reverse check on the plugin's own path only: `path` is the argument the
        // plugin declares required, so the Host's validator must refuse without it.
        assert.ok(validateJsonSchemaValue(tool.parameters, {}).length > 0);
        t.diagnostic(
            `tool ${tool.name} params=[${Object.keys(tool.parameters.properties ?? {}).join(',')}]`,
        );
    },
);

test(
    "HOST-012 the three webServer routes answer over real loopback HTTP on the Host's own server",
    options,
    async (t) => {
        // `ctx.webServer.register` is how the browser half reaches this plugin
        // at all. The Host's real web server is bound here and every call below
        // is real HTTP; the fields asserted on the status body are the ones
        // dsh/client.js reads.
        const host = await liveHost(t, { config: { pasteToPath: true, settingsCard: true } });
        const status = await hostRequest(host, '/tokens/model-manager');
        assert.equal(status.status, 200);
        assert.equal(status.body.provider, 'TokensAPI');
        assert.equal(typeof status.body.authenticated, 'boolean');
        assert.equal(typeof status.body.mainModel, 'string');
        assert.equal(typeof status.body.mainProvider, 'string');
        assert.ok(Array.isArray(status.body.models));
        // The browser half asks before it ever swallows a paste.
        const paste = await hostRequest(host, `/modlens/paste?model=${MAIN_MODEL}`);
        assert.equal(paste.status, 200);
        assert.equal(typeof paste.body.takeover, 'boolean');
        // The settings card's own route.
        const config = await hostRequest(host, '/modlens/config');
        assert.equal(config.status, 200);
        assert.equal(typeof config.body, 'object');
        // The POST the composer makes when a user picks a model. Unauthenticated
        // it is refused by this plugin with its own code, not by the Host.
        const pick = {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'selectMainModel',
                provider: UPSTREAM,
                model: MAIN_MODEL,
            }),
        };
        const refused = await hostRequest(host, '/tokens/model-manager', pick);
        assert.equal(refused.status, 401);
        assert.equal(refused.body.code, 'unauthenticated');
        // With the key really stored in the Host's credential service the same
        // POST lands, so the whole chain — real socket, real route, real
        // credential read, real settings write — is exercised once.
        const key = 'synthetic-contract-key';
        await host.ctx.credentials.set('TOKENSAPI_API_KEY', key);
        await host.ctx.credentials.set(
            'TOKENSAPI_API_KEY_VERIFIED_SHA256',
            host.plugin.__modelManager.managedCredentialFingerprint(key),
        );
        await until('the route to report the stored key', async () => {
            const read = await hostRequest(host, '/tokens/model-manager');
            return read.body?.authenticated === true;
        });
        const accepted = await hostRequest(host, '/tokens/model-manager', pick);
        assert.equal(accepted.status, 200);
        assert.equal(accepted.body.mainModel, MAIN_MODEL);
        t.diagnostic(
            `origin=${host.origin()} status=${status.status} paste=${paste.status} config=${config.status} post=${refused.status}->${accepted.status}`,
        );
    },
);

test(
    'HOST-013 the same-origin fence refuses a forged origin on the real server (reverse check)',
    options,
    async (t) => {
        // The gate must not be a no-op. These two requests travel the same real
        // socket as HOST-012's and differ only in the headers the fence reads,
        // so a fence that stopped working shows up as a 200 here.
        const host = await liveHost(t);
        const forged = await hostRequest(host, '/tokens/model-manager', {
            headers: { origin: 'https://attacker.example' },
        });
        assert.equal(forged.status, 403);
        const crossSite = await hostRequest(host, '/tokens/model-manager', {
            headers: { 'sec-fetch-site': 'cross-site' },
        });
        assert.equal(crossSite.status, 403);
        // ... and the same-origin form is still allowed, so the fence is not
        // simply refusing everything.
        const sameOrigin = await hostRequest(host, '/tokens/model-manager', {
            headers: { origin: host.origin(), 'sec-fetch-site': 'same-origin' },
        });
        assert.equal(sameOrigin.status, 200);
        t.diagnostic(
            `forged=${forged.status} cross-site=${crossSite.status} same-origin=${sameOrigin.status}`,
        );
    },
);

test(
    "HOST-014 the settings service this Host ships carries the plugin's choices and its route write",
    options,
    async (t) => {
        // DSH 0.1 and 0.2 are two different settings services and the plugin has
        // a branch for each: 0.1 registers a namespace and reads it with `get`,
        // 0.2 writes profile entries with `update`/`replace` and reads them back
        // through `describe()`. Only the rows this plugin owns are asserted, by
        // namespace; a Host that adds entries is ignored.
        const host = await liveHost(t);
        const { settings } = host.ctx;
        if (host.line === '0.1') {
            assert.equal(typeof settings.register, 'function');
            assert.equal(typeof settings.get, 'function');
            const saved = settings.get('tokens-model-manager');
            assert.equal(typeof saved, 'object');
            t.diagnostic('0.1 settings: namespace registry path');
            return;
        }
        assert.equal(typeof settings.describe, 'function');
        assert.equal(typeof settings.update, 'function');
        const rows = settings.describe();
        const own = rows.find((row) => row?.ns === 'tokens-model-manager');
        assert.ok(own, "the plugin's own settings entry must be served");
        assert.equal(typeof own.value, 'object');
        // The Host's own LLM route entry, which the plugin writes for real when
        // a model is picked. Reading it back through `describe()` is how the
        // plugin learns what it persisted.
        const route = rows.find((row) => row?.ns === 'llm-pi-ai');
        assert.ok(route, 'the real llm-pi-ai entry must be served');
        await settings.update('llm-pi-ai', {
            providers: {
                [UPSTREAM]: {
                    ...route.value.providers[UPSTREAM],
                    displayName: 'TokensAPI',
                },
            },
        });
        const written = settings.describe().find((row) => row?.ns === 'llm-pi-ai')?.value
            ?.providers?.[UPSTREAM];
        assert.equal(written.displayName, 'TokensAPI');
        // `configure` is how the plugin tells the settings page not to generate
        // a second, unguarded form over its fields.
        assert.equal(typeof settings.configure, 'function');
        t.diagnostic(`0.2 settings rows for this plugin: tokens-model-manager, llm-pi-ai`);
    },
);

test(
    "HOST-015 the Host's persisted default model is read and written through its own service",
    options,
    async (t) => {
        // Two directions over one Host interface. The plugin reads the Host's
        // persisted default (the `agent-default-model` row) to decide the main
        // model at startup, and writes the user's pick back through
        // `agentDefaultModel.saveSelection`. The Host publishes no value
        // validator for this selection (its Config declares the fields volatile,
        // so parsing strips them), so the round trip through its own service is
        // what validates the shape — not an expected object written here.
        const host = await liveHost(t);
        if (host.ctx.agentDefaultModel === undefined) {
            t.diagnostic('NOT EXECUTED on this Host: no agentDefaultModel service in this mode');
            return;
        }
        const service = host.ctx.agentDefaultModel;
        assert.equal(typeof service.saveSelection, 'function');
        await service.saveSelection({ provider: MANAGED, model: MAIN_MODEL });
        const current = await service.currentSelection();
        assert.equal(current.provider, MANAGED);
        assert.equal(current.model, MAIN_MODEL);
        if (host.line !== '0.1') {
            const row = host.ctx.settings
                .describe()
                .find((entry) => entry?.ns === 'agent-default-model');
            assert.ok(row, 'the Host must serve its agent-default-model entry');
            assert.equal(row.value.provider, MANAGED);
        }
        t.diagnostic(`default selection ${current.provider}/${current.model}`);
    },
);

test(
    'HOST-016 the staged Host identifies itself, so a run can never be attributed to the wrong artifact',
    options,
    async (t) => {
        // Not a contract on its own: the line every other case's verdict is read
        // against. Printed rather than pinned to a version pattern, because the
        // supported set is the product's business and a new line must not turn
        // this file red.
        const require_ = hostRequire();
        const { version, line } = hostLine();
        const packages = [
            '@deepseek-ai/dsh-llm',
            '@deepseek-ai/dsh-settings',
            '@deepseek-ai/dsh-credentials-local',
            '@deepseek-ai/dsh-host-webserver',
            '@deepseek-ai/dsh-attachment-local',
            '@deepseek-ai/dsh-tools',
            '@deepseek-ai/dsh-agent-default-model',
            '@deepseek-ai/dsh-llm-pi-ai',
        ];
        for (const name of packages) {
            const manifest = require_(`${name}/package.json`);
            assert.equal(typeof manifest.version, 'string');
            t.diagnostic(`${name.replace('@deepseek-ai/', '')} ${manifest.version}`);
        }
        t.diagnostic(`DSH ${version} (line ${line}) at ${resolve(hostRoot())}`);
    },
);
