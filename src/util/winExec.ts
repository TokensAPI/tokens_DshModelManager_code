// Windows cannot spawn what POSIX can. npm installs every CLI three ways
// (a bare-named POSIX sh shim, a .cmd, a .ps1), a bare `spawn('claude')`
// finds none of them (ENOENT, read as "not installed"), and handing spawn
// the .cmd directly hits Node's post-CVE-2024-27980 refusal to run batch
// files without a shell (EINVAL) — issue #31. Availability probing solved
// its half with PATHEXT (#30); this is the same policy for the moment of
// actually running: resolve the real executable, and when it is a batch
// shim, route it through cmd.exe with cross-spawn's escaping, because
// `shell: true` concatenates unescaped arguments and our arguments carry
// whole prompts.
import * as path from 'path';
import { findOnPath } from '../providers/availability.ts';

export interface SpawnPlan {
    command: string;
    args: string[];
    /** Set when args are pre-escaped for cmd.exe and must pass through raw. */
    windowsVerbatimArguments?: boolean;
}

// The cmd.exe metacharacters cross-spawn escapes, space included: a caret
// before each makes cmd read it literally instead of splitting or globbing.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Escape the command path itself for a cmd.exe line (carets only, no quoting). */
export function escapeCmdCommand(command: string): string {
    return command.replace(CMD_META, '^$1');
}

/**
 * Escape one argument for a cmd.exe line, the cross-spawn way: backslashes
 * doubled before quotes and at the end, the whole wrapped in quotes, then
 * every metacharacter caret-escaped so cmd hands it through unchanged.
 */
export function escapeCmdArgument(argument: string): string {
    let escaped = argument.replace(/(\\*)"/g, '$1$1\\"');
    escaped = escaped.replace(/(\\*)$/, '$1$1');
    escaped = `"${escaped}"`;
    return escaped.replace(CMD_META, '^$1');
}

/** The cmd.exe wrapper for one batch shim invocation. */
export function buildCmdShimPlan(
    shimPath: string,
    args: string[],
    env: NodeJS.ProcessEnv,
): SpawnPlan {
    const line = [escapeCmdCommand(shimPath), ...args.map(escapeCmdArgument)].join(' ');
    return {
        command: env.comspec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"${line}"`],
        windowsVerbatimArguments: true,
    };
}

/**
 * Turn a provider invocation into something the current platform can spawn.
 * POSIX passes through untouched. On Windows a bare name resolves through
 * PATH and PATHEXT to the real executable, and a .cmd/.bat target is routed
 * through cmd.exe. An unresolvable name passes through bare, so the caller's
 * ENOENT handling (the "install it first" message) stays the one that fires.
 */
export function resolveSpawnPlan(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
): SpawnPlan {
    if (process.platform !== 'win32') {
        return { command, args };
    }
    let resolved = command;
    if (!command.includes('/') && !command.includes('\\')) {
        resolved = findOnPath(command, env) ?? command;
    }
    if (/\.(cmd|bat)$/i.test(path.basename(resolved))) {
        return buildCmdShimPlan(resolved, args, env);
    }
    return { command: resolved, args };
}
