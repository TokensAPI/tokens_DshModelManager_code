// The CLI assembly (arg parsing, validation branches, exit codes) only exists in
// the built bundle, since main.ts parses argv on import. These tests build once,
// then drive the real binary as a subprocess and assert on exit code and stderr.
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'main.js');

// The bound env vars leak into `config show`; strip them for a clean baseline.
const BOUND_ENV = [
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
];

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of BOUND_ENV) {
        delete env[key];
    }
    return { ...env, ...overrides };
}

function run(args: string[], env: Record<string, string> = {}) {
    // process.execPath, not 'node': tests that empty PATH to starve the
    // provider chain must still be able to launch the CLI itself.
    const res = spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf-8',
        env: baseEnv(env),
    });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeAll(() => {
    // Always rebuild so the assembly under test is the current source, not a
    // stale dist left over from a previous run. shell:true so Windows resolves
    // `pnpm` to `pnpm.cmd` through PATHEXT; execFile alone would only try pnpm.exe.
    execFileSync('pnpm', ['build'], { cwd: root, stdio: 'ignore', shell: true });
}, 120_000);

describe('analyze argument validation', () => {
    it('exits non-zero when the required --input is missing', () => {
        const { code, stderr } = run(['analyze']);
        expect(code).toBe(1);
        expect(stderr).toMatch(/--input/);
    });

    it('rejects a non-numeric --timeout before doing any work', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cli-'));
        const file = path.join(dir, 'x.png');
        fs.writeFileSync(file, Buffer.from('bytes'));
        const { code, stderr } = run(['-i', file, '--timeout', 'abc']);
        expect(code).toBe(1);
        expect(stderr).toMatch(/Invalid --timeout/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('rejects an unsupported provider', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cli-'));
        const file = path.join(dir, 'x.png');
        fs.writeFileSync(file, Buffer.from('bytes'));
        const { code, stderr } = run(['-i', file, '-p', 'bogus-provider']);
        expect(code).toBe(1);
        expect(stderr).toMatch(/Unsupported provider/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('recover-paste argument validation', () => {
    it('rejects a non-positive --count', () => {
        const { code, stderr } = run(['recover-paste', '--count', '0']);
        expect(code).toBe(1);
        expect(stderr).toMatch(/Invalid --count/);
    });
});

describe('top-level wiring', () => {
    it('prints the version and exits 0', () => {
        const { code, stdout } = run(['--version']);
        expect(code).toBe(0);
        expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('starts without loading node:sqlite (no experimental warning on stderr)', () => {
        // Bundling undici used to hoist its lazy require('node:sqlite') into a
        // top-level import, so every CLI start printed an ExperimentalWarning.
        const { stderr } = run(['--version']);
        expect(stderr).not.toContain('ExperimentalWarning');
    });
});

describe('guard', () => {
    function homeWithGuards(guards: object): string {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        fs.mkdirSync(path.join(home, '.modlens'));
        fs.writeFileSync(path.join(home, '.modlens', 'config.json'), JSON.stringify({ guards }));
        return home;
    }

    it('denies a deny-listed model with exit 1 and a machine-readable verdict', () => {
        const home = homeWithGuards({ denyModels: ['gpt-5.6*'] });
        const { code, stdout } = run(['guard'], {
            HOME: home,
            USERPROFILE: home,
            MODLENS_HARNESS: 'none',
            MODLENS_MODEL: 'gpt-5.6-sol',
        });
        expect(code).toBe(1);
        const verdict = JSON.parse(stdout) as Record<string, string>;
        expect(verdict.guard).toBe('deny');
        expect(verdict.matched).toBe('gpt-5.6*');
        expect(verdict.source).toBe('env');
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('allows a model off the list with exit 0', () => {
        const home = homeWithGuards({ denyModels: ['gpt-5.6*'] });
        const { code, stdout } = run(['guard'], {
            HOME: home,
            USERPROFILE: home,
            MODLENS_HARNESS: 'none',
            MODLENS_MODEL: 'deepseek-v4-flash',
        });
        expect(code).toBe(0);
        expect((JSON.parse(stdout) as Record<string, string>).guard).toBe('allow');
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('falls back to the --model self-report when nothing else identifies the model', () => {
        const home = homeWithGuards({ denyModels: ['gemini-3*'] });
        const { code, stdout } = run(['guard', '--model', 'gemini-3.1-pro-high'], {
            HOME: home,
            USERPROFILE: home,
            MODLENS_HARNESS: 'none',
        });
        expect(code).toBe(1);
        expect((JSON.parse(stdout) as Record<string, string>).source).toBe('self-report');
        fs.rmSync(home, { recursive: true, force: true });
    });
});

describe('analyze guard gate', () => {
    function guardedHome(guards: object): { home: string; file: string } {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        fs.mkdirSync(path.join(home, '.modlens'));
        fs.writeFileSync(path.join(home, '.modlens', 'config.json'), JSON.stringify({ guards }));
        const file = path.join(home, 'x.png');
        fs.writeFileSync(file, Buffer.from('bytes'));
        return { home, file };
    }

    it('does not gate on a whitespace-only MODLENS_MODEL (no sniffing inside analyze)', () => {
        const { home, file } = guardedHome({ denyModels: ['gpt-5.6*'] });
        // PATH is emptied so the provider chain fails fast without quota.
        const { stderr } = run(['-i', file], {
            HOME: home,
            USERPROFILE: home,
            MODLENS_HARNESS: 'none',
            MODLENS_MODEL: '   ',
            PATH: '',
        });
        expect(stderr).not.toMatch(/guard/i);
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('lets MODLENS_MODEL=none pass even under denyWhenUnknown (advisory only)', () => {
        const { home, file } = guardedHome({ denyModels: ['gpt-5.6*'], denyWhenUnknown: true });
        const { stderr } = run(['-i', file], {
            HOME: home,
            USERPROFILE: home,
            MODLENS_HARNESS: 'none',
            MODLENS_MODEL: 'none',
            PATH: '',
        });
        expect(stderr).not.toMatch(/guard/i);
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('refuses to spend a provider call when MODLENS_MODEL is deny-listed', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        fs.mkdirSync(path.join(home, '.modlens'));
        fs.writeFileSync(
            path.join(home, '.modlens', 'config.json'),
            JSON.stringify({ guards: { denyModels: ['gpt-5.6*'] } }),
        );
        const file = path.join(home, 'x.png');
        fs.writeFileSync(file, Buffer.from('bytes'));
        const { code, stderr } = run(['-i', file], {
            HOME: home,
            USERPROFILE: home,
            MODLENS_HARNESS: 'none',
            MODLENS_MODEL: 'gpt-5.6-sol',
        });
        expect(code).toBe(1);
        expect(stderr).toMatch(/guard/i);
        expect(stderr).toContain('gpt-5.6*');
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('refuses to spend a provider call when MODLENS_MODEL is off the allowlist', () => {
        const { home, file } = guardedHome({ allowModels: ['deepseek-v4-*'] });
        const { code, stderr } = run(['-i', file], {
            HOME: home,
            USERPROFILE: home,
            MODLENS_HARNESS: 'none',
            MODLENS_MODEL: 'claude-fable-5',
        });
        expect(code).toBe(1);
        expect(stderr).toMatch(/guard/i);
        expect(stderr).toContain('allowModels');
        fs.rmSync(home, { recursive: true, force: true });
    });
});

describe('config show', () => {
    it('prints an empty effective config for a fresh home', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        // HOME for POSIX, USERPROFILE for Windows: os.homedir() reads one or the
        // other, and the config dir hangs off it.
        const { code, stdout } = run(['config', 'show'], { HOME: home, USERPROFILE: home });
        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ providers: {} });
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('merges a bound env var into the effective config, masked and tagged', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-home-'));
        const { code, stdout } = run(['config', 'show'], {
            HOME: home,
            USERPROFILE: home,
            GEMINI_API_KEY: 'AIzaSecretFromEnv12345',
        });
        expect(code).toBe(0);
        const parsed = JSON.parse(stdout) as {
            providers: Record<string, Record<string, string>>;
        };
        expect(parsed.providers['gemini-api'].apiKey).toMatch(/\(env\)$/);
        expect(parsed.providers['gemini-api'].apiKey).not.toContain('SecretFromEnv');
        fs.rmSync(home, { recursive: true, force: true });
    });
});
