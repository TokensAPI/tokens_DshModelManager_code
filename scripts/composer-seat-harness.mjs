// Mounts the composer model seat the real Host ships, so a plugin change that
// breaks "pick a model -> the menu closes" fails a test instead of a user.
//
// Everything that decides whether the menu closes is the Host's own staged
// artifact: `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js` carries
// ModelSelect (the seat), ModelDirectory (whose `select` result shape and
// generation guard the seat reads), the shared catalog, and the `apply()` body
// that registers the seat's `select` face over the directory service. Only the
// edges are stood in for:
//   - the presentation primitives (menu card, icons, search field, toast),
//     which carry no selection logic: ModelSelect puts every role, aria-* and
//     data-state this harness asserts on elements of its own;
//   - cordis `Service`, which only registers the directory service;
//   - the session/remote RPC wire and the durable selection projection;
//   - `fetch`, so the plugin's `/tokens/model-manager` route is scripted.
// DSH_RUNTIME_ROOT points at a staged Desktop package directory, which is also
// where jsdom, React and React DOM come from — the versions the Host runs.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInThisContext } from 'node:vm';

const MODEL_SELECTION = '@deepseek-ai/dsh-client-ui-model-selection';
/** This repository's root — the only place the store deps are taken from. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runtime deps of the Host's client packages that a staged Desktop tree does
 * not install — its renderer ships prebuilt, so zustand and immer (which carry
 * `createSnapshotStore`'s copy-on-write semantics) never land there.
 *
 * This repository therefore pins them as devDependencies and the seat resolves
 * them from its own `node_modules`. They used to be read out of the harness
 * checkout's pnpm store, which no gate installs: the six seat cases were green
 * on a developer machine that happened to have one and NOT EXECUTED in CI
 * (T0051). Nothing outside this repository takes part any more, so the cases
 * run wherever the install ran, against the versions HOST-036 holds to the
 * Host's own range. Only `zustand/vanilla`, `zustand/shallow` and
 * `zustand/middleware` are loaded, and none of them imports React — the Host's
 * React stays the only one the seat renders with.
 */
export const STORE_DEPS = Object.freeze(['zustand', 'immer']);

/**
 * Where a store dep resolves from, and the version that lives there.
 * @returns one entry per store dep; `version` is undefined when it is missing.
 */
export function storeDeps() {
    return STORE_DEPS.map((name) => {
        const manifest = resolve(REPO, 'node_modules', name, 'package.json');
        return {
            name,
            manifest,
            version: existsSync(manifest)
                ? JSON.parse(readFileSync(manifest, 'utf-8')).version
                : undefined,
        };
    });
}

/**
 * Let the Host's ESM client packages resolve the deps the staged tree omits,
 * out of this repository's own install.
 * @returns the names that are not installed; empty when the hooks are live.
 */
export function registerStoreDepHooks() {
    const installed = storeDeps().filter((dep) => dep.version !== undefined);
    const missing = storeDeps()
        .filter((dep) => dep.version === undefined)
        .map((dep) => dep.name);
    if (missing.length > 0) return missing;
    // Resolve as if from a file at the repository root, so `zustand/shallow`
    // and friends come out of `<repo>/node_modules` whatever the importer is.
    const base = pathToFileURL(resolve(REPO, 'dsh-harness-resolver.mjs')).href;
    const names = new Set(installed.map((dep) => dep.name));
    registerHooks({
        resolve(specifier, context, next) {
            return names.has(specifier.split('/')[0])
                ? next(specifier, { ...context, parentURL: base })
                : next(specifier, context);
        },
    });
    return missing;
}

/**
 * Presentation stand-ins for @deepseek-ai/dsh-client-ui-primitives. ModelSelect
 * owns every role and state this harness reads, so these only pass children,
 * refs and DOM props through.
 * @param react - the Host's React.
 * @returns the subset of primitives ModelSelect imports.
 */
function primitivesStub(react) {
    const passthrough = react.forwardRef(({ children, ...rest }, ref) =>
        react.createElement('div', { ...rest, ref }, children),
    );
    const icon = () => react.createElement('span', { 'aria-hidden': 'true' });
    const Input = react.forwardRef(({ value, onChange, role, ...rest }, ref) =>
        react.createElement('input', {
            ...rest,
            ref,
            role: role ?? 'searchbox',
            value: value ?? '',
            onChange,
        }),
    );
    return {
        IconCheckOutlineRegular: icon,
        IconChevronDownOutlineRegular: icon,
        IconChevronRightOutlineRegular: icon,
        IconCloseFillRegular: icon,
        IconDataOutlineRegular: icon,
        IconWarningOutlineRegular: icon,
        Input,
        MenuGroup: passthrough,
        MenuSurface: passthrough,
        StateDot: ({ state }) => react.createElement('span', { 'data-state': state }),
        // onDone is the real Toast's dismissal callback, not a DOM handler.
        Toast: ({ children, onDone: _onDone, ...rest }) =>
            react.createElement('div', { role: 'alert', ...rest }, children),
        observeStickyMenuGroups: () => () => {},
        // Upstream ranks by case-insensitive ordered subsequence; the seat only
        // needs "filtered, in catalog order" exercised here.
        rankByName: (models, query) =>
            query === ''
                ? models
                : models.filter((model) =>
                      String(model.name).toLowerCase().includes(query.toLowerCase()),
                  ),
    };
}

/**
 * Evaluate a `window.__ModuleLoader__` bundle and return its module exports.
 * @param source - the bundle text.
 * @param filename - a path used for stack traces.
 * @param resolveModule - resolves the module ids the bundle requires.
 * @returns the bundle's exports.
 */
function loadBundle(source, filename, resolveModule) {
    let definition;
    const previous = globalThis.window.__ModuleLoader__;
    globalThis.window.__ModuleLoader__ = { load: (value) => (definition = value) };
    try {
        runInThisContext(source, { filename });
    } finally {
        globalThis.window.__ModuleLoader__ = previous;
    }
    if (definition === undefined) throw new Error(`${filename} registered no module`);
    return definition.factory(resolveModule);
}

/**
 * Build the document the seat renders into and publish the globals React and
 * the Host's client code read off the window.
 * @param runtimeRoot - the staged Desktop package directory.
 * @returns the jsdom window.
 */
export function openDocument(runtimeRoot) {
    const hostRequire = createRequire(resolve(runtimeRoot, 'package.json'));
    const { JSDOM } = hostRequire('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        pretendToBeVisual: true,
        url: 'https://localhost/',
    });
    const { window } = dom;
    for (const key of [
        'window',
        'document',
        'navigator',
        'Node',
        'Element',
        'HTMLElement',
        'HTMLInputElement',
        'HTMLButtonElement',
        'Event',
        'CustomEvent',
        'MouseEvent',
        'KeyboardEvent',
        'getComputedStyle',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'MutationObserver',
    ]) {
        if (window[key] === undefined) continue;
        // Node publishes some of these as getter-only globals of its own.
        Object.defineProperty(globalThis, key, {
            configurable: true,
            writable: true,
            value: window[key],
        });
    }
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    // jsdom has no layout; the seat scrolls its highlighted row into view.
    window.Element.prototype.scrollIntoView = () => {};
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    return window;
}

/**
 * Load the Host's model-selection client plugin and return the composer seat it
 * registers, over the real directory service it registers the seat against.
 * @param options - staged runtime root, session id and the scripted RPC wire.
 * @returns the seat component, its slot face, the directory resolver and `t`.
 */
export async function openComposerSeat({
    runtimeRoot,
    sessionId = 'session-under-test',
    catalog,
    selectModel,
    locale = 'zh',
}) {
    const hostRequire = createRequire(resolve(runtimeRoot, 'package.json'));
    const react = hostRequire('react');
    const storeModule = await import(
        pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-client-store')).href
    );
    const modules = {
        react,
        'react-dom': hostRequire('react-dom'),
        'react/jsx-runtime': hostRequire('react/jsx-runtime'),
        '@deepseek-ai/dsh-client-store': storeModule,
        // The directory service only needs a base class to extend; service
        // registration is not part of what closes the menu.
        '@deepseek-ai/cordis': {
            Service: class {
                constructor(ctx) {
                    this.ctx = ctx;
                }
            },
        },
        '@deepseek-ai/dsh-client-ui-primitives': primitivesStub(react),
    };
    const selectionPath = hostRequire.resolve(`${MODEL_SELECTION}/client`);
    const hostClient = loadBundle(readFileSync(selectionPath, 'utf-8'), selectionPath, (id) => {
        const found = modules[id];
        if (found === undefined) throw new Error(`unexpected Host module require: ${id}`);
        return found;
    });

    // The session plumbing the resolver reads: a scope to hang the directory's
    // disposer on, a per-session binding to key it by, and the durable model
    // selection projected from session history (DSH 0.2's `next`).
    const projections = new Map();
    const bindings = new Map();
    const projectionFor = (id) => {
        let entry = projections.get(id);
        if (entry === undefined) {
            entry = { next: null, listeners: new Set() };
            projections.set(id, entry);
        }
        return entry;
    };
    const bindingFor = (id) => {
        let binding = bindings.get(id);
        if (binding === undefined) {
            const entry = projectionFor(id);
            binding = {
                session: {
                    projections: {
                        faceOf: () => ({
                            getSnapshot: () => ({ next: entry.next, lastUsed: entry.next }),
                            subscribe: (listener) => {
                                entry.listeners.add(listener);
                                return () => entry.listeners.delete(listener);
                            },
                        }),
                    },
                    getSnapshot: () => ({ blank: true }),
                },
            };
            bindings.set(id, binding);
        }
        return binding;
    };
    const sessions = {
        scope: () => ({ effect: () => {} }),
        binding: (id) => bindingFor(id),
        subagentAddress: () => undefined,
        // DSH 0.2 dropped `current` from the snapshot.
        list: {
            getSnapshot: () => ({ ids: [...bindings.keys()], byId: {} }),
            subscribe: () => () => {},
        },
    };
    const wire = {
        modelCatalog: async () => ({ ok: true, value: catalog() }),
        selectModel: async (request) => {
            const result = await selectModel(request);
            if (result.ok) {
                const entry = projectionFor(request.sessionId);
                entry.next = { provider: request.provider, model: request.model };
                for (const listener of [...entry.listeners]) listener();
            }
            return result;
        },
    };

    let dictionaries;
    let seat;
    const bind = () => (key, params) => {
        const template = dictionaries?.[locale]?.[key] ?? key;
        return params === undefined
            ? template
            : String(template).replace(/\{(\w+)\}/g, (match, name) =>
                  name in params ? String(params[name]) : match,
              );
    };
    const ctx = {
        sessions,
        remote: { session: wire, $on: () => () => {} },
        on: () => () => {},
        effect: (factory) => factory(),
        get: (name) => (name === 'commandUi' ? { register: () => () => {} } : undefined),
        locale: {
            register: (_ns, values) => {
                dictionaries = values;
                return () => {};
            },
            bind,
        },
        plugin: () => {},
        inject: (_names, callback) => callback(scope),
    };
    const scope = {
        ...ctx,
        modelDirectories: undefined,
        slots: {
            inject: (_name, factory) => factory(),
            register: (definition, Component) => {
                seat = { definition, Component };
                return seat;
            },
        },
    };
    // apply() mounts the resolver through ctx.plugin; it is built here instead
    // so the plugin under test can be handed the same instance.
    const resolver = new hostClient.ModelDirectoryResolver(ctx);
    scope.modelDirectories = resolver;
    hostClient.apply(ctx);
    if (seat === undefined) throw new Error('the Host registered no composer model seat');
    // Resolving the binding up front keeps `sessions.list` honest about which
    // sessions exist before the seat asks for its directory.
    bindingFor(sessionId);

    return {
        react,
        hostRequire,
        resolver,
        sessionId,
        t: bind(),
        Component: seat.Component,
        face: () => seat.definition.inject(sessionId),
        directory: () => resolver.directoryFor(sessionId),
    };
}

/**
 * Render the seat and return the handful of reads and clicks a case needs.
 * Every query reads an attribute ModelSelect sets itself, so the presentation
 * stand-ins cannot make a closed menu look open or the other way round.
 * @param seat - the value openComposerSeat returned.
 * @returns render controls and DOM reads over the mounted seat.
 */
export async function mountSeat(seat) {
    const { react } = seat;
    const { createRoot } = seat.hostRequire('react-dom/client');
    const { act } = react;
    const container = globalThis.document.createElement('div');
    globalThis.document.body.appendChild(container);
    const root = createRoot(container);
    const renderSlot = (_name, _owner, options) => options?.fallback ?? null;
    const Seat = () =>
        react.createElement(seat.Component, {
            locked: false,
            ...seat.face(),
            t: seat.t,
            renderSlot,
        });
    await act(async () => root.render(react.createElement(Seat)));

    // Scope every read to this seat: the menu card is portaled to document.body
    // under the id the trigger points at, so a case that leaves another seat
    // mounted cannot be read as this one's menu.
    const trigger = () => container.querySelector('button[aria-haspopup="menu"]');
    const menu = () => {
        const id = trigger()?.getAttribute('aria-controls');
        return id === null || id === undefined ? null : globalThis.document.getElementById(id);
    };
    const inMenu = (selector) => [...(menu()?.querySelectorAll(selector) ?? [])];
    const controls = {
        act,
        /** Let every already-resolved promise and effect land. */
        settle: async (turns = 40) => {
            await act(async () => {
                for (let index = 0; index < turns; index += 1) await Promise.resolve();
            });
        },
        wait: async (ms) => {
            await act(async () => {
                await new Promise((done) => setTimeout(done, ms));
            });
        },
        click: async (element) => {
            await act(async () => {
                element.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
            });
        },
        trigger,
        label: () => trigger()?.textContent,
        open: () => trigger()?.getAttribute('aria-expanded') === 'true',
        cells: () => inMenu('[role="menuitem"]'),
        rows: () => inMenu('[role="menuitemradio"]'),
        toasts: () =>
            [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
        /**
         * Open the menu and land on the model list. The seat opens straight
         * onto that list while no model is selected yet, and on the Model /
         * Effort root pair once one is.
         */
        openModelPane: async () => {
            await controls.click(trigger());
            if (controls.rows().length > 0) return;
            const cell = controls.cells()[0];
            if (cell === undefined) throw new Error('the open menu offered no model cell');
            await controls.click(cell);
        },
        rowFor: (model) => {
            const row = controls.rows().find((node) => node.textContent.includes(model));
            if (row === undefined) {
                throw new Error(
                    `no row for ${model}; rows: ${controls.rows().map((node) => node.textContent)}`,
                );
            }
            return row;
        },
        unmount: async () => {
            await act(async () => root.unmount());
            container.remove();
        },
    };
    // The shared catalog loads asynchronously; let it land so a case always
    // starts from the same pane rather than from whatever the clock allowed.
    await controls.settle();
    return controls;
}

/**
 * Evaluate the plugin's browser half against the same globals.
 * @param options - the plugin client path, a scripted `fetch` and the Host require.
 * @returns the plugin's `__manager` entry points.
 */
export function loadPluginClient({ clientPath, fetch, hostRequire }) {
    globalThis.fetch = fetch;
    const bundle = loadBundle(readFileSync(clientPath, 'utf-8'), clientPath, (id) =>
        id === 'react' || id === 'react/jsx-runtime' ? hostRequire(id) : {},
    );
    if (bundle.__manager === undefined) throw new Error(`${clientPath} exposed no __manager`);
    return bundle.__manager;
}
