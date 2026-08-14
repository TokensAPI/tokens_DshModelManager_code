import { describe, expect, it } from 'vitest';
import { parseCmdShimTarget, resolveSpawnPlan } from './winExec.ts';

// Real cmd-shim output (npm's generator), captured verbatim. The whole point
// is to read the JS entry out of it and spawn node directly, never through
// cmd.exe — so a multi-line vision prompt cannot be truncated or injected.
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*`;

// A shim carrying node flags from a `#!/usr/bin/env node --max-old-space-size=4096` shebang.
const NPM_SHIM_WITH_FLAGS = `@ECHO off
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  --max-old-space-size=4096 "%dp0%\\cli.js" %*`;

// A python shim: not ours, must be declined so the caller falls back.
const PYTHON_SHIM = `@ECHO off
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\tool.py" %*`;

describe('parseCmdShimTarget', () => {
    it('reads the real JS entry, resolved against the shim directory', () => {
        const target = parseCmdShimTarget(
            'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd',
            NPM_SHIM,
        );
        expect(target).not.toBeNull();
        expect(target?.script).toBe(
            'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
        );
        expect(target?.nodeFlags).toEqual([]);
    });

    it('captures node flags the shebang injected', () => {
        const target = parseCmdShimTarget('C:\\npm\\claude.cmd', NPM_SHIM_WITH_FLAGS);
        expect(target?.nodeFlags).toEqual(['--max-old-space-size=4096']);
        expect(target?.script).toBe('C:\\npm\\cli.js');
    });

    it('declines a shim whose interpreter is not node', () => {
        expect(parseCmdShimTarget('C:\\npm\\tool.cmd', PYTHON_SHIM)).toBeNull();
    });

    it('declines content with no forwarded arguments', () => {
        expect(parseCmdShimTarget('C:\\npm\\x.cmd', '@echo off\nnode cli.js')).toBeNull();
    });
});

describe('resolveSpawnPlan', () => {
    it('passes through untouched off Windows', () => {
        const plan = resolveSpawnPlan('claude', ['-p', 'hello'], { PATH: '/usr/bin' });
        expect(plan).toEqual({ command: 'claude', args: ['-p', 'hello'] });
    });

    // The Windows branch is driven with injected deps so it runs on every
    // platform: a real spawn is not needed to prove the plan is correct.
    const winDeps = (files: Record<string, string>, onPath: Record<string, string>) => ({
        platform: 'win32' as NodeJS.Platform,
        readFileSync: (p: string) => {
            const found = files[p];
            if (found === undefined) throw new Error(`ENOENT ${p}`);
            return found;
        },
        resolveOnPath: (bin: string) => onPath[bin] ?? null,
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
    });

    it('rewrites a bare-name .cmd shim to a direct node spawn with the multi-line prompt intact', () => {
        const shimPath = 'C:\\npm\\claude.cmd';
        const prompt = 'line one\nline two & echo not-a-command';
        const plan = resolveSpawnPlan(
            'claude',
            ['-p', prompt],
            { PATH: 'C:\\npm' },
            winDeps({ [shimPath]: NPM_SHIM }, { claude: shimPath }),
        );
        expect(plan.command).toBe('C:\\Program Files\\nodejs\\node.exe');
        expect(plan.args[0]).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
        // The prompt rides as a normal argv element: newlines and & survive,
        // because no cmd.exe parses this line.
        expect(plan.args).toContain(prompt);
        expect(plan.args[plan.args.length - 1]).toBe(prompt);
    });

    it('rewrites an absolute --provider-bin .cmd path too', () => {
        const shimPath = 'C:\\tools\\claude.CMD';
        const plan = resolveSpawnPlan(
            shimPath,
            ['-p', 'x'],
            {},
            winDeps({ [shimPath]: NPM_SHIM }, {}),
        );
        expect(plan.command).toBe('C:\\Program Files\\nodejs\\node.exe');
        expect(plan.args[0]).toContain('cli.js');
    });

    it('passes an unresolvable bare name through so ENOENT still names the CLI', () => {
        const plan = resolveSpawnPlan('missing-cli', ['x'], {}, winDeps({}, {}));
        expect(plan).toEqual({ command: 'missing-cli', args: ['x'] });
    });

    it('passes an .exe straight through', () => {
        const exe = 'C:\\tools\\agy.exe';
        const plan = resolveSpawnPlan(exe, ['-i', 'a.png'], {}, winDeps({}, {}));
        expect(plan).toEqual({ command: exe, args: ['-i', 'a.png'] });
    });

    it('falls back to the raw .cmd when the shim cannot be parsed', () => {
        const shimPath = 'C:\\npm\\weird.cmd';
        const plan = resolveSpawnPlan(
            'weird',
            ['x'],
            {},
            winDeps({ [shimPath]: '@echo off\nsomething unrecognized' }, { weird: shimPath }),
        );
        expect(plan).toEqual({ command: shimPath, args: ['x'] });
    });
});
