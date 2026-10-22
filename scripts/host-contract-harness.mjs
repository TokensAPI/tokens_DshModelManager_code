// Shared fixture for the real-Host contract cases (`npm run check:host`).
//
// The gate hands this repository exactly one environment variable,
// `DSH_HOST_ROOT` — the staged Host's `dsh-plugin-desktop` directory. Every
// Host artifact below is resolved from it, so the code under test talks to the
// Host the product ships rather than to anything this checkout installed. The
// repo's own older name `DSH_RUNTIME_ROOT` is still accepted so the three
// existing verify-*.mjs files keep working unchanged; `scripts/check-host.mjs`
// sets it from `DSH_HOST_ROOT`.
//
// `liveHost` is the faithful shape: the Host's own `boot()` brings up a
// throwaway profile with the real Loader, the real settings service, the real
// web server, the real llm registry, the real file-backed credential provider,
// the real attachment store, the real tool runtime, the real agent registry and
// the real `llm-pi-ai` provider plugin, and the **Host's loader activates this
// plugin** from a profile patch that mirrors the shipped `cordis.patch.yml`.
// Nothing on the Host side is stood in for. The two edges that are:
//   - TokensAPI itself (the plugin's own `https://tokensapi.ai/v1` catalog read
//     goes through a scripted `globalThis.fetch`, because a contract case must
//     not spend a paid quota or depend on a network);
//   - the upstream wire of whichever adapter a case parks behind the managed
//     route, when that case is about the plugin's own forwarding rather than
//     about pi-ai.
// Both are the plugin's outbound HTTP, never a Host interface.
//
// DSH 0.1.5 has no `@deepseek-ai/dsh-config-editor` and no `@deepseek-ai/dsh-hmr`,
// so a profile cannot be booted there at all. `liveHost` reports
// `mode: 'services'` on that line: the same real service classes on a real
// Context, the real `SettingsProvider` behind an in-memory persist, and the
// plugin entered through its own exported `apply`. Every case states which mode
// it ran in, so a green run is never mistaken for a profile run.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This checkout's root, used to prove which copy of the plugin is under test. */
export const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The plugin entry the Host loads: `exports['.']` of this package. */
export const PLUGIN_ENTRY = join(CHECKOUT, 'dsh', 'index.js');

/** The plugin's browser half, loaded by the Host's client runner. */
export const PLUGIN_CLIENT = join(CHECKOUT, 'dsh', 'client.js');

/**
 * The staged Host directory under test.
 * @returns the `dsh-plugin-desktop` path, or undefined when the gate set none.
 */
export function hostRoot() {
    const root = process.env.DSH_HOST_ROOT ?? process.env.DSH_RUNTIME_ROOT;
    return root === undefined || root.trim() === '' ? undefined : root;
}

/**
 * The reason every case in a file reports NOT EXECUTED, for `node --test`'s
 * `skip` option. A skipped case is never a pass: `check:host` exits non-zero
 * when it sees one, so a gate leg with no Host fails instead of looking green.
 * @returns the skip reason, or false when a Host is available.
 */
export function withoutHost() {
    return hostRoot() === undefined ? 'NOT EXECUTED: DSH_HOST_ROOT is not set' : false;
}

/**
 * Resolve from the staged Host's module tree.
 * @returns a `require` anchored at the Host's package.json.
 */
export function hostRequire() {
    return createRequire(resolve(hostRoot(), 'package.json'));
}

/**
 * Import one Host package from the staged tree.
 * @param name - the package specifier.
 * @param from - an alternative resolver, for deps of a Host package.
 * @returns the module namespace.
 */
export function hostLoad(name, from = hostRequire()) {
    return import(pathToFileURL(from.resolve(name)).href);
}

/**
 * The DSH minor line of the staged Host, read from the Host's own llm package.
 * The line decides which of two settings services exists (0.1 registers
 * namespaces, 0.2 writes profile entries), which is the only Host difference
 * these cases branch on.
 * @returns `{ version, line }`, for example `{ version: '0.2.1-rc.2', line: '0.2' }`.
 */
export function hostLine() {
    const version = hostRequire()('@deepseek-ai/dsh-llm/package.json').version;
    return { version, line: /^0\.1\./.test(version) ? '0.1' : '0.2' };
}

/** A 1x1 PNG, the smallest input the Host's image admission accepts. */
export const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64',
);

/** The product's own model ids, so a case reads what the shipped patch pins. */
export const MAIN_MODEL = 'deepseek-v4-flash';
export const UPSTREAM = 'tokensapi';
export const MANAGED = 'modlens-tokensapi';

/**
 * The TokensAPI catalog read the plugin makes for its own two model lists.
 *
 * This is the plugin's outbound HTTP, not a Host interface: it answers the one
 * shape the plugin parses (`data[].id` plus the modality and endpoint fields it
 * reads) and records every call so a case can assert how many were made.
 * @param models - model ids the catalog advertises.
 * @returns `{ request, calls }`; install `request` as `globalThis.fetch`.
 */
export function tokensApiCatalog(models = [MAIN_MODEL]) {
    const calls = [];
    const request = async (url) => {
        calls.push(String(url));
        return {
            ok: true,
            status: 200,
            json: async () => ({
                data: models.map((id) => ({
                    id,
                    input: ['text'],
                    supported_endpoint_types: ['openai'],
                    contextWindow: 262144,
                    maxTokens: 32768,
                })),
            }),
        };
    };
    return { request, calls };
}

/**
 * Poll until a condition the plugin reaches on its own holds.
 *
 * The reconciliations under test run detached from the write that caused them,
 * so polling is what a caller can do; the deadline turns "never happens" into a
 * failure instead of a hung run.
 * @param describe - what is awaited, for the failure message.
 * @param ready - predicate, polled until it holds.
 * @param attempts - how many 10ms polls to allow.
 */
export async function until(describe, ready, attempts = 300) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await ready()) return;
        await new Promise((settle) => setTimeout(settle, 10));
    }
    throw new Error(`timed out waiting for ${describe}`);
}

/**
 * Let work the Host scheduled during disposal finish before the profile goes.
 *
 * Disposing the llm registry publishes a last `llm/adapters-updated`, and this
 * plugin reconciles on that event — detached, as every Host notification
 * listener is. Removing the temporary home in the same tick turns that
 * reconciliation's route write into an ENOENT the plugin reports and swallows:
 * harmless, but it reads like a failure in a gate log.
 */
function release() {
    return new Promise((done) => setTimeout(done, 50));
}

/** The profile patch the shipped `cordis.patch.yml` pins, as loader entries. */
function profileEntries(home, pluginConfig) {
    return [
        { id: 'config-editor', name: 'cordis:editor' },
        { id: 'settings', name: 'cordis:settings' },
        {
            id: 'web-server',
            name: 'cordis:webServer',
            config: { host: '127.0.0.1', port: 0 },
        },
        { id: 'llm', name: 'cordis:llm' },
        {
            id: 'credentials-local',
            name: 'cordis:credentialsLocal',
            config: {
                path: join(home, '.credentials.yaml'),
                dshHome: home,
                watch: false,
                debounceMs: 0,
            },
        },
        { id: 'attachment-local', name: 'cordis:attachmentLocal', config: { dshHome: home } },
        { id: 'system-prompt', name: 'cordis:systemPrompt' },
        { id: 'tools', name: 'cordis:tools' },
        { id: 'agents', name: 'cordis:agents' },
        // The real provider plugin the shipped patch configures, with the
        // product's own TokensAPI route. The plugin writes this entry through
        // settings.update, so it has to be the real one.
        {
            id: 'llm-pi-ai',
            name: 'cordis:piAi',
            config: {
                providers: {
                    [UPSTREAM]: {
                        displayName: 'TokensAPI',
                        apiKeyEnv: 'TOKENSAPI_API_KEY',
                        api: 'openai-completions',
                        baseURL: 'https://tokensapi.ai/v1',
                        defaultContextWindow: 262144,
                        models: [
                            {
                                id: MAIN_MODEL,
                                name: 'DeepSeek V4 Flash',
                                contextWindow: 262144,
                                maxTokens: 32768,
                            },
                        ],
                    },
                },
            },
        },
        {
            id: 'agent-default-model',
            name: 'cordis:agentDefaultModel',
            config: { provider: MANAGED, model: MAIN_MODEL },
        },
        { id: 'tokens-model-manager', name: 'cordis:tokensModelManager', config: pluginConfig },
    ];
}

/**
 * Boot the Host and let its Loader activate this plugin (DSH 0.2 lines).
 * @param t - the case, so the Host and its temporary home are always released.
 * @param pluginConfig - the plugin entry config.
 * @returns the booted Host context plus the paths a case needs.
 */
async function profileHost(t, pluginConfig) {
    const require_ = hostRequire();
    const { boot, initProfile, readProfilePatches } = await hostLoad('@deepseek-ai/dsh-app-boot');
    const settingsModule = await hostLoad('@deepseek-ai/dsh-settings');
    // The config editor is a dependency of the settings package, not of the CLI.
    const fromSettings = createRequire(require_.resolve('@deepseek-ai/dsh-settings'));
    const { default: ConfigEditor } = await hostLoad(
        '@deepseek-ai/dsh-config-editor',
        fromSettings,
    );
    const { default: Timer } = await hostLoad('@deepseek-ai/cordis-plugin-timer');
    const { default: Hmr } = await hostLoad('@deepseek-ai/dsh-hmr');
    const { WebServer } = await hostLoad('@deepseek-ai/dsh-host-webserver');
    const { LlmRuntime } = await hostLoad('@deepseek-ai/dsh-llm');
    const { default: LocalCredentialProvider } = await hostLoad(
        '@deepseek-ai/dsh-credentials-local',
    );
    const { LocalAttachmentStore } = await hostLoad('@deepseek-ai/dsh-attachment-local');
    const { default: SystemPrompt } = await hostLoad('@deepseek-ai/dsh-system-prompt');
    const { ToolRuntime } = await hostLoad('@deepseek-ai/dsh-tools');
    const { AgentRegistry } = await hostLoad('@deepseek-ai/dsh-agent');
    const { default: AgentDefaultModel } = await hostLoad('@deepseek-ai/dsh-agent-default-model');
    const piAi = await hostLoad('@deepseek-ai/dsh-llm-pi-ai');
    const plugin = await import(pathToFileURL(PLUGIN_ENTRY).href);

    // A throwaway $DSH_HOME. Never `$DSH_HOME/profiles/node_modules`: dsh owns
    // that path (app-boot's healProfilesModuleFallback wants a symlink or its
    // own module proxy there) and occupying it stops 0.1.5 from booting at all.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'modlens-host-')));
    const dir = join(home, 'profiles', 'contract');
    initProfile(dir, ['contract-bundle']);
    const bundle = join(dir, 'node_modules', 'contract-bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(home, 'package.json'), '{"name":"contract-installation"}\n');
    writeFileSync(
        join(bundle, 'package.json'),
        JSON.stringify({
            name: 'contract-bundle',
            version: '1.0.0',
            dsh: { bundle: { patch: 'cordis.patch.yml' } },
        }),
    );
    writeFileSync(
        join(bundle, 'cordis.patch.yml'),
        JSON.stringify([{ insert: profileEntries(home, pluginConfig) }]),
    );
    writeFileSync(join(dir, 'cordis.yml'), '[]\n');
    const profile = {
        name: 'contract',
        startedBundles: ['contract-bundle'],
        dir,
        patchPath: join(dir, 'cordis.patch.yml'),
        installAnchor: join(home, 'package.json'),
        cwd: home,
        home,
        overlays: [],
        telemetryDisabledEnv: undefined,
    };
    const ctx = await boot(
        'contract',
        join(dir, 'cordis.yml'),
        readProfilePatches('contract', profile),
        (root) => {
            root.provide('profileContext', profile);
            root.provide('appReady', {
                onReady: (listener) => {
                    listener();
                    return () => {};
                },
            });
            // The builtin table is how a boot without an installed node_modules
            // reaches a package. Every value here is the Host's own class —
            // except `tokensModelManager`, which is THIS checkout's module, so
            // the Loader activates the code under test rather than the copy the
            // staged Host pins in its own product-plugins (HOST-001 asserts it).
            Object.assign(root.loader.builtins, {
                editor: ConfigEditor,
                settings: settingsModule.default,
                webServer: WebServer,
                llm: LlmRuntime,
                credentialsLocal: LocalCredentialProvider,
                attachmentLocal: LocalAttachmentStore,
                systemPrompt: SystemPrompt,
                tools: ToolRuntime,
                agents: AgentRegistry,
                agentDefaultModel: AgentDefaultModel,
                piAi,
                tokensModelManager: plugin,
            });
        },
    );
    await ctx.plugin(Timer);
    const hmr = ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 });
    await hmr.await();
    await ctx.hmr.runExclusive(async () => {});
    t.after(async () => {
        await ctx.fiber.dispose();
        await release();
        rmSync(home, { recursive: true, force: true });
    });
    return { ctx, home, dir, plugin, mode: 'profile' };
}

/**
 * Bring up the same real services without a profile (DSH 0.1.5 lines).
 *
 * 0.1.5 ships no config editor and no HMR, so its Loader cannot be booted from
 * a patch here. The services are still the Host's own; what changes is that the
 * settings service is the Host's real `SettingsProvider` with an in-memory
 * persist, and this plugin is entered through its own exported `apply` instead
 * of by the Loader.
 * @param t - the case, so the context and its temporary home are released.
 * @param pluginConfig - the plugin entry config.
 * @returns the Host context plus the paths a case needs.
 */
async function serviceHost(t, pluginConfig) {
    const { Context } = await hostLoad('@deepseek-ai/cordis');
    const settingsModule = await hostLoad('@deepseek-ai/dsh-settings');
    const { WebServer } = await hostLoad('@deepseek-ai/dsh-host-webserver');
    const { LlmRuntime } = await hostLoad('@deepseek-ai/dsh-llm');
    const { default: LocalCredentialProvider } = await hostLoad(
        '@deepseek-ai/dsh-credentials-local',
    );
    const { LocalAttachmentStore } = await hostLoad('@deepseek-ai/dsh-attachment-local');
    const { default: SystemPrompt } = await hostLoad('@deepseek-ai/dsh-system-prompt');
    const { ToolRuntime } = await hostLoad('@deepseek-ai/dsh-tools');
    const { AgentRegistry } = await hostLoad('@deepseek-ai/dsh-agent');
    const { default: AgentDefaultModel } = await hostLoad('@deepseek-ai/dsh-agent-default-model');
    const piAi = await hostLoad('@deepseek-ai/dsh-llm-pi-ai');
    const plugin = await import(pathToFileURL(PLUGIN_ENTRY).href);
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'modlens-host-')));
    const ctx = new Context();
    // The Host's own settings service, with only its document persistence
    // standing in: 0.1's provider writes a profile document, and a contract run
    // must not touch the user's. Everything the plugin calls — register, get,
    // describe, update — is the Host's.
    class PersistedSettings extends settingsModule.SettingsProvider {
        // `writable` is the Host's own abstract gate: a provider that does not
        // declare it refuses every in-process write, which would make the
        // plugin's route writes untestable rather than broken.
        get writable() {
            return true;
        }
        async load() {
            return {};
        }
        async persist() {}
    }
    new PersistedSettings(ctx);
    new LlmRuntime(ctx);
    new LocalCredentialProvider(ctx, {
        path: join(home, '.credentials.yaml'),
        dshHome: home,
        watch: false,
        debounceMs: 0,
    });
    new LocalAttachmentStore(ctx, LocalAttachmentStore.Config({ dshHome: home }));
    new AgentRegistry(ctx);
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await();
    await ctx.plugin(SystemPrompt, {}).await();
    await ctx.plugin(ToolRuntime, {}).await();
    await ctx.plugin(AgentDefaultModel, { provider: MANAGED, model: MAIN_MODEL }).await();
    // The real provider plugin, with the product's own TokensAPI route: the
    // plugin writes this route's settings namespace for real.
    await ctx
        .plugin(piAi, {
            providers: {
                [UPSTREAM]: {
                    displayName: 'TokensAPI',
                    apiKeyEnv: 'TOKENSAPI_API_KEY',
                    api: 'openai-completions',
                    baseURL: 'https://tokensapi.ai/v1',
                    defaultContextWindow: 262144,
                    models: [
                        {
                            id: MAIN_MODEL,
                            name: 'DeepSeek V4 Flash',
                            contextWindow: 262144,
                            maxTokens: 32768,
                        },
                    ],
                },
            },
        })
        .await();
    plugin.apply(ctx, pluginConfig);
    t.after(async () => {
        await ctx.fiber.dispose();
        await release();
        rmSync(home, { recursive: true, force: true });
    });
    return { ctx, home, dir: undefined, plugin, mode: 'services' };
}

/**
 * The real Host this plugin is contracted against, with the plugin live on it.
 *
 * @param t - the case, so every Host handle is released even on failure.
 * @param options.config - plugin entry config; the shipped patch's values by default.
 * @param options.catalog - model ids the scripted TokensAPI catalog advertises.
 * @param options.managed - the managed route id to wait for; the shipped one by default.
 * @param options.beforeSettle - runs on the booted context before the wait, for a
 *   case that parks its own upstream adapter (the plugin only registers its
 *   wrapper once the upstream route exists, so it cannot be registered after).
 * @returns `{ ctx, origin, request, calls, mode, line, home, plugin }`.
 */
export async function liveHost(
    t,
    { config = {}, catalog = [MAIN_MODEL], managed = MANAGED, beforeSettle } = {},
) {
    const { line, version } = hostLine();
    const pluginConfig = {
        upstream: UPSTREAM,
        providerId: MANAGED,
        settingsCard: false,
        pasteToPath: false,
        ...config,
    };
    // The plugin's TokensAPI read has no caller to hand a fetch to when a Host
    // notification triggers it, so the stub has to be the global one. Captured
    // first: the cases drive the Host's own loopback routes over real HTTP, and
    // that needs the untouched fetch.
    const hostFetch = globalThis.fetch;
    const { request, calls } = tokensApiCatalog(catalog);
    globalThis.fetch = request;
    t.after(() => {
        globalThis.fetch = hostFetch;
    });
    const host =
        line === '0.1' ? await serviceHost(t, pluginConfig) : await profileHost(t, pluginConfig);
    const extra = await beforeSettle?.(host.ctx);
    // The plugin's registration, its settings replay and its first route
    // activation all run detached from `apply`. Settle them here so a case
    // observes a started plugin, and so a write that would otherwise land after
    // the fixture disposed the Host cannot be mistaken for a failure.
    await until(
        `the managed route ${managed} to register`,
        () => host.ctx.llm.listProviders().some((info) => info.id === managed),
        400,
    );
    // `modelManagerStatus` awaits the plugin's own `settingsReady`, which is
    // resolved by the same closure that performs the startup route activation.
    await host.plugin.__modelManager.modelManagerStatus(host.ctx, request, {
        refreshModels: false,
    });
    await host.plugin.__modelManager.credentialRefreshSettled(host.ctx);
    return {
        ...host,
        ...(extra ?? {}),
        line,
        version,
        hostFetch,
        request,
        calls,
        pluginConfig,
        managed,
        origin: () => serverOrigin(host.ctx),
    };
}

/**
 * The loopback origin the Host's web server is listening on.
 *
 * `getOrigin()` arrived with DSH 0.2.1; earlier lines expose only the bound
 * host and port. This is a reader in the harness, not a plugin dependency —
 * the plugin registers routes and never asks where the server is — so taking
 * either form keeps the cases running on every supported line.
 * @param ctx - the booted Host context.
 * @returns the origin, for example `http://127.0.0.1:53138`.
 */
function serverOrigin(ctx) {
    const server = ctx.webServer;
    if (typeof server.getOrigin === 'function') return server.getOrigin();
    return `${server.protocol ?? 'http:'}//${server.host}:${server.port}`;
}

/**
 * One real loopback HTTP call against the Host's own web server.
 * @param host - the value `liveHost` returned.
 * @param path - the pathname, with any query.
 * @param init - fetch init; `headers` reach the plugin's same-origin fence.
 * @returns `{ status, body, text }`; `body` is undefined for non-JSON answers.
 */
export async function hostRequest(host, path, init = {}) {
    const response = await host.hostFetch(new URL(path, host.origin()), init);
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = undefined;
    }
    return { status: response.status, body, text };
}
