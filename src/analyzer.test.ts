import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeImage, resolveInput, runCommand } from './analyzer.ts';

const onWindows = process.platform === 'win32';

describe('resolveInput', () => {
    it('resolves local paths to absolute paths', () => {
        const resolved = resolveInput('some/dir/img.png');
        expect(resolved.kind).toBe('local');
        expect(path.isAbsolute(resolved.source)).toBe(true);
        expect(resolved.source.endsWith(path.join('some', 'dir', 'img.png'))).toBe(true);
    });

    it('keeps https URLs as remote sources', () => {
        const resolved = resolveInput('https://example.com/demo.png');
        expect(resolved).toEqual({ source: 'https://example.com/demo.png', kind: 'remote' });
    });

    it('unwraps file:// URLs into local paths', () => {
        const filePath = path.join(os.tmpdir(), 'shot.png');
        const resolved = resolveInput(pathToFileURL(filePath).href);
        expect(resolved).toEqual({ source: path.resolve(filePath), kind: 'local' });
    });

    it('decodes escaped characters in file:// URLs', () => {
        const filePath = path.join(os.tmpdir(), 'modlens shot #1.png');
        const resolved = resolveInput(pathToFileURL(filePath).href);
        expect(resolved).toEqual({ source: path.resolve(filePath), kind: 'local' });
    });

    it('rejects empty input', () => {
        expect(() => resolveInput('  ')).toThrow('Input path is required.');
    });
});

// These exercise real subprocess lifecycle (pipe draining, SIGTERM/SIGKILL) with
// `#!/bin/sh` fake providers, which a POSIX shell has to run. Windows has no
// equivalent for `trap '' TERM` or a backgrounded `sleep`, so the suite is scoped
// to POSIX; the CLI's argument wiring is covered cross-platform in main.test.ts.
describe.skipIf(onWindows)('provider subprocess handling', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) {
            cleanups.pop()?.();
        }
    });

    /** Fake provider binary plus a throwaway image to analyze. */
    function fakeProvider(script: string) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-proc-'));
        const bin = path.join(dir, 'fake-agy');
        fs.writeFileSync(bin, script, { mode: 0o755 });
        const image = path.join(dir, 'image.png');
        fs.writeFileSync(image, 'not-a-real-png');
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        return { bin, image };
    }

    // A full instance of the contract: analyzeImage now verifies the shape of
    // every provider result, so a partial structured_output would be rejected.
    const VALID_RESULT = {
        summary: 'ok',
        ocr: { full_text: '', lines: [] },
        layout: { regions: [] },
        semantics: { scene: '', entities: [] },
        visual: {},
        uncertainty: [],
    };
    const SUCCESS_ENVELOPE = JSON.stringify({
        status: 'SUCCESS',
        structured_output: VALID_RESULT,
    });

    it('returns as soon as the provider exits, even when a descendant holds the stdout pipe open', async () => {
        // agy leaves a language server running that inherited the pipe, so the
        // child's 'close' event never fires and the run used to hang until the
        // timeout killed it (issue #1).
        const { bin, image } = fakeProvider(
            `#!/bin/sh\necho '${SUCCESS_ENVELOPE}'\nsleep 30 &\nexit 0\n`,
        );

        const startedAt = Date.now();
        const result = await analyzeImage({
            input: image,
            providerBin: bin,
            timeoutMs: 20_000,
            config: {},
        });

        expect((result.result as { summary: string }).summary).toBe('ok');
        expect(Date.now() - startedAt).toBeLessThan(10_000);
    }, 30_000);

    it('still reports a non-zero exit with its stderr', async () => {
        const { bin, image } = fakeProvider('#!/bin/sh\necho "boom" >&2\nsleep 30 &\nexit 3\n');

        await expect(
            analyzeImage({ input: image, providerBin: bin, timeoutMs: 20_000, config: {} }),
        ).rejects.toThrow(/failed with code 3.*boom/s);
    }, 30_000);

    it('rejects a provider result that is missing schema fields', async () => {
        // The provider succeeded and returned JSON, but it is only half the
        // contract. Every provider goes through the same shape check now.
        const partial = JSON.stringify({
            status: 'SUCCESS',
            structured_output: { summary: 'ok' },
        });
        const { bin, image } = fakeProvider(`#!/bin/sh\necho '${partial}'\nexit 0\n`);

        await expect(
            analyzeImage({ input: image, providerBin: bin, timeoutMs: 20_000, config: {} }),
        ).rejects.toThrow(
            /antigravity-cli returned a result that does not match the vision schema/,
        );
    }, 30_000);

    it('runs a subprocess provider in an isolated workdir holding only the image', async () => {
        // An injection in the image should not be able to read siblings of the
        // original file, so the agent runs in a throwaway dir of one image.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-iso-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const image = path.join(dir, 'shot.png');
        fs.writeFileSync(image, 'not-a-real-png');
        fs.writeFileSync(path.join(dir, 'secret.txt'), 'do not read me');
        const record = path.join(dir, 'record.txt');
        const bin = path.join(dir, 'fake-agy');
        // Record the cwd and its listing, then emit a valid envelope.
        fs.writeFileSync(
            bin,
            `#!/bin/sh\npwd > "${record}"\nls >> "${record}"\necho '${SUCCESS_ENVELOPE}'\n`,
            { mode: 0o755 },
        );

        await analyzeImage({ input: image, providerBin: bin, timeoutMs: 20_000, config: {} });

        const recorded = fs.readFileSync(record, 'utf-8');
        const cwd = recorded.trim().split('\n')[0];
        expect(cwd).not.toBe(dir); // not the original directory
        expect(recorded).toContain('shot.png'); // the image came along
        expect(recorded).not.toContain('secret.txt'); // the sibling did not
        expect(fs.existsSync(cwd)).toBe(false); // cleaned up after the run
    }, 30_000);

    it('hands the provider a real copy, so writing the temp image never mutates the original', async () => {
        // The isolated image used to be a hardlink sharing the original's
        // inode, so a provider writing "its" temp file rewrote the user's file.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-mut-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const image = path.join(dir, 'shot.png');
        fs.writeFileSync(image, 'original-bytes');
        const bin = path.join(dir, 'fake-agy');
        // Overwrite every file in the cwd (the isolated copy), then answer.
        fs.writeFileSync(
            bin,
            `#!/bin/sh\nfor f in *; do echo MUTATED > "$f"; done\necho '${SUCCESS_ENVELOPE}'\n`,
            { mode: 0o755 },
        );

        await analyzeImage({ input: image, providerBin: bin, timeoutMs: 20_000, config: {} });

        expect(fs.readFileSync(image, 'utf-8')).toBe('original-bytes');
    }, 30_000);

    it('runs a remote image in an empty throwaway cwd, not the caller directory', async () => {
        // A remote image has no local file to isolate, but the agent must still
        // not inherit the caller's directory, which it used to fall back to.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-rem-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const record = path.join(dir, 'record.txt');
        const bin = path.join(dir, 'fake-agy');
        fs.writeFileSync(
            bin,
            `#!/bin/sh\npwd > "${record}"\nls -A >> "${record}"\necho '${SUCCESS_ENVELOPE}'\n`,
            { mode: 0o755 },
        );

        await analyzeImage({
            input: 'https://example.com/shot.png',
            providerBin: bin,
            timeoutMs: 20_000,
            config: {},
        });

        const recorded = fs.readFileSync(record, 'utf-8').trim();
        const lines = recorded.split('\n');
        const cwd = lines[0];
        expect(cwd).not.toBe(process.cwd()); // never the caller's directory
        expect(lines).toHaveLength(1); // ls -A printed nothing: the cwd is empty
        expect(fs.existsSync(cwd)).toBe(false); // cleaned up after the run
    }, 30_000);

    it('reports a timeout when the provider never exits', async () => {
        // Straight at runCommand: analyzeImage adds a 30s kill backstop on top
        // of the caller's timeout, which would make this test crawl.
        const { bin } = fakeProvider('#!/bin/sh\nsleep 30\n');

        await expect(
            runCommand('fake', { command: bin, args: [], cwd: os.tmpdir() }, 1_000),
        ).rejects.toThrow(/timed out after 1000 ms/);
    }, 20_000);

    it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
        // The real failure mode: a process that traps SIGTERM. child.killed goes
        // true the instant SIGTERM is delivered, so the old !child.killed guard
        // never fired SIGKILL and this process would outlive the timeout.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-kill-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const bin = path.join(dir, 'stubborn');
        const pidFile = path.join(dir, 'pid');
        // trap '' TERM ignores SIGTERM outright; only SIGKILL can end this.
        fs.writeFileSync(
            bin,
            `#!/bin/sh\ntrap '' TERM\necho $$ > "$1"\nwhile true; do sleep 1; done\n`,
            { mode: 0o755 },
        );

        await expect(
            runCommand('fake', { command: bin, args: [pidFile], cwd: dir }, 500),
        ).rejects.toThrow(/timed out after 500 ms/);

        const pid = await waitFor(() => {
            const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf-8').trim() : '';
            return raw ? Number(raw) : null;
        });
        // The caller already has its timeout error; the process itself must still
        // be gone, killed by the SIGKILL backstop rather than left running.
        await waitFor(() => (isAlive(pid) ? null : true));
        expect(isAlive(pid)).toBe(false);
    }, 15_000);
});

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 8_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = probe();
        if (value !== null && value !== undefined && value !== false) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('waitFor timed out');
}

// Failover drives real subprocess fakes for agy plus a stubbed fetch for the
// inline providers, so the scenarios run offline and POSIX-only.
describe.skipIf(onWindows)('provider failover', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        while (cleanups.length > 0) {
            cleanups.pop()?.();
        }
    });

    const CONTRACT_RESULT = {
        summary: 'ok',
        ocr: { full_text: '', lines: [] },
        layout: { regions: [] },
        semantics: { scene: '', entities: [] },
        visual: {},
        uncertainty: [],
    };

    /** A directory on PATH holding a fake agy with the given script, plus an image. */
    function fakeAgyDir(script: string) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-fo-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        fs.writeFileSync(path.join(dir, 'agy'), script, { mode: 0o755 });
        const image = path.join(dir, 'shot.png');
        fs.writeFileSync(image, 'not-a-real-png');
        return { dir, image };
    }

    const geminiOk = () =>
        new Response(
            JSON.stringify({
                candidates: [{ content: { parts: [{ text: JSON.stringify(CONTRACT_RESULT) }] } }],
                usageMetadata: { totalTokenCount: 9 },
            }),
            { status: 200 },
        );

    const GEMINI_KEYED = { providers: { 'gemini-api': { apiKey: 'g-key' } } };

    it('fails over from a broken agy to gemini-api and records both attempts', async () => {
        const { dir, image } = fakeAgyDir('#!/bin/sh\necho "agy exploded" >&2\nexit 1\n');
        vi.stubEnv('PATH', dir);
        vi.stubGlobal('fetch', async () => geminiOk());

        const result = await analyzeImage({
            input: image,
            config: GEMINI_KEYED,
            timeoutMs: 20_000,
        });

        expect(result.provider).toBe('gemini-api');
        expect(result.meta.attempts).toHaveLength(2);
        expect(result.meta.attempts[0]).toMatchObject({ provider: 'antigravity-cli', ok: false });
        expect(result.meta.attempts[1]).toMatchObject({ provider: 'gemini-api', ok: true });
        expect(result.meta.warnings.join(' ')).toContain('Failed over to gemini-api');
    }, 30_000);

    it('a schema-violating result also fails over, with the violation in the attempt', async () => {
        const partial = JSON.stringify({ status: 'SUCCESS', structured_output: { summary: 'x' } });
        const { dir, image } = fakeAgyDir(`#!/bin/sh\necho '${partial}'\nexit 0\n`);
        vi.stubEnv('PATH', dir);
        vi.stubGlobal('fetch', async () => geminiOk());

        const result = await analyzeImage({
            input: image,
            config: GEMINI_KEYED,
            timeoutMs: 20_000,
        });

        expect(result.provider).toBe('gemini-api');
        expect(result.meta.attempts[0].error).toMatch(/does not match the vision schema/);
    }, 30_000);

    it('an explicit -p pins the provider: original error, no fallback', async () => {
        const { dir, image } = fakeAgyDir('#!/bin/sh\necho "agy exploded" >&2\nexit 1\n');
        vi.stubEnv('PATH', dir);
        vi.stubGlobal('fetch', async () => geminiOk());

        let thrown: Error | null = null;
        try {
            await analyzeImage({
                input: image,
                provider: 'antigravity-cli',
                config: GEMINI_KEYED,
                timeoutMs: 20_000,
            });
        } catch (error) {
            thrown = error as Error;
        }
        expect(thrown).not.toBeNull();
        expect(thrown?.message).not.toContain('Every configured vision provider failed');
        expect(thrown?.message).toMatch(/agy|antigravity-cli/);
    }, 30_000);

    it('aggregates every failure when the whole chain is exhausted', async () => {
        const { dir, image } = fakeAgyDir('#!/bin/sh\necho "agy exploded" >&2\nexit 1\n');
        vi.stubEnv('PATH', dir);
        vi.stubGlobal('fetch', async () => new Response('quota exceeded', { status: 429 }));

        await expect(
            analyzeImage({ input: image, config: GEMINI_KEYED, timeoutMs: 20_000 }),
        ).rejects.toThrow(/Every configured vision provider failed.*antigravity-cli.*gemini-api/s);
    }, 30_000);

    it('sends extraBody from config, and --extra-body replaces it for the run', async () => {
        const { dir, image } = fakeAgyDir('#!/bin/sh\nexit 1\n');
        vi.stubEnv('PATH', dir);
        const bodies: string[] = [];
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            bodies.push(String(init.body));
            return geminiOk();
        });

        const config = {
            providers: {
                'gemini-api': {
                    apiKey: 'g-key',
                    extraBody: { generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } },
                },
            },
        };

        await analyzeImage({ input: image, provider: 'gemini-api', config, timeoutMs: 20_000 });
        expect(JSON.parse(bodies[0]).generationConfig.thinkingConfig).toEqual({
            thinkingLevel: 'LOW',
        });

        await analyzeImage({
            input: image,
            provider: 'gemini-api',
            config,
            extraBody: { generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } },
            timeoutMs: 20_000,
        });
        expect(JSON.parse(bodies[1]).generationConfig.thinkingConfig).toEqual({
            thinkingLevel: 'HIGH',
        });
    }, 30_000);

    it('warns instead of pretending when a CLI provider gets an extraBody', async () => {
        const payload = JSON.stringify({ status: 'SUCCESS', structured_output: CONTRACT_RESULT });
        const { dir, image } = fakeAgyDir(`#!/bin/sh\necho '${payload}'\nexit 0\n`);
        vi.stubEnv('PATH', dir);

        const result = await analyzeImage({
            input: image,
            provider: 'antigravity-cli',
            extraBody: { thinking: { type: 'disabled' } },
            config: {},
            timeoutMs: 20_000,
        });

        expect(result.meta.warnings.join(' ')).toContain('extraBody was ignored');
    }, 30_000);

    it('reports how to set up when nothing is configured at all', async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-none-'));
        cleanups.push(() => fs.rmSync(empty, { recursive: true, force: true }));
        const image = path.join(empty, 'shot.png');
        fs.writeFileSync(image, 'not-a-real-png');
        vi.stubEnv('PATH', empty);

        await expect(analyzeImage({ input: image, config: {}, timeoutMs: 5_000 })).rejects.toThrow(
            /No vision provider is set up/,
        );
    }, 20_000);
});
