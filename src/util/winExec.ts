// Windows cannot spawn what POSIX can. npm/pnpm/yarn install every JS CLI as
// a trio (a bare-named POSIX sh shim, a .cmd, a .ps1); a bare
// `spawn('claude')` finds none of them (ENOENT, read as "not installed"),
// and handing spawn the .cmd directly hits Node's post-CVE-2024-27980
// refusal to run batch files without a shell (EINVAL) — issue #31.
//
// The obvious fix, wrapping the .cmd in `cmd.exe /d /s /c`, is a trap: cmd's
// command line cannot carry a raw CR or LF, and our provider arguments are
// whole multi-line vision prompts, so a wrapped prompt is truncated at its
// first newline (and anything after it read as a second command). So this
// does not go through a shell at all. A cmd shim is just
// `node "<real-entry>.js" %*`; we read the entry out of it and spawn Node
// directly. No shell, no escaping, no CRLF hazard, and the child process is
// Node itself, so the caller's SIGTERM/SIGKILL lands on the real target.
import * as fs from 'fs';
import * as path from 'path';
import { findOnPath } from '../providers/availability.ts';

export interface SpawnPlan {
    command: string;
    args: string[];
}

export interface CmdShimTarget {
    /** Absolute path to the JS entry the shim runs. */
    script: string;
    /** Node flags the shim passes before the script (from its shebang). */
    nodeFlags: string[];
}

/**
 * Read the real JS entry out of an npm/pnpm/yarn cmd shim's text. Their
 * generators (npm's cmd-shim, pnpm's fork, yarn) all emit one execution line
 * of the shape `"%_prog%" [node flags] "%dp0%\entry.js" %*`, where `%dp0%`
 * (or `%~dp0`) is the shim's own directory. Returns null for anything that is
 * not a Node shim (a python shebang, an unrecognized template), so the caller
 * can fall back instead of mis-running it.
 */
export function parseCmdShimTarget(cmdPath: string, content: string): CmdShimTarget | null {
    // Always win32 path semantics: these shims exist only on Windows, and the
    // tests parse Windows paths on POSIX runners.
    const shimDir = path.win32.dirname(cmdPath);
    // The execution line is the one that forwards `%*`; scan every line so the
    // template's exact preamble does not matter.
    for (const line of content.split(/\r?\n/)) {
        if (!line.includes('%*')) {
            continue;
        }
        // Every quoted `%dp0%\...` / `%~dp0\...` token on the line, in order:
        // the interpreter (node.exe) may be one, the script is the last.
        const tokens: string[] = [];
        const tokenRe = /"%~?dp0%?\\([^"]+)"/gi;
        let match: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
        while ((match = tokenRe.exec(line)) !== null) {
            tokens.push(match[1]);
        }
        // Also accept an absolute-path entry (some shims hardcode one).
        const absRe = /"([A-Za-z]:\\[^"]+\.(?:js|cjs|mjs))"/gi;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
        while ((match = absRe.exec(line)) !== null) {
            tokens.push(match[1]);
        }
        // A .js/.cjs/.mjs target is the node signal itself: a python or ruby
        // shim points at a .py/.rb, so it yields no script token and is
        // declined. The interpreter appears as `%_prog%` here, not literal
        // `node`, so matching the entry extension is the reliable test.
        const scriptToken = [...tokens].reverse().find((token) => /\.(js|cjs|mjs)$/i.test(token));
        if (!scriptToken) {
            continue;
        }
        const script = path.win32.isAbsolute(scriptToken)
            ? scriptToken
            : path.win32.join(shimDir, scriptToken);
        // Node flags sit between the interpreter and the script; capture the
        // `--flag` tokens the shebang injected (memory limits and the like).
        const beforeScript = line.slice(0, line.indexOf(scriptToken));
        const nodeFlags = (beforeScript.match(/\s(--?[A-Za-z][^\s"]*)/g) ?? []).map((flag) =>
            flag.trim(),
        );
        return { script, nodeFlags };
    }
    return null;
}

interface ResolveDeps {
    platform: NodeJS.Platform;
    readFileSync: (p: string) => string;
    resolveOnPath: (bin: string, env: NodeJS.ProcessEnv) => string | null;
    execPath: string;
}

const REAL_DEPS: ResolveDeps = {
    platform: process.platform,
    readFileSync: (p) => fs.readFileSync(p, 'utf-8'),
    resolveOnPath: findOnPath,
    execPath: process.execPath,
};

/**
 * Turn a provider invocation into something the current platform can spawn.
 * POSIX passes through untouched. On Windows a bare name resolves through
 * PATH and PATHEXT to the real file; a .cmd/.bat shim is read and rewritten
 * to a direct `node <entry> <args>` spawn. An unresolvable name, or a shim
 * that cannot be parsed, passes through so the caller's own ENOENT/EINVAL
 * handling (the "install it first" message) is the one that fires.
 */
export function resolveSpawnPlan(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    deps: ResolveDeps = REAL_DEPS,
): SpawnPlan {
    if (deps.platform !== 'win32') {
        return { command, args };
    }
    let resolved = command;
    if (!command.includes('/') && !command.includes('\\')) {
        resolved = deps.resolveOnPath(command, env) ?? command;
    }
    if (!/\.(cmd|bat)$/i.test(path.win32.basename(resolved))) {
        return { command: resolved, args };
    }
    let content: string;
    try {
        content = deps.readFileSync(resolved);
    } catch {
        return { command: resolved, args };
    }
    const target = parseCmdShimTarget(resolved, content);
    if (!target) {
        return { command: resolved, args };
    }
    return { command: deps.execPath, args: [...target.nodeFlags, target.script, ...args] };
}
