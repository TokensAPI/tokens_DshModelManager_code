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
        expect(saveModelsSource).toContain(
            'synchronizeMainSelection(body.mainModel, body.mainProvider)',
        );
        expect(SOURCE).toContain("state.visionMode !== 'bridge'");
        expect(SOURCE).toContain('t.nativeVision');
        expect(SOURCE).toContain('t.directVision');
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
