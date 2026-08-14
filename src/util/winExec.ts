// Windows cannot spawn what POSIX can. npm/pnpm/yarn install every JS CLI as
// a trio (a bare-named POSIX sh shim, a .cmd, a .ps1); a bare
// `spawn('claude')` finds none of them (ENOENT, read as "not installed"),
// and handing spawn the .cmd directly hits Node's post-CVE-2024-27980
// refusal to run batch files without a shell (EINVAL) — issue #31.
//
// The obvious fix, wrapping the .cmd in `cmd.exe /d /s /c`, is a trap: cmd's
// command line cannot carry a raw CR or LF, and our provider arguments are
// whole multi-line vision prompts, so a wrapped prompt is truncated at its
// first newline and anything after it is read as a second command. So this
// does not go through a shell at all. A cmd shim's execution line is just
// `<interpreter> [flags] "<entry>" %*`; when the interpreter is Node, the
// entry is read out and Node is spawned on it directly. No shell, no
// escaping, no CRLF hazard, and the child is Node itself, so the caller's
// SIGTERM/SIGKILL lands on the real target.
//
// The parse is deliberately strict about two things, because guessing either
// one runs the user's program wrong: the interpreter is read from the shim
// (never inferred from the entry's extension — cmd-shim happily generates a
// python shim for a file named `.js`), and a shim carrying environment or
// runtime semantics this plan cannot reproduce is declined rather than run
// with those semantics silently dropped.
import * as fs from 'fs';
import * as path from 'path';
import { findOnPath } from '../providers/availability.ts';

export interface SpawnPlan {
    command: string;
    args: string[];
}

export interface CmdShimTarget {
    /**
     * Everything the shim hands Node ahead of the forwarded user arguments,
     * in order, with cmd's own variables expanded. No token is classified as
     * flag, entry, or program argument: reproducing the sequence is what
     * makes the spawn faithful, and every attempt to assign roles had a
     * counterexample a real generator could produce.
     */
    args: string[];
    /** An explicit Node binary the shim pins, when it names an absolute one. */
    nodeExec?: string;
}

interface CmdToken {
    /** The token's text, outer quotes removed. */
    value: string;
    /** Whether cmd saw it inside double quotes, where control characters are literal. */
    quoted: boolean;
}

/**
 * Split one cmd line into quoted and bare tokens, outer quotes stripped but
 * remembered: inside quotes cmd treats `&`, `|`, `<`, `>` and `^` as ordinary
 * characters, and a real generator quotes any path that contains one. The
 * optional `@` is batch's echo-off prefix, which pnpm puts directly against
 * the opening quote of a pinned interpreter path.
 */
function tokenizeCmdLine(line: string): CmdToken[] {
    const tokens: CmdToken[] = [];
    const re = /@?"([^"]*)"|(\S+)/g;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
    while ((match = re.exec(line)) !== null) {
        tokens.push(
            match[1] !== undefined
                ? { value: match[1], quoted: true }
                : { value: match[2], quoted: false },
        );
    }
    // The echo-off prefix also appears against an unquoted command
    // (`@node "..." %*`), where it is part of the first token's text.
    const first = tokens[0];
    if (first && !first.quoted && first.value.startsWith('@')) {
        first.value = first.value.slice(1);
    }
    return tokens;
}

/** Expand the shim-directory placeholders cmd shims use for their own paths. */
function expandShimPath(token: string, shimDir: string): string | null {
    const relative = /^%~?dp0%?\\?(.*)$/i.exec(token);
    if (relative) {
        return path.win32.join(shimDir, relative[1]);
    }
    if (path.win32.isAbsolute(token)) {
        return token;
    }
    return null;
}

/**
 * cmd syntax whose effect a plain argv element cannot carry, wherever it
 * appears: a quote inside the token (cmd's own grouping, which the OS argv
 * would not contain) and batch's positional parameters, which cmd would
 * substitute from the caller's own arguments.
 */
const CMD_SYNTAX = /"|%~?\d/;

/**
 * The same, for a token cmd did NOT see inside quotes: a caret escapes the
 * next character, and `&`, `|`, `<`, `>` end the command and start a
 * conjunction, a pipe, or a redirection, so their text never reaches the
 * program as an argument. Inside quotes all of these are ordinary
 * characters, which is how a real generator writes a path holding one.
 */
const CMD_CONTROL = /[\^&|<>]/;

/**
 * Turn one shim token into the literal string cmd would pass, or null when
 * that cannot be proven. The only substitution performed is cmd's own
 * shim-directory variable, in both spellings, matched with its closing
 * delimiter so a different variable that merely starts with `dp0` is left
 * whole (and then declined below). A surviving `%VAR%` is one cmd would
 * expand from the environment, which a direct spawn cannot.
 */
function literalToken(token: CmdToken, shimDir: string): string | null {
    const text = token.value;
    if (CMD_SYNTAX.test(text) || (!token.quoted && CMD_CONTROL.test(text))) {
        return null;
    }
    const substituted = text.replace(/%dp0%|%~dp0/gi, `${shimDir}\\`);
    if (substituted.includes('%')) {
        return null;
    }
    // A token that IS a path gets normalized for legibility; `..` inside an
    // embedded one resolves at the filesystem either way.
    return /^(%dp0%|%~dp0)/i.test(text) ? path.win32.normalize(substituted) : substituted;
}

/** Whether a resolved interpreter token is Node. */
function isNodeInterpreter(token: string): boolean {
    return /^node(\.exe)?$/i.test(path.win32.basename(token));
}

/**
 * Environment assignments a shim may carry that this plan cannot reproduce.
 * `dp0` and `_prog` are the template's own bookkeeping, and the PATHEXT tweak
 * only steers the shim's own `node` lookup, so both are harmless. Anything
 * else (pnpm's NODE_PATH and prepended PATH, cmd-shim's `env KEY=value`
 * shebang form) changes how the program runs.
 */
function carriesForeignEnv(content: string): boolean {
    const setRe = /^\s*@?SET\s+"?([A-Za-z_][A-Za-z0-9_]*)=/gim;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
    while ((match = setRe.exec(content)) !== null) {
        const name = match[1].toLowerCase();
        if (name !== 'dp0' && name !== '_prog' && name !== 'pathext') {
            return true;
        }
    }
    return false;
}

/**
 * Resolve the `%_prog%` indirection npm's template uses: it assigns the
 * interpreter to `_prog` in both branches of an `IF EXIST` before running it.
 * Every assignment must agree that the interpreter is Node.
 */
function progIsNode(content: string, shimDir: string): { ok: boolean; absolute?: string } {
    const progRe = /^\s*@?SET\s+"?_prog=([^"\r\n]*)"?/gim;
    const values: string[] = [];
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
    while ((match = progRe.exec(content)) !== null) {
        values.push(match[1].trim());
    }
    if (values.length === 0) {
        return { ok: false };
    }
    let absolute: string | undefined;
    for (const value of values) {
        const expanded = expandShimPath(value, shimDir) ?? value;
        if (!isNodeInterpreter(expanded)) {
            return { ok: false };
        }
        // A pinned interpreter outside the shim directory (pnpm's
        // nodeExecPath) is a real runtime choice worth honouring.
        if (path.win32.isAbsolute(value)) {
            absolute = value;
        }
    }
    return { ok: true, ...(absolute ? { absolute } : {}) };
}

/**
 * Read the real entry out of an npm/pnpm/yarn cmd shim's text. Their
 * generators all emit one execution line of the shape
 * `<interpreter> [flags] "<entry>" %*`, with the interpreter either inline
 * or behind `%_prog%`. Returns null whenever the interpreter is not provably
 * Node, or the shim carries semantics a direct spawn would drop, so the
 * caller falls back instead of running the program differently than the shim
 * would have.
 */
export function parseCmdShimTarget(cmdPath: string, content: string): CmdShimTarget | null {
    // Always win32 path semantics: these shims exist only on Windows, and the
    // tests parse Windows paths on POSIX runners.
    const shimDir = path.win32.dirname(cmdPath);
    if (carriesForeignEnv(content)) {
        return null;
    }
    for (const line of content.split(/\r?\n/)) {
        if (!line.includes('%*')) {
            continue;
        }
        const tokens = tokenizeCmdLine(line);
        const forwarders = tokens.filter((token) => !token.quoted && token.value === '%*');
        // One forwarding point, or none of this is reproducible: a line that
        // forwards the caller's arguments twice passes each of them twice,
        // which appending them once does not do.
        if (forwarders.length !== 1) {
            continue;
        }
        const forwardIndex = tokens.findIndex((token) => !token.quoted && token.value === '%*');
        if (forwardIndex < 2) {
            continue;
        }
        // Everything the shim runs, minus the `%*` it forwards our args into.
        // The npm template prefixes its execution line with batch plumbing
        // (`endLocal & goto ... & "%_prog%" ...`), so the interpreter is the
        // token right after the last unquoted `&`, not the first token on the
        // line.
        const runTokens = tokens.slice(0, forwardIndex);
        const lastAmp = runTokens.reduce(
            (found, token, index) => (!token.quoted && token.value === '&' ? index : found),
            -1,
        );
        let words = lastAmp >= 0 ? runTokens.slice(lastAmp + 1) : runTokens;
        if (words.length < 2) {
            continue;
        }
        let nodeExec: string | undefined;
        // `env -S node --flags` renders as an `-S` interpreter followed by the
        // real one; step past it.
        if (/^-S(\.exe)?$/i.test(path.win32.basename(words[0].value))) {
            words = words.slice(1);
        }
        const interpreter = words[0].value;
        if (interpreter === '%_prog%') {
            const prog = progIsNode(content, shimDir);
            if (!prog.ok) {
                continue;
            }
            nodeExec = prog.absolute;
        } else {
            const expanded = expandShimPath(interpreter, shimDir) ?? interpreter;
            if (!isNodeInterpreter(expanded)) {
                continue;
            }
            if (path.win32.isAbsolute(interpreter)) {
                nodeExec = interpreter;
            }
        }
        // Everything after the interpreter, in order, exactly as the shim
        // would pass it, with cmd's shim-directory variable substituted the
        // way cmd would. Every token has to be provably literal: this does
        // not reimplement cmd's parser, so a token carrying quoting, a caret
        // escape, a positional parameter, or an environment variable makes
        // the whole shim undecidable, and an undecidable shim is declined
        // rather than run with an argv that might differ from the real one.
        const args: string[] = [];
        let expandable = true;
        for (const word of words.slice(1)) {
            const expanded = literalToken(word, shimDir);
            if (expanded === null) {
                expandable = false;
                break;
            }
            args.push(expanded);
        }
        if (!expandable || args.length === 0) {
            continue;
        }
        return { args, ...(nodeExec ? { nodeExec } : {}) };
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
 * PATH and PATHEXT to the real file; a .cmd/.bat shim around a Node entry is
 * rewritten to a direct `node <entry> <args>` spawn. Anything else — a
 * non-Node shim, a shim with environment semantics, an unparseable one, an
 * unresolvable name — passes through so the caller's own ENOENT/EINVAL
 * handling is the one that fires, naming the command.
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
    return {
        command: target.nodeExec ?? deps.execPath,
        args: [...target.args, ...args],
    };
}
