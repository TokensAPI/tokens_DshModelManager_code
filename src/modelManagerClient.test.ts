import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

class FakeElement {
    id = '';
    tagName: string;
    type = '';
    name = '';
    value = '';
    textContent = '';
    disabled = false;
    autocomplete = '';
    spellcheck = false;
    parent: FakeElement | null = null;
    children: FakeElement[] = [];
    style: Record<string, string> & { cssText: string } = { cssText: '' };
    listeners = new Map<string, Array<(event: { preventDefault: () => void }) => void>>();

    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }

    appendChild(child: FakeElement) {
        child.parent = this;
        this.children.push(child);
        return child;
    }

    replaceChildren(...children: FakeElement[]) {
        this.children = [];
        for (const child of children) this.appendChild(child);
    }

    remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter((child) => child !== this);
        this.parent = null;
    }

    setAttribute() {}

    addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    focus() {}

    dispatch(type: string) {
        for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} });
    }

    find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
        if (predicate(this)) return this;
        for (const child of this.children) {
            const match = child.find(predicate);
            if (match) return match;
        }
        return undefined;
    }
}

type ResponseSpec = { status: number; body: Record<string, unknown> } | Error;

function gateHarness(responses: ResponseSpec[]) {
    const html = new FakeElement('html');
    const body = new FakeElement('body');
    html.appendChild(body);
    const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
    const fetchStub = async (url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        if (!next) throw new Error('missing response fixture');
        return {
            ok: next.status >= 200 && next.status < 300,
            status: next.status,
            json: async () => next.body,
        };
    };
    const documentStub = {
        body,
        documentElement: html,
        createElement: (tag: string) => new FakeElement(tag),
        getElementById: (id: string) => html.find((element) => element.id === id),
    };
    let loaded:
        | {
              factory: (require: (id: string) => unknown) => {
                  __manager: { registerAccessGate: () => () => void };
              };
          }
        | undefined;
    const windowStub = {
        __ModuleLoader__: {
            load: (definition: typeof loaded) => {
                loaded = definition;
            },
        },
    };
    const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
    run(windowStub, documentStub, fetchStub, class {});
    if (!loaded) throw new Error('client module was not registered');
    const manager = loaded.factory(() => ({})).__manager;
    manager.registerAccessGate();
    return {
        body,
        calls,
        settle: async () => {
            for (let index = 0; index < 12; index++) await Promise.resolve();
        },
    };
}

describe('Desktop startup API-key gate', () => {
    it('removes the full-screen gate only when startup status is authenticated', async () => {
        const harness = gateHarness([{ status: 200, body: { authenticated: true } }]);
        expect(
            harness.body.find((element) => element.id === 'tokens-model-manager-gate'),
        ).toBeTruthy();
        await harness.settle();
        expect(
            harness.body.find((element) => element.id === 'tokens-model-manager-gate'),
        ).toBeUndefined();
    });

    it('stays locked when no verified key exists', async () => {
        const harness = gateHarness([
            { status: 200, body: { configured: false, authenticated: false } },
        ]);
        await harness.settle();
        expect(
            harness.body.find((element) => element.id === 'tokens-model-manager-gate'),
        ).toBeTruthy();
        expect(harness.body.find((element) => element.tagName === 'FORM')).toBeTruthy();
    });

    it('masks the key by default and lets the user show and hide only the current input', async () => {
        const harness = gateHarness([
            { status: 200, body: { configured: true, authenticated: false } },
        ]);
        await harness.settle();
        const input = harness.body.find((element) => element.id === 'tokens-model-manager-key');
        const reveal = harness.body.find(
            (element) => element.tagName === 'BUTTON' && /Show|显示/.test(element.textContent),
        );
        if (!input || !reveal) throw new Error('masked key controls did not render');
        expect(input.type).toBe('password');
        expect(input.value).toBe('');
        reveal.dispatch('click');
        expect(input.type).toBe('text');
        expect(reveal.textContent).toMatch(/Hide|隐藏/);
        reveal.dispatch('click');
        expect(input.type).toBe('password');
    });

    it('submits the key once and unlocks after backend verification succeeds', async () => {
        const harness = gateHarness([
            { status: 200, body: { configured: false, authenticated: false } },
            { status: 200, body: { configured: true, authenticated: true } },
        ]);
        await harness.settle();
        const input = harness.body.find((element) => element.id === 'tokens-model-manager-key');
        const form = harness.body.find((element) => element.tagName === 'FORM');
        if (!input || !form) throw new Error('gate form did not render');
        input.value = 'tk-user-secret';
        form.dispatch('submit');
        await harness.settle();
        expect(harness.calls[1]?.url).toBe('/tokens/model-manager');
        expect(JSON.parse(harness.calls[1]?.init?.body ?? '{}')).toEqual({
            apiKey: 'tk-user-secret',
        });
        expect(
            harness.body.find((element) => element.id === 'tokens-model-manager-gate'),
        ).toBeUndefined();
    });

    it('keeps the gate visible when verification rejects the key', async () => {
        const harness = gateHarness([
            { status: 200, body: { configured: false, authenticated: false } },
            { status: 401, body: { code: 'invalid_key', error: 'API Key 无效' } },
        ]);
        await harness.settle();
        const input = harness.body.find((element) => element.id === 'tokens-model-manager-key');
        const form = harness.body.find((element) => element.tagName === 'FORM');
        if (!input || !form) throw new Error('gate form did not render');
        input.value = 'bad-key';
        form.dispatch('submit');
        await harness.settle();
        expect(
            harness.body.find((element) => element.id === 'tokens-model-manager-gate'),
        ).toBeTruthy();
        expect(
            harness.body.find((element) => element.textContent.includes('API Key 无效')),
        ).toBeTruthy();
    });

    it('fails closed when the status endpoint is unreachable', async () => {
        const harness = gateHarness([new Error('offline')]);
        await harness.settle();
        expect(
            harness.body.find((element) => element.id === 'tokens-model-manager-gate'),
        ).toBeTruthy();
        expect(harness.body.find((element) => element.tagName === 'FORM')).toBeTruthy();
    });
});

describe('Desktop model-manager settings section', () => {
    it('renders two searchable custom model pickers populated from the backend list', () => {
        expect(SOURCE.match(/modelRow\(t\.(?:main|vision)/g)).toHaveLength(2);
        expect(SOURCE).toContain('maxHeight: 260');
        expect(SOURCE).toContain('placeholder: t.searchModels');
        const pickerSource = SOURCE.slice(
            SOURCE.indexOf('var modelRow'),
            SOURCE.indexOf('{ style: { maxWidth: 760', SOURCE.indexOf('var modelRow')),
        );
        expect(pickerSource).not.toContain("'select'");
        expect(SOURCE).toContain(
            'body: JSON.stringify({ mainModel: mainModel, visionModel: visionModel })',
        );
        const saveModelsSource = SOURCE.slice(
            SOURCE.indexOf('var saveModels'),
            SOURCE.indexOf('var fetchStoredKey'),
        );
        const managerSectionStart = SOURCE.indexOf('function ModelManagerSection');
        const settingsLoadStart = SOURCE.indexOf(
            'var load = react.useCallback',
            managerSectionStart,
        );
        const settingsLoadSource = SOURCE.slice(
            settingsLoadStart,
            SOURCE.indexOf('react.useEffect', settingsLoadStart),
        );
        expect(settingsLoadSource).toContain(
            'synchronizeMainSelection(body.mainModel, body.mainProvider)',
        );
        expect(saveModelsSource).toContain(
            'synchronizeMainSelection(body.mainModel, body.mainProvider)',
        );
        expect(saveModelsSource.indexOf('statePair[1](body)')).toBeLessThan(
            saveModelsSource.indexOf('synchronizeMainSelection(body.mainModel, body.mainProvider)'),
        );
        expect(SOURCE).toContain('t.sessionSwitchFailed');
        expect(SOURCE).toContain("draftVisionMode === 'bridge'");
        expect(SOURCE).toContain('selectedModelVisionMode(state, mainModel)');
        expect(SOURCE).toContain('t.nativeVision');
        expect(SOURCE).toContain('t.bridgeVision');
        expect(SOURCE).toContain('t.directVision');
    });

    it('follows the draft main-model selection and describes the route with the models actually used', () => {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __manager: {
                          selectedModelVisionMode: (
                              state: Record<string, unknown>,
                              mainModel: string,
                          ) => string;
                          modelRouteDescription: (
                              labels: Record<string, string>,
                              visionMode: string,
                              mainModel: string,
                              visionModel: string,
                          ) => string;
                      };
                  };
              }
            | undefined;
        const windowStub = {
            __ModuleLoader__: {
                load: (definition: typeof loaded) => {
                    loaded = definition;
                },
            },
        };
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(windowStub, {}, () => undefined, class {});
        if (!loaded) throw new Error('client module was not registered');
        const manager = loaded.factory(() => ({})).__manager;
        const state = {
            mainModel: 'deepseek-v4-flash',
            visionMode: 'bridge',
            models: [
                { id: 'deepseek-v4-flash', visionMode: 'bridge' },
                { id: 'gpt-5.5', visionMode: 'native' },
                { id: 'direct-text-model', visionMode: 'direct' },
            ],
        };

        expect(manager.selectedModelVisionMode(state, 'gpt-5.5')).toBe('native');
        expect(manager.selectedModelVisionMode(state, 'deepseek-v4-flash')).toBe('bridge');
        expect(manager.selectedModelVisionMode(state, 'direct-text-model')).toBe('direct');
        expect(manager.selectedModelVisionMode(state, 'new-unclassified-model')).toBe('bridge');

        const labels = {
            nativeVision: '对话和图片均由 {mainModel} 原生处理。',
            bridgeVision: '对话由 {mainModel} 处理，图片由 {visionModel} 读取后交给主模型。',
            directVision: '对话由 {mainModel} 处理，当前不能处理图片。',
        };
        expect(manager.modelRouteDescription(labels, 'native', 'gpt-5.5', 'unused')).toBe(
            '对话和图片均由 gpt-5.5 原生处理。',
        );
        expect(
            manager.modelRouteDescription(labels, 'bridge', 'deepseek-v4-flash', 'qwen3.6-35b-a3b'),
        ).toBe('对话由 deepseek-v4-flash 处理，图片由 qwen3.6-35b-a3b 读取后交给主模型。');
    });

    it('reveals and copies a saved key only after an explicit user action', () => {
        expect(SOURCE).toContain("type: keyVisible ? 'text' : secretFieldProps().type");
        expect(SOURCE).toContain('keyVisible ? t.hide : t.show');
        expect(SOURCE).toContain('placeholder: state?.configured ? t.stored : t.key');
        expect(SOURCE).toContain("body: JSON.stringify({ action: 'revealApiKey' })");
        expect(SOURCE).toContain('navigator.clipboard.writeText(value)');
        expect(SOURCE).not.toContain('state.apiKey');
        expect(SOURCE).not.toContain('返回浏览器');
    });

    it('does not mount the redundant legacy vision-engine plugin card', () => {
        expect(SOURCE).not.toContain('registerCard(ctx)');
    });

    it('reapplies the saved model to the current image-bearing session on client startup', async () => {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __manager: {
                          registerManagerSection: (ctx: Record<string, unknown>) => void;
                      };
                  };
              }
            | undefined;
        const windowStub = {
            __ModuleLoader__: {
                load: (definition: typeof loaded) => {
                    loaded = definition;
                },
            },
        };
        const fetchStub = async () => ({
            ok: true,
            json: async () => ({
                provider: 'TokensAPI',
                authenticated: true,
                mainModel: 'claude-opus-5',
                mainProvider: 'tokensapi',
            }),
        });
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(windowStub, {}, fetchStub, class {});
        if (!loaded) throw new Error('client module was not registered');
        const selected: Array<{ provider: string; model: string }> = [];
        let currentSession = 'session-with-images';
        let sessionListener: (() => void) | undefined;
        const directoryStates = new Map<
            string,
            {
                current: { provider: string; model: string } | null;
                groups: Array<{ id: string; models: Array<{ id: string }> }>;
            }
        >();

        loaded
            .factory(() => ({}))
            .__manager.registerManagerSection({
                inject: (_services: string[], callback: (scope: Record<string, unknown>) => void) =>
                    callback({
                        sessions: {
                            list: {
                                getSnapshot: () => ({ current: currentSession }),
                                subscribe: (listener: () => void) => {
                                    sessionListener = listener;
                                    return () => undefined;
                                },
                            },
                            subagentAddress: () => undefined,
                        },
                        modelDirectories: {
                            directoryFor: (sessionId: string) => {
                                let state = directoryStates.get(sessionId);
                                if (!state) {
                                    state = { current: null, groups: [] };
                                    directoryStates.set(sessionId, state);
                                }
                                return {
                                    store: { getSnapshot: () => state },
                                    load: async () => {
                                        state.groups = [
                                            {
                                                id: 'tokensapi',
                                                models: [{ id: 'claude-opus-5' }],
                                            },
                                        ];
                                        return state;
                                    },
                                    select: async (selection: {
                                        provider: string;
                                        model: string;
                                    }) => {
                                        selected.push(selection);
                                        state.current = selection;
                                    },
                                };
                            },
                        },
                        slots: { inject: () => undefined },
                    }),
            });
        for (let index = 0; index < 20; index++) await Promise.resolve();
        currentSession = 'second-image-session';
        sessionListener?.();
        for (let index = 0; index < 20; index++) await Promise.resolve();
        // Ordinary list updates for the same visible selection are deduped.
        sessionListener?.();
        for (let index = 0; index < 20; index++) await Promise.resolve();
        // Re-entering/resetting that same session clears the directory store;
        // the same activation key must no longer suppress the default reload.
        const second = directoryStates.get(currentSession);
        if (!second) throw new Error('second session directory was not created');
        second.current = null;
        second.groups = [];
        sessionListener?.();
        for (let index = 0; index < 20; index++) await Promise.resolve();

        expect(selected).toEqual([
            { provider: 'tokensapi', model: 'claude-opus-5' },
            { provider: 'tokensapi', model: 'claude-opus-5' },
            { provider: 'tokensapi', model: 'claude-opus-5' },
        ]);
    });

    it('switches the currently open session after the managed main model is saved', async () => {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __manager: {
                          synchronizeCurrentSessionModel: (
                              sessions: Record<string, unknown>,
                              modelDirectories: Record<string, unknown>,
                              model: string,
                              provider?: string,
                          ) => Promise<boolean>;
                      };
                  };
              }
            | undefined;
        const windowStub = {
            __ModuleLoader__: {
                load: (definition: typeof loaded) => {
                    loaded = definition;
                },
            },
        };
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(windowStub, {}, () => Promise.reject(new Error('unused')), class {});
        if (!loaded) throw new Error('client module was not registered');
        const selected: Array<{ provider: string; model: string }> = [];
        const sessions = {
            list: { getSnapshot: () => ({ current: 'session-1' }) },
            subagentAddress: () => undefined,
        };
        const modelDirectories = {
            directoryFor: (sessionId: string) => {
                expect(sessionId).toBe('session-1');
                return {
                    select: async (selection: { provider: string; model: string }) => {
                        selected.push(selection);
                    },
                };
            },
        };

        const synchronized = await loaded
            .factory(() => ({}))
            .__manager.synchronizeCurrentSessionModel(
                sessions,
                modelDirectories,
                ' qwen3.6-35b-x ',
            );

        expect(synchronized).toBe(true);
        expect(selected).toEqual([{ provider: 'modlens-tokensapi', model: 'qwen3.6-35b-x' }]);
    });

    it('selects the upstream route for a native multimodal main model', async () => {
        let loaded:
            | { factory: (require: () => unknown) => { __manager: Record<string, unknown> } }
            | undefined;
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            () => Promise.reject(new Error('unused')),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const synchronize = loaded.factory(() => ({})).__manager.synchronizeCurrentSessionModel as (
            sessions: Record<string, unknown>,
            modelDirectories: Record<string, unknown>,
            model: string,
            provider: string,
        ) => Promise<boolean>;
        const selected: Array<{ provider: string; model: string }> = [];

        await expect(
            synchronize(
                {
                    list: { getSnapshot: () => ({ current: 'session-native' }) },
                    subagentAddress: () => undefined,
                },
                {
                    directoryFor: () => ({
                        select: async (selection: { provider: string; model: string }) => {
                            selected.push(selection);
                        },
                    }),
                },
                'claude-opus-4-6',
                'tokensapi',
            ),
        ).resolves.toBe(true);
        expect(selected).toEqual([{ provider: 'tokensapi', model: 'claude-opus-4-6' }]);
    });

    it('waits for the refreshed provider catalog before switching the current session', async () => {
        let loaded:
            | { factory: (require: () => unknown) => { __manager: Record<string, unknown> } }
            | undefined;
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            () => Promise.reject(new Error('unused')),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const synchronize = loaded.factory(() => ({})).__manager.synchronizeCurrentSessionModel as (
            sessions: Record<string, unknown>,
            modelDirectories: Record<string, unknown>,
            model: string,
            provider: string,
            retry: { attempts: number; delayMs: number },
        ) => Promise<boolean>;
        const selected: Array<{ provider: string; model: string }> = [];
        let loads = 0;

        await expect(
            synchronize(
                {
                    list: { getSnapshot: () => ({ current: 'session-refresh' }) },
                    subagentAddress: () => undefined,
                },
                {
                    directoryFor: () => ({
                        load: async () => {
                            loads += 1;
                            return {
                                groups:
                                    loads === 1
                                        ? [
                                              {
                                                  id: 'modlens-tokensapi',
                                                  models: [{ id: 'deepseek-v4-flash' }],
                                              },
                                          ]
                                        : [
                                              {
                                                  id: 'tokensapi',
                                                  models: [{ id: 'claude-opus-4-7' }],
                                              },
                                          ],
                            };
                        },
                        select: async (selection: { provider: string; model: string }) => {
                            selected.push(selection);
                        },
                    }),
                },
                'claude-opus-4-7',
                'tokensapi',
                { attempts: 3, delayMs: 0 },
            ),
        ).resolves.toBe(true);
        expect(loads).toBe(2);
        expect(selected).toEqual([{ provider: 'tokensapi', model: 'claude-opus-4-7' }]);
    });

    it('reloads the shared selector store when a concurrent refresh hides an accepted selection', async () => {
        let loaded:
            | { factory: (require: () => unknown) => { __manager: Record<string, unknown> } }
            | undefined;
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            () => Promise.reject(new Error('unused')),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const synchronize = loaded.factory(() => ({})).__manager.synchronizeCurrentSessionModel as (
            sessions: Record<string, unknown>,
            modelDirectories: Record<string, unknown>,
            model: string,
            provider: string,
            retry: Record<string, number>,
        ) => Promise<boolean>;
        const state = {
            current: null as null | { provider: string; model: string },
            groups: [] as Array<{ id: string; models: Array<{ id: string }> }>,
        };
        let loads = 0;
        let accepted: { provider: string; model: string } | undefined;
        const directory = {
            store: { getSnapshot: () => state },
            load: async () => {
                loads += 1;
                state.groups = [{ id: 'tokensapi', models: [{ id: 'gpt-5.5' }] }];
                // The first load is the pre-selection catalog check. The
                // second represents the Host fact reload after an overlapping
                // refresh won the browser generation and left current null.
                if (loads > 1 && accepted) state.current = accepted;
                return state;
            },
            select: async (selection: { provider: string; model: string }) => {
                accepted = selection;
                // Host accepted it, but the simulated stale refresh owns the
                // client store generation and suppresses select's local echo.
                state.current = null;
            },
        };

        await expect(
            synchronize(
                {
                    list: { getSnapshot: () => ({ current: 'session-raced-selector' }) },
                    subagentAddress: () => undefined,
                },
                { directoryFor: () => directory },
                'gpt-5.5',
                'tokensapi',
                { attempts: 1, delayMs: 0 },
            ),
        ).resolves.toBe(true);
        expect(loads).toBe(2);
        expect(state.current).toEqual({ provider: 'tokensapi', model: 'gpt-5.5' });
    });

    it('waits for the per-session model directory when entering a conversation', async () => {
        let loaded:
            | { factory: (require: () => unknown) => { __manager: Record<string, unknown> } }
            | undefined;
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            () => Promise.reject(new Error('unused')),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const synchronize = loaded.factory(() => ({})).__manager.synchronizeCurrentSessionModel as (
            sessions: Record<string, unknown>,
            modelDirectories: Record<string, unknown>,
            model: string,
            provider: string,
            retry: Record<string, number>,
        ) => Promise<boolean>;
        let resolutions = 0;
        const selected: Array<{ provider: string; model: string }> = [];

        await expect(
            synchronize(
                {
                    list: { getSnapshot: () => ({ current: 'session-entering' }) },
                    subagentAddress: () => undefined,
                },
                {
                    directoryFor: () => {
                        resolutions += 1;
                        if (resolutions === 1) throw new Error('session scope not mounted yet');
                        return {
                            load: async () => ({
                                groups: [{ id: 'tokensapi', models: [{ id: 'gpt-5.5' }] }],
                            }),
                            select: async (selection: { provider: string; model: string }) => {
                                selected.push(selection);
                            },
                        };
                    },
                },
                'gpt-5.5',
                'tokensapi',
                { attempts: 2, delayMs: 0 },
            ),
        ).resolves.toBe(true);
        expect(resolutions).toBe(2);
        expect(selected).toEqual([{ provider: 'tokensapi', model: 'gpt-5.5' }]);
    });

    it('does not select a model that never appears in the refreshed catalog', async () => {
        let loaded:
            | { factory: (require: () => unknown) => { __manager: Record<string, unknown> } }
            | undefined;
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            () => Promise.reject(new Error('unused')),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const synchronize = loaded.factory(() => ({})).__manager.synchronizeCurrentSessionModel as (
            sessions: Record<string, unknown>,
            modelDirectories: Record<string, unknown>,
            model: string,
            provider: string,
            retry: { attempts: number; delayMs: number },
        ) => Promise<boolean>;
        let selects = 0;

        await expect(
            synchronize(
                {
                    list: { getSnapshot: () => ({ current: 'session-timeout' }) },
                    subagentAddress: () => undefined,
                },
                {
                    directoryFor: () => ({
                        load: async () => ({
                            groups: [
                                {
                                    id: 'modlens-tokensapi',
                                    models: [{ id: 'deepseek-v4-flash' }],
                                },
                            ],
                        }),
                        select: async () => {
                            selects += 1;
                        },
                    }),
                },
                'claude-opus-4-7',
                'tokensapi',
                { attempts: 2, delayMs: 0 },
            ),
        ).rejects.toThrow(/模型目录尚未刷新/);
        expect(selects).toBe(0);
    });

    it('recovers when one catalog refresh fails before the new model appears', async () => {
        let loaded:
            | { factory: (require: () => unknown) => { __manager: Record<string, unknown> } }
            | undefined;
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            () => Promise.reject(new Error('unused')),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const synchronize = loaded.factory(() => ({})).__manager.synchronizeCurrentSessionModel as (
            sessions: Record<string, unknown>,
            modelDirectories: Record<string, unknown>,
            model: string,
            provider: string,
            retry: { attempts: number; delayMs: number },
        ) => Promise<boolean>;
        let loads = 0;
        const selected: Array<{ provider: string; model: string }> = [];

        await expect(
            synchronize(
                {
                    list: { getSnapshot: () => ({ current: 'session-recover' }) },
                    subagentAddress: () => undefined,
                },
                {
                    directoryFor: () => ({
                        load: async () => {
                            loads += 1;
                            if (loads === 1) throw new Error('adapter refresh in progress');
                            return {
                                groups: [
                                    {
                                        id: 'tokensapi',
                                        models: [{ id: 'claude-opus-4-7' }],
                                    },
                                ],
                            };
                        },
                        select: async (selection: { provider: string; model: string }) => {
                            selected.push(selection);
                        },
                    }),
                },
                'claude-opus-4-7',
                'tokensapi',
                { attempts: 3, delayMs: 0 },
            ),
        ).resolves.toBe(true);
        expect(loads).toBe(2);
        expect(selected).toEqual([{ provider: 'tokensapi', model: 'claude-opus-4-7' }]);
    });

    it('leaves no-session and addressed subagent views untouched', async () => {
        let loaded:
            | { factory: (require: () => unknown) => { __manager: Record<string, unknown> } }
            | undefined;
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            () => Promise.reject(new Error('unused')),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const synchronize = loaded.factory(() => ({})).__manager.synchronizeCurrentSessionModel as (
            sessions: Record<string, unknown>,
            modelDirectories: Record<string, unknown>,
            model: string,
        ) => Promise<boolean>;
        let selects = 0;
        const directories = {
            directoryFor: () => ({ select: async () => selects++ }),
        };

        await expect(
            synchronize({ list: { getSnapshot: () => ({}) } }, directories, 'qwen3.6-35b-x'),
        ).resolves.toBe(false);
        await expect(
            synchronize(
                {
                    list: { getSnapshot: () => ({ current: 'child' }) },
                    subagentAddress: () => ({ parentSessionId: 'parent' }),
                },
                directories,
                'qwen3.6-35b-x',
            ),
        ).resolves.toBe(false);
        expect(selects).toBe(0);
    });
});
