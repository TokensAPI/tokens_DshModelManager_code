import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    buildCmdShimPlan,
    escapeCmdArgument,
    escapeCmdCommand,
    resolveSpawnPlan,
} from './winExec.ts';

// The escaping and assembly are pure string work, pinned on every platform;
// only the PATH resolution branch is Windows-gated (covered in
// availability.test.ts via findOnPath on the Windows CI matrix).

describe('escapeCmdArgument', () => {
    it('quotes plain arguments', () => {
        expect(escapeCmdArgument('models')).toBe('^"models^"');
    });

    it('escapes embedded quotes the backslash-doubling way', () => {
        // cross-spawn's algorithm: backslashes before a quote double, the
        // quote itself becomes \", then metacharacters get carets.
        expect(escapeCmdArgument('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    });

    it('doubles trailing backslashes so the closing quote survives', () => {
        expect(escapeCmdArgument('C:\\tmp\\')).toBe('^"C:\\tmp\\\\^"');
    });

    it('caret-escapes cmd metacharacters inside prompts', () => {
        const escaped = escapeCmdArgument('a & b | c > d');
        expect(escaped).toContain('^&');
        expect(escaped).toContain('^|');
        expect(escaped).toContain('^>');
    });
});

describe('escapeCmdCommand', () => {
    it('caret-escapes spaces and metacharacters in the shim path', () => {
        expect(escapeCmdCommand('C:\\Program Files\\claude.cmd')).toBe(
            'C:\\Program^ Files\\claude.cmd',
        );
    });
});

describe('buildCmdShimPlan', () => {
    it('routes through comspec with /d /s /c and verbatim arguments', () => {
        const plan = buildCmdShimPlan(
            'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd',
            ['-p', 'read the image'],
            { comspec: 'C:\\WINDOWS\\system32\\cmd.exe' },
        );
        expect(plan.command).toBe('C:\\WINDOWS\\system32\\cmd.exe');
        expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
        expect(plan.args[3]).toContain('claude.cmd');
        expect(plan.args[3]).toContain('^"read^ the^ image^"');
        expect(plan.windowsVerbatimArguments).toBe(true);
    });

    it('falls back to cmd.exe when comspec is unset', () => {
        expect(buildCmdShimPlan('x.cmd', [], {}).command).toBe('cmd.exe');
    });
});

describe('resolveSpawnPlan', () => {
    it.skipIf(process.platform === 'win32')('passes through untouched off Windows', () => {
        const plan = resolveSpawnPlan('claude', ['-p', 'hello'], { PATH: '/usr/bin' });
        expect(plan).toEqual({ command: 'claude', args: ['-p', 'hello'] });
    });

    it.skipIf(process.platform !== 'win32')(
        'resolves a bare name to its .cmd and wraps it (#31)',
        () => {
            // The PATH fixture mirrors an npm global dir: POSIX shim, .cmd,
            // .ps1 side by side. The .cmd must win and route through cmd.exe.
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-winexec-'));
            for (const name of ['claude', 'claude.cmd', 'claude.ps1']) {
                fs.writeFileSync(path.join(dir, name), '@echo off\n');
            }
            try {
                const plan = resolveSpawnPlan('claude', ['-p', 'x'], {
                    PATH: dir,
                    PATHEXT: '.COM;.EXE;.BAT;.CMD',
                    comspec: 'cmd.exe',
                });
                expect(plan.command).toBe('cmd.exe');
                expect(plan.args[3]).toContain('claude.cmd');
                expect(plan.windowsVerbatimArguments).toBe(true);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
    );
});
