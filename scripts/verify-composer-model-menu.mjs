// Run with: node --test --test-concurrency=1 scripts/verify-composer-model-menu.mjs
// DSH_RUNTIME_ROOT points at a staged Desktop package directory; without it the
// whole file skips. Run it once per supported Host line (0.2.1-rc.2 and
// 0.2.0-rc.2) — the cases are the same, the Host artifact is not.
//
// The composer's model menu closes only when the `select()` it awaits resolves
// with the Host's own `{ ok: true }`, so anything the plugin awaits inside that
// call keeps the menu open (T0041: saving the pick to /tokens/model-manager
// waits for TokensAPI to list its models, which is seconds on a slow link).
// Each plugin case below is paired with the same case driven straight against
// the Host, so "the plugin behaves exactly like pure upstream here" is an
// assertion rather than a claim.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    loadPluginClient,
    mountSeat,
    openComposerSeat,
    openDocument,
    registerStoreDepHooks,
    storeDeps,
} from './composer-seat-harness.mjs';

const runtimeRoot = process.env.DSH_HOST_ROOT ?? process.env.DSH_RUNTIME_ROOT;
const CLIENT = fileURLToPath(new URL('../dsh/client.js', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
/** The Host package carrying the composer seat under test. */
const MODEL_SELECTION = '@deepseek-ai/dsh-client-ui-model-selection';
/** The Host package whose store engine zustand and immer are. */
const CLIENT_STORE = '@deepseek-ai/dsh-client-store';

/**
 * The DSH line of the staged Host, read from the package carrying the seat.
 * @returns the version, or undefined without a Host.
 */
function selectionVersion() {
    if (runtimeRoot === undefined) return undefined;
    return createRequire(resolve(runtimeRoot, 'package.json'))(`${MODEL_SELECTION}/package.json`)
        .version;
}

// The seat's session face changed shape with DSH 0.2: the composer reads the
// durable selection off a session projection (`next`/`lastUsed`), which is what
// this harness stands up. A 0.1 Host ships the earlier seat and reads a
// different face, so these cases are NOT EXECUTED there rather than red — the
// contract they defend (T0041's "the menu closes on the Host's own result") is
// a 0.2 contract. The 0.1 line's composer behaviour is not covered here, and
// `docs/host-interfaces.md` records that gap.
const selectionLine = selectionVersion();
// The redirect hooks and the document are process-wide: install them once,
// before the first case loads the Host's store, and let each case mount into
// its own container. A store dep that is not installed skips the file rather
// than letting a stand-in store decide what the seat sees.
const unsupportedLine = selectionLine !== undefined && /^0\.1\./.test(selectionLine);
const mountable = runtimeRoot !== undefined && !unsupportedLine;
const missingStoreDeps = mountable ? registerStoreDepHooks() : [];
if (mountable && missingStoreDeps.length === 0) openDocument(runtimeRoot);

const MODELS = [
    { id: 'kimi-k3', name: 'kimi-k3', protocols: ['openai'], visionMode: 'native' },
    {
        id: 'deepseek-v4-flash',
        name: 'deepseek-v4-flash',
        protocols: ['openai'],
        visionMode: 'native',
    },
];

/** The Host catalog: one official group plus the managed TokensAPI group. */
const catalogValue = () => ({
    default: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    failures: [],
    groups: [
        {
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }],
        },
        {
            id: 'tokensapi',
            name: 'TokensAPI',
            models: MODELS.map(({ id, name }) => ({ id, name })),
        },
    ],
});

/**
 * Stand up the seat with no plugin loaded: the upstream baseline every paired
 * case is compared against.
 * @param t - the case, so the seat is unmounted even when an assertion throws.
 * @param options - how the Host's selectModel RPC answers.
 * @returns the mounted seat controls and the RPC calls it made.
 */
async function pureHostSeat(
    t,
    { selectModel = async () => ({ ok: true, value: undefined }) } = {},
) {
    const calls = [];
    const seat = await openComposerSeat({
        runtimeRoot,
        catalog: catalogValue,
        selectModel: async (request) => {
            calls.push(`${request.provider}/${request.model}`);
            return selectModel(request);
        },
    });
    const controls = await mountSeat(seat);
    t.after(() => controls.unmount());
    return { ...controls, calls };
}

/**
 * Stand up the seat with the plugin's browser half loaded over the same Host,
 * the way the product ships it.
 * @param t - the case, so the seat is unmounted even when an assertion throws.
 * @param options - how the Host RPC and the plugin's own route answer.
 * @returns the mounted seat controls, the RPC calls and the route calls.
 */
async function managedSeat(
    t,
    {
        selectModel = async () => ({ ok: true, value: undefined }),
        save = async () => ({ ok: true }),
    } = {},
) {
    const calls = [];
    const route = [];
    let mainModel = 'kimi-k3';
    let mainProvider = 'tokensapi';
    const status = () => ({
        provider: 'TokensAPI',
        authenticated: true,
        mainModel,
        mainProvider,
        models: MODELS,
    });
    const seat = await openComposerSeat({
        runtimeRoot,
        catalog: catalogValue,
        selectModel: async (request) => {
            calls.push(`${request.provider}/${request.model}`);
            return selectModel(request);
        },
    });
    const fetchStub = async (_url, options = {}) => {
        const body = options.body === undefined ? undefined : JSON.parse(options.body);
        const action = body?.action ?? 'status';
        route.push(action);
        if (action === 'selectMainModel') {
            const outcome = await save(body);
            if (outcome.ok !== true) return { ok: false, status: 500, json: async () => outcome };
            mainModel = body.model;
            mainProvider = body.provider;
            return { ok: true, status: 200, json: async () => status() };
        }
        if (action === 'awaitMainModel') return { ok: true, status: 200, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => status() };
    };
    const manager = loadPluginClient({
        clientPath: CLIENT,
        fetch: fetchStub,
        hostRequire: seat.hostRequire,
    });
    const controls = await mountSeat(seat);
    t.after(() => controls.unmount());
    // The plugin loads after the composer is already on screen, as it does in
    // the product: the seat's directory was resolved before the hook landed.
    manager.registerManagerSection({
        inject: (_services, callback) =>
            callback({
                sessions: {
                    list: {
                        getSnapshot: () => ({ ids: [seat.sessionId], byId: {} }),
                        subscribe: () => () => {},
                    },
                    subagentAddress: () => undefined,
                },
                modelDirectories: seat.resolver,
                slots: { inject: () => undefined },
            }),
    });
    await controls.settle();
    route.length = 0;
    calls.length = 0;
    return { ...controls, calls, route, saved: () => `${mainProvider}/${mainModel}` };
}

/** A promise a case releases by hand, to hold the plugin's route write open. */
function held() {
    let release;
    const promise = new Promise((done) => (release = done));
    return { promise, release: (value) => release(value) };
}

const options = {
    skip:
        runtimeRoot === undefined
            ? 'NOT EXECUTED: DSH_HOST_ROOT is not set'
            : unsupportedLine
              ? `NOT EXECUTED on DSH ${selectionLine}: the composer seat harness models the 0.2 session face`
              : missingStoreDeps.length > 0
                ? `NOT EXECUTED: install this repository's dependencies first; not in node_modules: ${missingStoreDeps.join(', ')}`
                : false,
};

/** The major of a version or of a range like `~4.5.7`. */
function major(value) {
    return value.match(/(\d+)/u)?.[1];
}

/**
 * The store engine is the same on every supported line, so this case only
 * needs a Host — not a mountable one.
 */
const anyHost = {
    skip: runtimeRoot === undefined ? 'NOT EXECUTED: DSH_HOST_ROOT is not set' : false,
};

test('the store engine the seat runs on is pinned by this repository', anyHost, async () => {
    // The seat needs zustand and immer, which a staged Host does not carry.
    // Taking them from a harness pnpm store made the six cases below depend on
    // a directory no gate installs: green on a developer machine that had one,
    // NOT EXECUTED for the whole of v0.7.4's gate (T0051). They are this
    // repository's own devDependencies now, so this case holds the two
    // properties that replace that store: they are installed here, and they
    // are still the Host's own engine.
    const hostRequire = createRequire(resolve(runtimeRoot, 'package.json'));
    const declared = hostRequire(`${CLIENT_STORE}/package.json`);
    const ranges = { ...declared.devDependencies, ...declared.dependencies };
    for (const { name, manifest, version } of storeDeps()) {
        assert.ok(
            version !== undefined,
            `${name} is not installed; the seat cases cannot run without it`,
        );
        // Nothing outside this repository may take part: that is what made the
        // gate and a developer machine disagree.
        assert.equal(
            manifest,
            resolve(REPO, 'node_modules', name, 'package.json'),
            `${name} must resolve inside this repository`,
        );
        const range = ranges[name];
        // A Host that stops declaring it is a Host that no longer needs it;
        // report rather than fail, the way the rest of this file treats Host
        // additions. Only the major is held: the supported lines already
        // disagree on the patch (0.2.0-rc.2 ~4.4.7, 0.2.1-rc.2 ~4.5.7) and the
        // seat cases are what prove the engine behaves.
        if (range === undefined) {
            console.log(`  ${CLIENT_STORE} ${declared.version} declares no ${name}`);
            continue;
        }
        console.log(`  ${name} ${version} here, ${range} in ${CLIENT_STORE}`);
        assert.equal(
            major(version),
            major(range),
            `${name} ${version} is a different major than the Host's ${range}`,
        );
    }
    // And the six cases below really ran rather than reporting a store gap.
    if (mountable) assert.deepEqual(missingStoreDeps, []);
});

test('the Host closes its own menu as soon as a pick settles', options, async (t) => {
    const seat = await pureHostSeat(t);
    await seat.openModelPane();
    assert.equal(seat.open(), true);
    await seat.click(seat.rowFor('kimi-k3'));
    // Upstream settles within the click's own flush: no menu, no toast.
    assert.equal(seat.open(), false);
    assert.deepEqual(seat.rows(), []);
    assert.deepEqual(seat.toasts(), []);
    assert.equal(seat.label(), 'kimi-k3');
    assert.deepEqual(seat.calls, ['tokensapi/kimi-k3']);
});

test(
    'a managed pick closes the menu on the Host result, not on the route write',
    options,
    async (t) => {
        const write = held();
        const seat = await managedSeat(t, { save: () => write.promise });
        await seat.openModelPane();
        await seat.click(seat.rowFor('deepseek-v4-flash'));
        // Same flush as pure upstream, with the route write still in flight.
        assert.equal(seat.open(), false);
        assert.deepEqual(seat.rows(), []);
        assert.deepEqual(seat.toasts(), []);
        assert.equal(seat.label(), 'deepseek-v4-flash');
        assert.deepEqual(seat.calls, ['tokensapi/deepseek-v4-flash']);
        assert.ok(seat.route.includes('selectMainModel'), 'the route write started');
        // It still lands, and it still records the pick.
        write.release({ ok: true });
        await seat.settle();
        assert.equal(seat.saved(), 'tokensapi/deepseek-v4-flash');
        assert.equal(seat.label(), 'deepseek-v4-flash');
        assert.equal(seat.open(), false);
    },
);

test('picking the model already in use closes without a route write', options, async (t) => {
    const seat = await managedSeat(t);
    await seat.openModelPane();
    await seat.click(seat.rowFor('kimi-k3'));
    assert.equal(seat.open(), false);
    assert.deepEqual(seat.route, []);
    assert.deepEqual(seat.calls, []);
});

test('a Host refusal toasts and keeps the menu open, managed or not', options, async (t) => {
    const refusal = {
        ok: false,
        error: { code: 'session/writer-held', message: 'another writer holds the session' },
    };
    const pure = await pureHostSeat(t, { selectModel: async () => refusal });
    await pure.openModelPane();
    await pure.click(pure.rowFor('kimi-k3'));
    await pure.settle();
    const expected = { open: pure.open(), toasts: pure.toasts() };
    assert.equal(expected.open, true, 'upstream leaves a refused pick on screen');
    assert.equal(expected.toasts.length, 1);

    const managed = await managedSeat(t, { selectModel: async () => refusal });
    await managed.openModelPane();
    await managed.click(managed.rowFor('deepseek-v4-flash'));
    await managed.settle();
    assert.deepEqual({ open: managed.open(), toasts: managed.toasts() }, expected);
    // A pick the Host refused is never written to the route.
    assert.deepEqual(managed.route, []);
});

test('a failed route write puts the composer back on the previous model', options, async (t) => {
    const seat = await managedSeat(t, {
        save: async () => ({ code: 'invalid_model', error: '所选模型不在 TokensAPI 可用列表中' }),
    });
    await seat.openModelPane();
    await seat.click(seat.rowFor('deepseek-v4-flash'));
    // The menu still closes on the Host's timing — the write had not answered.
    assert.equal(seat.open(), false);
    await seat.settle();
    // The Host had accepted the pick, so the rollback is what the user sees.
    assert.equal(seat.label(), 'kimi-k3');
    assert.equal(seat.saved(), 'tokensapi/kimi-k3');
    assert.deepEqual(seat.calls, ['tokensapi/deepseek-v4-flash', 'tokensapi/kimi-k3']);
});

test('the staged Host is the one under test', options, async () => {
    // Reported, not pinned to a version pattern: which lines the product
    // supports is the product's business, and a new one must not turn this
    // file red. What is asserted is that the seat came from the staged Host.
    const hostRequire = createRequire(resolve(runtimeRoot, 'package.json'));
    const manifest = hostRequire(`${MODEL_SELECTION}/package.json`);
    const where = hostRequire.resolve(`${MODEL_SELECTION}/package.json`);
    console.log(`  ui-model-selection ${manifest.version} from ${runtimeRoot}`);
    assert.ok(
        where.startsWith(resolve(runtimeRoot)),
        'the seat under test must come from DSH_HOST_ROOT',
    );
});
