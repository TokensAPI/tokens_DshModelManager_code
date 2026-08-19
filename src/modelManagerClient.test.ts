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
