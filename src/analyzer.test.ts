import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeImage, chooseProviderName, resolveInput, runCommand } from './analyzer.ts';

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
        const resolved = resolveInput('file:///tmp/shot.png');
        expect(resolved).toEqual({ source: path.resolve('/tmp/shot.png'), kind: 'local' });
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

describe('chooseProviderName', () => {
    const keyedConfig = { providers: { 'gemini-api': { apiKey: 'g-key' } } };
    const noEnv = {} as NodeJS.ProcessEnv;

    it('routes a remote URL to gemini-api when a key is configured and no -p was given', () => {
        expect(chooseProviderName(undefined, keyedConfig, 'remote', noEnv)).toBe('gemini-api');
    });

    it('keeps the agent default for a remote URL when no gemini key exists', () => {
        expect(chooseProviderName(undefined, {}, 'remote', noEnv)).toBe('antigravity-cli');
    });

    it('always honors an explicit -p, key or not', () => {
        expect(chooseProviderName('antigravity-cli', keyedConfig, 'remote', noEnv)).toBe(
            'antigravity-cli',
        );
    });

    it('never reroutes a local image', () => {
        expect(chooseProviderName(undefined, keyedConfig, 'local', noEnv)).toBe('antigravity-cli');
    });

    it('leaves a non-agent default alone for remote URLs', () => {
        const geminiDefault = { ...keyedConfig, provider: 'gemini-api' };
        expect(chooseProviderName(undefined, geminiDefault, 'remote', noEnv)).toBe('gemini-api');
    });

    it('a GEMINI_API_KEY in the environment triggers the reroute too', () => {
        const env = { GEMINI_API_KEY: 'g-env' } as NodeJS.ProcessEnv;
        expect(chooseProviderName(undefined, {}, 'remote', env)).toBe('gemini-api');
    });
});
