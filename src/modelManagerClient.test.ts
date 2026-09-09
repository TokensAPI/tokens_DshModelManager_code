import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

describe('bounded model settings operations', () => {
    afterEach(() => vi.useRealTimers());
    function scope(fetchMock: unknown) {
        let definition: { factory: CallableFunction } | undefined;
        new Function('window', 'fetch', SOURCE)(
            {
                __ModuleLoader__: {
                    load: (value: { factory: CallableFunction }) => {
                        definition = value;
                    },
                },
            },
            fetchMock,
        );
        return definition?.factory(() => ({})).__manager.createManagerRequests();
    }
    it('ends waiting for a stalled body and can retry without changing saved configuration', async () => {
        vi.useFakeTimers();
        const saved = { key: 'saved-key', model: 'saved-model' };
        let pending = true;
        let signal: AbortSignal | undefined;
        const requests = scope(async (_url: string, options: RequestInit) => {
            signal = options.signal as AbortSignal;
            return {
                ok: true,
                json: () =>
                    pending ? new Promise(() => {}) : Promise.resolve({ models: ['new'] }),
            };
        });
        const start = vi.fn(),
            success = vi.fn(),
            error = vi.fn(),
            finish = vi.fn();
        const job = requests.run('/tokens/model-manager', {}, { start, success, error, finish });
        expect(start).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(25_001);
        await job;
        expect(error.mock.calls[0][0].message).toContain('超时');
        expect(finish).toHaveBeenCalledOnce();
        expect(success).not.toHaveBeenCalled();
        expect(signal?.aborted).toBe(true);
        expect(saved).toEqual({ key: 'saved-key', model: 'saved-model' });
        pending = false;
        await requests.run('/tokens/model-manager', {}, { success });
        expect(success).toHaveBeenCalledWith({ models: ['new'] }, expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
    });
    it('ignores a superseded response and a response after disposal', async () => {
        let resolveFirst: (value: unknown) => void = () => {};
        const requests = scope(
            vi
                .fn()
                .mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            resolveFirst = resolve;
                        }),
                )
                .mockResolvedValue({ ok: true, json: async () => ({ model: 'new' }) }),
        );
        const old = vi.fn(),
            current = vi.fn();
        const first = requests.run('/tokens/model-manager', {}, { success: old });
        await Promise.resolve();
        await requests.run('/tokens/model-manager', {}, { success: current });
        resolveFirst({ ok: true, json: async () => ({ model: 'old' }) });
        await first;
        expect(old).not.toHaveBeenCalled();
        expect(current).toHaveBeenCalledOnce();
        const last = requests.run('/tokens/model-manager', {}, { success: old });
        requests.dispose();
        await last;
        expect(old).not.toHaveBeenCalled();
    });
    for (const kind of ['http', 'json', 'headers']) {
        it(`restores controls after ${kind} failure`, async () => {
            vi.useFakeTimers();
            const requests = scope(async () => {
                if (kind === 'headers') return new Promise(() => {});
                return {
                    ok: kind !== 'http',
                    json: async () => {
                        if (kind === 'json') throw new SyntaxError('invalid response');
                        return { error: '备用线路服务暂时不可用，请重试' };
                    },
                };
            });
            const success = vi.fn(),
                error = vi.fn(),
                finish = vi.fn();
            const job = requests.run('/tokens/model-manager', {}, { success, error, finish });
            await vi.advanceTimersByTimeAsync(25_001);
            await job;
            expect(success).not.toHaveBeenCalled();
            expect(error).toHaveBeenCalledOnce();
            expect(finish).toHaveBeenCalledOnce();
            expect(requests.active).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
        });
    }
});

describe('fallback settings component clicks', () => {
    afterEach(() => vi.useRealTimers());
    it('shows immediate progress, ignores double clicks, preserves saved values on failure, and retries', async () => {
        vi.useFakeTimers();
        type Element = {
            type: string;
            props: Record<string, CallableFunction | string | boolean>;
            children: unknown[];
        };
        let loaded: { factory: CallableFunction } | undefined;
        let fail = true;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: () =>
                fail ? new Promise(() => {}) : Promise.resolve({ models: [{ id: 'new-chat' }] }),
        }));
        new Function('window', 'document', 'fetch', SOURCE)(
            {
                __ModuleLoader__: {
                    load: (value: { factory: CallableFunction }) => {
                        loaded = value;
                    },
                },
            },
            { documentElement: { lang: 'zh' } },
            fetchMock,
        );
        const saved = {
            authenticated: true,
            channel: 'tokensapi',
            mainModel: 'deepseek-v4-flash',
            official: {
                configured: true,
                baseURL: 'https://backup.example/v1',
                mainModel: 'saved-chat',
            },
        };
        const states: unknown[] = [
            saved,
            '',
            '',
            'https://backup.example/v1',
            'saved-chat',
            [{ id: 'saved-chat' }],
            '',
            'deepseek-v4-flash',
            'openai-completions',
            '',
            '',
            false,
            false,
            true,
        ];
        let cursor = 0;
        const react = {
            useState(initial: unknown) {
                const index = cursor++;
                if (!(index in states))
                    states[index] = typeof initial === 'function' ? initial() : initial;
                return [
                    states[index],
                    (value: unknown) => {
                        states[index] = value;
                    },
                ];
            },
            useCallback: (fn: unknown) => fn,
            useEffect: () => {},
            createElement: (
                type: string,
                props: Element['props'],
                ...children: unknown[]
            ): Element => ({ type, props, children }),
        };
        const section = loaded
            ?.factory(() => ({}))
            .__manager.ModelManagerSection(react, async () => {});
        const render = () => {
            cursor = 0;
            return section();
        };
        const find = (node: unknown, text: string): Element | undefined => {
            if (!node || typeof node !== 'object') return undefined;
            if (Array.isArray(node)) {
                for (const child of node) {
                    const match = find(child, text);
                    if (match) return match;
                }
                return undefined;
            }
            const element = node as Element;
            if (element.type === 'button' && element.children.includes(text)) return element;
            return find(element.children, text);
        };
        const click = find(render(), '获取模型')?.props.onClick as CallableFunction;
        expect(click).toBeTypeOf('function');
        const job = click();
        click();
        expect(find(render(), '正在获取模型…')?.props.disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(25_001);
        await job;
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(states[16]).toContain('超时');
        expect(states[0]).toBe(saved);
        expect(states[4]).toBe('saved-chat');
        expect(find(render(), '获取模型')?.props.disabled).toBe(false);
        fail = false;
        const retry = find(render(), '获取模型');
        if (!retry) throw new Error('missing retry button');
        await (retry.props.onClick as CallableFunction)();
        expect(states[4]).toBe('new-chat');
        expect(states[0]).toBe(saved);
    });
});

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
    it('renders searchable model pickers and a protocol selector populated by the backend', () => {
        expect(SOURCE).toContain('modelRow(');
        expect(SOURCE).toContain('modelRow(t.vision');
        expect(SOURCE).toContain('maxHeight: 260');
        expect(SOURCE).toContain('placeholder: t.searchModels');
        const pickerSource = SOURCE.slice(
            SOURCE.indexOf('var modelRow'),
            SOURCE.indexOf('{ style: { maxWidth: 760', SOURCE.indexOf('var modelRow')),
        );
        expect(pickerSource).not.toContain("'select'");
        expect(SOURCE).toContain('body: JSON.stringify({');
        expect(SOURCE).toContain('baseURL: baseURL');
        expect(SOURCE).toContain('mainModel: mainModel');
        expect(SOURCE).toContain('api: protocol');
        expect(SOURCE).toContain('visionModel: visionModel');
        expect(SOURCE).toContain('visionMode: draftVisionMode');
        expect(SOURCE).toContain("var basePair = react.useState('')");
        expect(SOURCE).toContain("var protocolPair = react.useState('')");
        expect(SOURCE).toContain("role: 'radiogroup'");
        expect(SOURCE).toContain('selectedModelProtocol(state, value)');
        expect(SOURCE).toContain("protocol: '请求协议'");
        expect(SOURCE).toContain("type: 'url'");
        expect(SOURCE).toContain('endpointRow()');
        expect(SOURCE).toContain("baseURL.trim() !== (state?.baseURL || '')");
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
        expect(settingsLoadSource).toContain('var selection = activeSelectionFromStatus(body)');
        expect(saveModelsSource).toContain('var selection = activeSelectionFromStatus(body)');
        expect(saveModelsSource.indexOf('statePair[1](body)')).toBeLessThan(
            saveModelsSource.indexOf('activeSelectionFromStatus(body)'),
        );
        expect(SOURCE).toContain('t.sessionSwitchFailed');
        expect(SOURCE).toContain("draftVisionMode === 'bridge'");
        expect(SOURCE).toContain('selectedModelVisionMode(state, mainModel)');
        expect(SOURCE).toContain('t.nativeVision');
        expect(SOURCE).toContain('t.bridgeVision');
        expect(SOURCE).toContain('t.directVision');
        expect(SOURCE).toContain("officialEntry: '备用线路'");
        expect(SOURCE).toContain("tokensEntry: 'TokensAPI 配置'");
        expect(SOURCE).toContain("currentRoute: '当前线路'");
        expect(SOURCE).toContain('var officialPanel = officialPanelOpen');
        expect(SOURCE).toContain('routeStatusCard()');
        expect(SOURCE).toContain('body: JSON.stringify(payload)');
        expect(SOURCE).toContain("action: 'discoverFallback'");
        expect(SOURCE).toContain("action: 'configureFallback'");
        expect(SOURCE).toContain("performFallback({ action: 'switchTokensAPI' }");
        expect(SOURCE).toContain('baseURL: fallbackBaseURL');
        expect(SOURCE).toContain('mainModel: fallbackModel');
        expect(SOURCE).toContain('var fallbackModelsPair = react.useState([])');
        expect(SOURCE).toContain('fallbackModelsPair[1](models)');
        expect(SOURCE).toContain('fallbackModels.length > 0');
        expect(SOURCE).toContain('t.officialFetchModels');
        expect(SOURCE).toContain('t.officialModelsHint');
        expect(SOURCE).not.toContain('state.official?.models || []');
    });

    it('clears a stale fallback catalog when its endpoint or key changes', () => {
        const clearStart = SOURCE.indexOf('var clearFallbackModels');
        const discoverStart = SOURCE.indexOf('var discoverFallbackModels');
        const clearSource = SOURCE.slice(clearStart, discoverStart);
        const fallbackPanelStart = SOURCE.indexOf('endpointRow(fallbackBaseURL');
        const fallbackPanelSource = SOURCE.slice(
            fallbackPanelStart,
            SOURCE.indexOf("type: 'submit'", fallbackPanelStart),
        );

        expect(clearSource).toContain('fallbackModelsPair[1]([])');
        expect(clearSource).toContain("fallbackModelPair[1]('')");
        expect(fallbackPanelSource).toContain('fallbackBasePair[1](value)');
        expect(fallbackPanelSource.match(/clearFallbackModels\(\)/g)).toHaveLength(2);
    });

    it('requires an authenticated model discovery result before fallback saving is enabled', () => {
        const discoverStart = SOURCE.indexOf('var discoverFallbackModels');
        const switchStart = SOURCE.indexOf('var switchOfficial');
        const discoverSource = SOURCE.slice(discoverStart, switchStart);
        const switchSource = SOURCE.slice(
            switchStart,
            SOURCE.indexOf('var switchTokens', switchStart),
        );

        expect(discoverSource).toContain("action: 'discoverFallback'");
        expect(discoverSource).toContain('apiKey: officialApiKey');
        expect(discoverSource).toContain('fallbackModelsPair[1](models)');
        expect(discoverSource).toContain('fallbackModelPair[1](models[0].id)');
        expect(switchSource).toContain(
            '!fallbackModels.some((model) => model.id === fallbackModel)',
        );
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
                          selectedModelVisionSource: (
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
                { id: 'kimi-k3', visionMode: 'native' },
                { id: 'direct-text-model', visionMode: 'direct' },
            ],
        };

        expect(manager.selectedModelVisionMode(state, 'gpt-5.5')).toBe('native');
        expect(manager.selectedModelVisionMode(state, 'kimi-k3')).toBe('native');
        expect(manager.selectedModelVisionMode(state, 'deepseek-v4-flash')).toBe('bridge');
        expect(manager.selectedModelVisionMode(state, 'direct-text-model')).toBe('direct');
        expect(manager.selectedModelVisionMode(state, 'new-unclassified-model')).toBe('unknown');
        expect(manager.selectedModelVisionSource(state, 'new-unclassified-model')).toBe('unknown');

        const labels = {
            nativeVision: '对话和图片均由 {mainModel} 原生处理。',
            bridgeVision: '对话由 {mainModel} 处理，图片由 {visionModel} 读取后交给主模型。',
            directVision: '对话由 {mainModel} 处理，当前不能处理图片。',
            unknownVision: '{mainModel} 没有声明图片能力，请先选择图片处理方式再保存。',
        };
        expect(manager.modelRouteDescription(labels, 'native', 'gpt-5.5', 'unused')).toBe(
            '对话和图片均由 gpt-5.5 原生处理。',
        );
        expect(
            manager.modelRouteDescription(labels, 'bridge', 'deepseek-v4-flash', 'qwen3.6-35b-a3b'),
        ).toBe('对话由 deepseek-v4-flash 处理，图片由 qwen3.6-35b-a3b 读取后交给主模型。');
        expect(manager.modelRouteDescription(labels, 'unknown', 'future-model', 'unused')).toBe(
            'future-model 没有声明图片能力，请先选择图片处理方式再保存。',
        );
    });

    it('reveals and copies a saved key only after an explicit user action', () => {
        expect(SOURCE).toContain("type: keyVisible ? 'text' : secretFieldProps().type");
        expect(SOURCE).toContain('keyVisible ? t.hide : t.show');
        expect(SOURCE).toContain('placeholder: state?.configured ? t.maskedKey : t.key');
        expect(SOURCE).toContain("body: JSON.stringify({ action: 'revealApiKey' })");
        expect(SOURCE).toContain('navigator.clipboard.writeText(value)');
        expect(SOURCE).toContain("postManager({ action: 'revealOfficialApiKey' })");
        expect(SOURCE).toContain("type: officialKeyVisible ? 'text' : secretFieldProps().type");
        expect(SOURCE).toContain(
            'placeholder: state.official?.configured ? t.maskedKey : t.officialKey',
        );
        expect(SOURCE).not.toContain('state.apiKey');
        expect(SOURCE).not.toContain('返回浏览器');
    });

    it('puts discovery below the fallback key and the only route action below model settings', () => {
        const panelStart = SOURCE.lastIndexOf('officialPanel && state');
        const panelSource = SOURCE.slice(
            panelStart,
            SOURCE.indexOf('    /**\n     * Present one', panelStart),
        );

        expect(panelSource).toContain('order: 1');
        expect(panelSource).toContain('order: 2');
        const endpointCardStart = panelSource.indexOf('endpointRow(fallbackBaseURL');
        const keyCardStart = panelSource.indexOf("h('strong', null, t.officialKey)");
        const endpointCardSource = panelSource.slice(endpointCardStart, keyCardStart);
        const keyCardSource = panelSource.slice(keyCardStart);

        expect(keyCardSource).toContain('onClick: discoverFallbackModels');
        expect(keyCardSource.indexOf('placeholder: state.official?.configured')).toBeLessThan(
            keyCardSource.indexOf('onClick: discoverFallbackModels'),
        );
        expect(endpointCardSource).toContain('fallbackRouteAction()');
        expect(panelSource).not.toContain("type: 'submit'");
        expect(SOURCE).toContain(
            'var performFallbackRouteAction = returnToTokens ? switchTokens : switchOfficial',
        );
        expect(SOURCE).toContain(
            "var showReturnAction = !officialPanel && routeControl.action === 'switchTokensAPI'",
        );
        expect(SOURCE).toContain("cursor: actionDisabled ? 'not-allowed' : 'pointer'");
        expect(SOURCE).toContain("cursor: busy ? 'wait' : 'pointer'");
        expect(SOURCE).toContain("color: '#fff'");
        expect(SOURCE).toContain("cursor: saveModelsDisabled ? 'not-allowed' : 'pointer'");
        expect(SOURCE).toContain("draftVisionMode === 'unknown'");
        expect(SOURCE).toContain(
            "busy || !apiKey.trim() || (state && state.writable === false) ? 'not-allowed' : 'pointer'",
        );
    });

    it('uses the active fallback selection without overwriting the parked TokensAPI model', () => {
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
        const activeSelection = loaded.factory(() => ({})).__manager.activeSelectionFromStatus as (
            status: Record<string, unknown>,
        ) => {
            model: string;
            provider: string;
        };
        expect(
            activeSelection({
                channel: 'official',
                mainModel: 'gpt-5.5',
                activeMainModel: 'deepseek-chat',
                mainProvider: 'modlens-tokens-fallback',
            }),
        ).toEqual({ model: 'deepseek-chat', provider: 'modlens-tokens-fallback' });
    });

    it('separates route-page navigation from the explicit route switch action', () => {
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
        const control = loaded.factory(() => ({})).__manager.routeControlState as (
            channel: string,
            officialPanel: boolean,
        ) => {
            activeChannel: string;
            pageChannel: string;
            pageActive: boolean;
            action: string;
        };

        expect(control('tokensapi', false)).toEqual({
            activeChannel: 'tokensapi',
            pageChannel: 'tokensapi',
            pageActive: true,
            action: '',
        });
        expect(control('official', false)).toEqual({
            activeChannel: 'official',
            pageChannel: 'tokensapi',
            pageActive: false,
            action: 'switchTokensAPI',
        });
        expect(control('tokensapi', true)).toEqual({
            activeChannel: 'tokensapi',
            pageChannel: 'official',
            pageActive: false,
            action: 'switchOfficial',
        });
        expect(control('official', true)).toEqual({
            activeChannel: 'official',
            pageChannel: 'official',
            pageActive: true,
            action: '',
        });
    });

    it('projects every active-route model without exposing duplicate implementation routes', () => {
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
        const project = loaded.factory(() => ({})).__manager.managedCatalogProjection as (
            snapshot: Record<string, unknown>,
            model: string,
            provider: string,
        ) => {
            groups: Array<{
                id: string;
                name: string;
                models: Array<{ id: string; name: string }>;
            }>;
            failures: Array<{ id: string }>;
        };
        const snapshot = {
            groups: [
                {
                    id: 'deepseek-official',
                    name: 'DeepSeek',
                    models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
                },
                {
                    id: 'modlens-tokensapi',
                    name: 'TokensAPI (modlens vision)',
                    models: [
                        {
                            id: 'deepseek-v4-flash',
                            name: 'deepseek-v4-flash (modlens vision)',
                        },
                        {
                            id: 'deepseek-v3.2',
                            name: 'DeepSeek V3.2 (modlens vision)',
                        },
                        {
                            id: 'gpt-5.5',
                            name: 'GPT-5.5',
                        },
                    ],
                },
                {
                    id: 'tokensapi',
                    name: 'TokensAPI',
                    models: [
                        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
                        { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
                        { id: 'gpt-5.5', name: 'GPT-5.5' },
                    ],
                },
                {
                    id: 'tokens-fallback',
                    name: '备用线路',
                    models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }],
                },
                {
                    id: 'modlens-tokens-fallback',
                    name: '备用线路 (modlens vision)',
                    models: [
                        {
                            id: 'deepseek-v4-pro',
                            name: 'DeepSeek-V4-Pro (modlens vision)',
                        },
                        {
                            id: 'deepseek-chat',
                            name: 'DeepSeek Chat (modlens vision)',
                        },
                    ],
                },
            ],
            failures: [
                { id: 'unrelated', name: 'Unrelated', message: 'offline' },
                { id: 'modlens-tokensapi', name: 'TokensAPI', message: 'refreshing' },
            ],
        };
        expect(project(snapshot, 'deepseek-v4-flash', 'modlens-tokensapi')).toEqual({
            groups: [
                {
                    id: 'modlens-tokensapi',
                    name: 'TokensAPI',
                    models: [
                        {
                            id: 'deepseek-v4-flash',
                            name: 'deepseek-v4-flash',
                        },
                        {
                            id: 'deepseek-v3.2',
                            name: 'DeepSeek V3.2',
                        },
                        {
                            id: 'gpt-5.5',
                            name: 'GPT-5.5',
                        },
                    ],
                },
            ],
            failures: [{ id: 'modlens-tokensapi', name: 'TokensAPI', message: 'refreshing' }],
        });
        expect(project(snapshot, 'gpt-5.5', 'tokensapi').groups).toEqual([
            {
                id: 'modlens-tokensapi',
                name: 'TokensAPI',
                models: [
                    { id: 'gpt-5.5', name: 'GPT-5.5' },
                    { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
                    { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
                ],
            },
        ]);
        expect(project(snapshot, 'deepseek-v4-pro', 'modlens-tokens-fallback').groups).toEqual([
            {
                id: 'modlens-tokens-fallback',
                name: '备用线路',
                models: [
                    {
                        id: 'deepseek-v4-pro',
                        name: 'DeepSeek-V4-Pro',
                    },
                    {
                        id: 'deepseek-chat',
                        name: 'DeepSeek Chat',
                    },
                ],
            },
        ]);
    });

    it('skips the upstream model root only when it has no reasoning choice', () => {
        let loaded:
            | {
                  factory: (require: () => unknown) => {
                      __manager: {
                          onModelSelectClick: (event: {
                              target: { closest: () => unknown };
                          }) => void;
                      };
                  };
              }
            | undefined;
        let rootItems: Array<{ click: () => void }> = [];
        let reasoningItems: unknown[] = [];
        const menu = {
            querySelectorAll: (selector: string) =>
                selector === '[role="menuitemradio"]' ? reasoningItems : rootItems,
        };
        const documentStub = {
            getElementById: (id: string) => (id === 'model-menu' ? menu : null),
        };
        const frames: Array<() => void> = [];
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            {
                __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) },
                requestAnimationFrame: (callback: () => void) => {
                    frames.push(callback);
                    return frames.length;
                },
            },
            documentStub,
            () => Promise.reject(new Error('unused')),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const manager = loaded.factory(() => ({})).__manager;
        const attributes: Record<string, string> = {
            'aria-label': '选择模型，当前 deepseek-v4-flash',
            'aria-expanded': 'true',
            'aria-controls': 'model-menu',
        };
        const trigger = { getAttribute: (name: string) => attributes[name] ?? null };
        const target = { closest: () => trigger };
        const flushFrames = () => {
            while (frames.length > 0) frames.shift()?.();
        };

        let clicks = 0;
        rootItems = [{ click: () => (clicks += 1) }];
        manager.onModelSelectClick({ target });
        flushFrames();
        expect(clicks).toBe(1);

        rootItems = [{ click: () => (clicks += 1) }, { click: () => (clicks += 1) }];
        manager.onModelSelectClick({ target });
        flushFrames();
        expect(clicks).toBe(1);

        rootItems = [{ click: () => (clicks += 1) }];
        reasoningItems = [{}];
        manager.onModelSelectClick({ target });
        flushFrames();
        expect(clicks).toBe(1);
    });

    it('keeps the sticky provider heading opaque over the scrolling model list', () => {
        let loaded:
            | {
                  factory: (require: () => unknown) => {
                      __manager: {
                          installModelMenuStyle: () => () => void;
                          modelMenuStyle: string;
                      };
                  };
              }
            | undefined;
        let previousRemoved = false;
        let styleRemoved = false;
        const style = {
            id: '',
            textContent: '',
            remove: () => {
                styleRemoved = true;
            },
        };
        let appended: typeof style | undefined;
        const documentStub = {
            head: {
                appendChild: (element: typeof style) => {
                    appended = element;
                },
            },
            getElementById: () => ({
                remove: () => {
                    previousRemoved = true;
                },
            }),
            createElement: () => style,
        };
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            documentStub,
            () => Promise.reject(new Error('unused')),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const manager = loaded.factory(() => ({})).__manager;
        const dispose = manager.installModelMenuStyle();

        expect(previousRemoved).toBe(true);
        expect(appended).toBe(style);
        expect(style.id).toBe('tokens-model-manager-menu-style');
        expect(manager.modelMenuStyle).toContain('[aria-label="模型与推理等级"]');
        expect(manager.modelMenuStyle).toContain('[aria-label="Model and reasoning effort"]');
        expect(manager.modelMenuStyle).toContain('Canvas 94%');

        dispose();
        expect(styleRemoved).toBe(true);
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
                mainProvider: 'modlens-tokensapi',
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
                                                id: 'modlens-tokensapi',
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
            { provider: 'modlens-tokensapi', model: 'claude-opus-5' },
            { provider: 'modlens-tokensapi', model: 'claude-opus-5' },
            { provider: 'modlens-tokensapi', model: 'claude-opus-5' },
        ]);
    });

    it('keeps the shared conversation selector projected after catalog reloads', async () => {
        let loaded:
            | {
                  factory: (require: () => unknown) => {
                      __manager: { registerManagerSection: (ctx: Record<string, unknown>) => void };
                  };
              }
            | undefined;
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            async () => ({
                ok: true,
                json: async () => ({
                    provider: 'TokensAPI',
                    authenticated: true,
                    mainModel: 'deepseek-v4-flash',
                    mainProvider: 'modlens-tokensapi',
                }),
            }),
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');

        const rawGroups = [
            {
                id: 'deepseek-official',
                name: 'DeepSeek',
                models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
            },
            {
                id: 'modlens-tokensapi',
                name: 'TokensAPI (modlens vision)',
                models: [
                    {
                        id: 'deepseek-v4-flash',
                        name: 'deepseek-v4-flash (modlens vision)',
                    },
                    {
                        id: 'deepseek-v3.2',
                        name: 'DeepSeek V3.2 (modlens vision)',
                    },
                    {
                        id: 'gpt-5.5',
                        name: 'GPT-5.5',
                    },
                ],
            },
            {
                id: 'tokensapi',
                name: 'TokensAPI',
                models: [
                    { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
                    { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
                    { id: 'gpt-5.5', name: 'GPT-5.5' },
                ],
            },
            {
                id: 'tokens-fallback',
                name: '备用线路',
                models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }],
            },
            {
                id: 'modlens-tokens-fallback',
                name: '备用线路 (modlens vision)',
                models: [
                    {
                        id: 'deepseek-v4-pro',
                        name: 'DeepSeek-V4-Pro (modlens vision)',
                    },
                ],
            },
        ];
        const state = {
            current: null as null | { provider: string; model: string },
            groups: rawGroups.map((group) => ({ ...group, models: [...group.models] })),
            failures: [{ id: 'deepseek-official', name: 'DeepSeek', message: 'offline' }],
        };
        const listeners = new Set<() => void>();
        const store = {
            getSnapshot: () => state,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            update: (mutator: (draft: typeof state) => void) => {
                mutator(state);
                for (const listener of [...listeners]) listener();
            },
        };
        const directory = {
            store,
            load: async () => {
                state.groups = rawGroups.map((group) => ({ ...group, models: [...group.models] }));
                for (const listener of [...listeners]) listener();
                return { groups: rawGroups, failures: [] };
            },
            select: async (selection: { provider: string; model: string }) => {
                state.current = selection;
            },
        };

        loaded
            .factory(() => ({}))
            .__manager.registerManagerSection({
                inject: (_services: string[], callback: (scope: Record<string, unknown>) => void) =>
                    callback({
                        sessions: {
                            list: {
                                getSnapshot: () => ({ current: 'session-projected' }),
                                subscribe: () => () => undefined,
                            },
                            subagentAddress: () => undefined,
                        },
                        modelDirectories: { directoryFor: () => directory },
                        slots: { inject: () => undefined },
                    }),
            });
        for (let index = 0; index < 30; index++) await Promise.resolve();

        expect(state.current).toEqual({
            provider: 'modlens-tokensapi',
            model: 'deepseek-v4-flash',
        });
        expect(state.groups).toEqual([
            {
                id: 'modlens-tokensapi',
                name: 'TokensAPI',
                models: [
                    { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
                    { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
                    { id: 'gpt-5.5', name: 'GPT-5.5' },
                ],
            },
        ]);
        expect(state.failures).toEqual([]);
    });

    it('persists a user conversation-model choice back to the managed settings route', async () => {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __manager: { registerManagerSection: (ctx: Record<string, unknown>) => void };
                  };
              }
            | undefined;
        const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
        const fetchStub = async (url: string, init?: { method?: string; body?: string }) => {
            calls.push({ url, init });
            if (init?.method !== 'POST') {
                return {
                    ok: true,
                    json: async () => ({
                        provider: 'TokensAPI',
                        authenticated: true,
                        mainModel: 'deepseek-v4-flash',
                        activeMainModel: 'deepseek-v4-flash',
                        mainProvider: 'modlens-tokensapi',
                    }),
                };
            }
            return {
                ok: true,
                json: async () => ({
                    provider: 'TokensAPI',
                    authenticated: true,
                    mainModel: 'deepseek-v3.2',
                    activeMainModel: 'deepseek-v3.2',
                    mainProvider: 'modlens-tokensapi',
                }),
            };
        };
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            fetchStub,
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');

        const state = {
            current: null as null | { provider: string; model: string },
            groups: [
                {
                    id: 'modlens-tokensapi',
                    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v3.2' }],
                },
            ],
            failures: [],
        };
        const listeners = new Set<() => void>();
        const store = {
            getSnapshot: () => state,
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            update: (mutator: (draft: typeof state) => void) => {
                mutator(state);
                for (const listener of [...listeners]) listener();
            },
        };
        let directory: {
            store: typeof store;
            load: () => Promise<typeof state>;
            select: (selection: {
                provider: string;
                model: string;
                reasoningEffort?: string;
            }) => Promise<void>;
        };
        directory = {
            store,
            load: async () => state,
            select: async (selection) => {
                state.current = selection;
            },
        };

        loaded
            .factory(() => ({}))
            .__manager.registerManagerSection({
                inject: (_services: string[], callback: (scope: Record<string, unknown>) => void) =>
                    callback({
                        sessions: {
                            list: {
                                getSnapshot: () => ({ current: 'session-user-choice' }),
                                subscribe: () => () => undefined,
                            },
                            subagentAddress: () => undefined,
                        },
                        modelDirectories: { directoryFor: () => directory },
                        slots: { inject: () => undefined },
                    }),
            });
        for (let index = 0; index < 30; index++) await Promise.resolve();

        await directory.select({
            provider: 'modlens-tokensapi',
            model: 'deepseek-v3.2',
            reasoningEffort: 'high',
        });
        expect(JSON.parse(calls.at(-1)?.init?.body || '{}')).toEqual({
            action: 'selectMainModel',
            provider: 'modlens-tokensapi',
            model: 'deepseek-v3.2',
        });
        expect(state.current).toEqual({
            provider: 'modlens-tokensapi',
            model: 'deepseek-v3.2',
            reasoningEffort: 'high',
        });
    });

    it('rolls the conversation selector back when persisting the choice fails', async () => {
        let loaded:
            | {
                  factory: (require: (id: string) => unknown) => {
                      __manager: { registerManagerSection: (ctx: Record<string, unknown>) => void };
                  };
              }
            | undefined;
        let postCalls = 0;
        const fetchStub = async (_url: string, init?: { method?: string; body?: string }) => {
            if (init?.method !== 'POST') {
                return {
                    ok: true,
                    json: async () => ({
                        provider: 'TokensAPI',
                        authenticated: true,
                        mainModel: 'deepseek-v4-flash',
                        activeMainModel: 'deepseek-v4-flash',
                        mainProvider: 'modlens-tokensapi',
                    }),
                };
            }
            postCalls += 1;
            return { ok: false, json: async () => ({ error: 'save failed' }) };
        };
        const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
        run(
            { __ModuleLoader__: { load: (definition: typeof loaded) => (loaded = definition) } },
            {},
            fetchStub,
            class {},
        );
        if (!loaded) throw new Error('client module was not registered');
        const state = {
            current: { provider: 'modlens-tokensapi', model: 'deepseek-v4-flash' },
            groups: [
                {
                    id: 'modlens-tokensapi',
                    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v3.2' }],
                },
            ],
            failures: [],
        };
        const store = {
            getSnapshot: () => state,
            subscribe: () => () => undefined,
            update: (mutator: (draft: typeof state) => void) => mutator(state),
        };
        const selected: Array<{ provider: string; model: string }> = [];
        const directory = {
            store,
            load: async () => state,
            select: async (selection: { provider: string; model: string }) => {
                selected.push(selection);
                state.current = selection;
            },
        };
        loaded
            .factory(() => ({}))
            .__manager.registerManagerSection({
                inject: (_services: string[], callback: (scope: Record<string, unknown>) => void) =>
                    callback({
                        sessions: {
                            list: {
                                getSnapshot: () => ({ current: 'session-rollback' }),
                                subscribe: () => () => undefined,
                            },
                            subagentAddress: () => undefined,
                        },
                        modelDirectories: { directoryFor: () => directory },
                        slots: { inject: () => undefined },
                    }),
            });
        for (let index = 0; index < 30; index++) await Promise.resolve();

        await expect(
            directory.select({ provider: 'modlens-tokensapi', model: 'deepseek-v3.2' }),
        ).rejects.toThrow('save failed');
        expect(postCalls).toBe(1);
        expect(selected).toEqual([
            { provider: 'modlens-tokensapi', model: 'deepseek-v3.2' },
            { provider: 'modlens-tokensapi', model: 'deepseek-v4-flash' },
        ]);
        expect(state.current).toEqual({
            provider: 'modlens-tokensapi',
            model: 'deepseek-v4-flash',
        });
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

    it('selects the unified managed route for a native multimodal main model', async () => {
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
                'modlens-tokensapi',
            ),
        ).resolves.toBe(true);
        expect(selected).toEqual([{ provider: 'modlens-tokensapi', model: 'claude-opus-4-6' }]);
    });

    it('preserves an existing per-session model during startup synchronization', async () => {
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
            retry: undefined,
            respectExisting: boolean,
        ) => Promise<boolean>;
        const selected: Array<{ provider: string; model: string }> = [];

        await expect(
            synchronize(
                {
                    list: { getSnapshot: () => ({ current: 'session-existing' }) },
                    subagentAddress: () => undefined,
                },
                {
                    directoryFor: () => ({
                        store: {
                            getSnapshot: () => ({
                                current: {
                                    provider: 'other-provider',
                                    model: 'user-selected-model',
                                },
                            }),
                        },
                        select: async (selection: { provider: string; model: string }) => {
                            selected.push(selection);
                        },
                    }),
                },
                'deepseek-v4-flash',
                'modlens-tokensapi',
                undefined,
                true,
            ),
        ).resolves.toBe(false);
        expect(selected).toEqual([]);
    });

    it('selects the fallback wrapper without remapping it to TokensAPI', async () => {
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
                    list: { getSnapshot: () => ({ current: 'session-official' }) },
                    subagentAddress: () => undefined,
                },
                {
                    directoryFor: () => ({
                        select: async (selection: { provider: string; model: string }) => {
                            selected.push(selection);
                        },
                    }),
                },
                'deepseek-chat',
                'modlens-tokens-fallback',
            ),
        ).resolves.toBe(true);
        expect(selected).toEqual([{ provider: 'modlens-tokens-fallback', model: 'deepseek-chat' }]);
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
