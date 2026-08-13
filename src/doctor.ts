// `modlens doctor`: diagnose local config and routing without spending any
// provider quota or making a single network request. Everything here reads the
// local machine only (Node version, PATH, the config file, process ancestry).
import * as fs from 'fs';
import { createRequire } from 'module';
import { type DiscoverOptions, discoverAuto, type HarnessProbe } from './auto/discover.ts';
import {
    BORROW_HARNESSES,
    type BorrowHarness,
    CONFIG_PATH,
    type ModlensConfig,
    resolveProviderSettings,
} from './config.ts';
import { detectActiveModel } from './guard/index.ts';
import { allowPatterns, denyPatterns, evaluateGuard, type ModelSource } from './guard/rules.ts';
import {
    findOnPath,
    PROVIDER_DESCRIPTORS,
    type ProviderDescriptor,
    providerChain,
} from './providers/availability.ts';
import { resolveProvider } from './providers/index.ts';
import { detectHarnessDetailed, type HarnessSource } from './recoverPaste/detect.ts';

/** The lowest Node this release supports (see package.json engines). */
export const MIN_NODE = '22.13';

type SettingSource = 'env' | 'file' | 'missing';

export interface DoctorSettingStatus {
    field: string;
    present: boolean;
    source: SettingSource;
    env?: string;
}

export interface DoctorProvider {
    name: string;
    kind: 'subprocess' | 'api';
    ready: boolean;
    detail: string;
    /** subprocess: the resolved binary path when found. */
    binaryPath?: string | null;
    /** api: per-field presence and where each value came from. */
    settings?: DoctorSettingStatus[];
    fix?: string;
}

export interface DoctorReport {
    node: { version: string; minimum: string; meetsMinimum: boolean };
    nodeSqlite: { available: boolean; detail: string };
    providers: DoctorProvider[];
    selection: {
        provider: string;
        canonical: string | null;
        source: 'flag' | 'config' | 'default';
        reason: string;
    };
    /** The failover order actually available on this machine, per input kind. */
    chains: { local: string[]; remote: string[] };
    harness: { detected: string | null; source: HarnessSource };
    /** The invocation guard's rules and a live evaluation (see guards config). */
    guard: {
        rules: number;
        /** Non-zero switches the guard into allowlist mode: only listed models run. */
        allowRules: number;
        denyWhenUnknown: boolean;
        model: string | null;
        source: ModelSource;
        verdict: 'allow' | 'deny';
        matched?: string;
        reason: string;
    };
    config: {
        path: string;
        exists: boolean;
        mode: string | null;
        permissionsOk: boolean;
        note?: string;
    };
    /** Borrow state: per-harness grant decisions plus what discovery found. */
    borrow: {
        /** claude absent counts as granted (claude-cli predates the model). */
        decisions: Record<BorrowHarness, 'granted' | 'refused' | 'not asked'>;
        probes: HarnessProbe[];
    };
}

export interface DoctorInput {
    config: ModlensConfig;
    env?: NodeJS.ProcessEnv;
    providerFlag?: string;
    configPath?: string;
    /** Discovery overrides (home, cachePath, runCli), mainly for tests. */
    auto?: DiscoverOptions;
}

/** Parse "v24.13.0" or "22.13" into [major, minor]. */
function versionParts(version: string): [number, number] {
    const match = /(\d+)\.(\d+)/.exec(version.replace(/^v/, ''));
    if (!match) {
        return [0, 0];
    }
    return [Number(match[1]), Number(match[2])];
}

function meetsMinimum(version: string, minimum: string): boolean {
    const [major, minor] = versionParts(version);
    const [minMajor, minMinor] = versionParts(minimum);
    return major > minMajor || (major === minMajor && minor >= minMinor);
}

/** First executable named `bin` on PATH, or null. No spawning. */

function checkNodeSqlite(): { available: boolean; detail: string } {
    // Loading node:sqlite emits an "experimental" warning; silence it just for
    // this probe so a clean diagnostic run does not look like it hit trouble.
    const realEmit = process.emitWarning;
    process.emitWarning = () => {};
    try {
        const mod = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: unknown };
        if (mod?.DatabaseSync) {
            return {
                available: true,
                detail: 'node:sqlite is available (OpenCode paste recovery)',
            };
        }
        return { available: false, detail: 'node:sqlite loaded but DatabaseSync is missing' };
    } catch {
        return {
            available: false,
            detail: 'node:sqlite unavailable. Upgrade Node to 22.13+ for OpenCode paste recovery',
        };
    } finally {
        process.emitWarning = realEmit;
    }
}

function inspectProvider(
    descriptor: ProviderDescriptor,
    config: ModlensConfig,
    env: NodeJS.ProcessEnv,
): DoctorProvider {
    if (descriptor.kind === 'subprocess') {
        const binaryPath = findOnPath(descriptor.bin as string, env);
        return {
            name: descriptor.name,
            kind: 'subprocess',
            ready: binaryPath !== null,
            binaryPath,
            detail: binaryPath
                ? `${descriptor.bin} found at ${binaryPath}`
                : `${descriptor.bin} not on PATH`,
            fix: binaryPath ? undefined : descriptor.install,
        };
    }

    const settings = resolveProviderSettings(descriptor.name, config, env);
    const statuses: DoctorSettingStatus[] = (descriptor.required ?? []).map((req) => {
        const envValue = req.env ? env[req.env]?.trim() : undefined;
        const value = settings[req.field]?.trim();
        const source: SettingSource = envValue ? 'env' : value ? 'file' : 'missing';
        return { field: req.field, present: Boolean(value), source, env: req.env };
    });
    const missing = statuses.filter((s) => !s.present).map((s) => s.field);
    const ready = missing.length === 0;
    const detail = ready
        ? statuses.map((s) => `${s.field}: ${s.source}`).join(', ')
        : `missing: ${missing.join(', ')}`;
    return {
        name: descriptor.name,
        kind: 'api',
        ready,
        settings: statuses,
        detail,
        fix: ready ? undefined : descriptor.fix,
    };
}

function resolveSelection(
    config: ModlensConfig,
    providerFlag: string | undefined,
): DoctorReport['selection'] {
    const raw = providerFlag?.trim() || config.provider?.trim() || 'antigravity-cli';
    const source: 'flag' | 'config' | 'default' = providerFlag?.trim()
        ? 'flag'
        : config.provider?.trim()
          ? 'config'
          : 'default';
    let canonical: string | null;
    try {
        canonical = resolveProvider(raw).name;
    } catch {
        canonical = null;
    }
    const reason =
        source === 'flag'
            ? `-p ${raw} on the command line`
            : source === 'config'
              ? 'provider set in the config file'
              : 'built-in default (no -p flag and no provider in the config file)';
    return { provider: raw, canonical, source, reason };
}

function inspectConfigFile(configPath: string): DoctorReport['config'] {
    try {
        const stat = fs.statSync(configPath);
        const mode = stat.mode & 0o777;
        // POSIX permission bits are only meaningful where the platform enforces
        // them. On Windows every file reads back as 0o666/0o777, so judging it by
        // the group/world bits would warn on a perfectly private file; report the
        // mode without the verdict there.
        const enforcesPosixPerms = typeof process.getuid === 'function';
        const permissionsOk = !enforcesPosixPerms || (mode & 0o077) === 0;
        return {
            path: configPath,
            exists: true,
            mode: mode.toString(8).padStart(3, '0'),
            permissionsOk,
            note: permissionsOk
                ? undefined
                : 'group/world can read this file. Run: chmod 600 to lock it down',
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
                path: configPath,
                exists: false,
                mode: null,
                permissionsOk: true,
                note: 'no config file (using env vars and built-in defaults)',
            };
        }
        return {
            path: configPath,
            exists: true,
            mode: null,
            permissionsOk: false,
            note: `cannot stat: ${(error as Error).message}`,
        };
    }
}

export function buildDoctorReport(input: DoctorInput): DoctorReport {
    const env = input.env ?? process.env;
    const configPath = input.configPath ?? CONFIG_PATH;
    // Detect once and hand the result to the guard's model detection, which
    // would otherwise spawn a second `ps` walk for the same answer. Unlike the
    // fast-path runGuard, doctor always detects the model, so "why did it
    // skip" (or "what would it see") answers itself even with no rules set.
    const harnessDetection = detectHarnessDetailed();
    const guardDetection = detectActiveModel({
        cwd: process.cwd(),
        env,
        harness: harnessDetection.harness,
    });
    const guardVerdict = evaluateGuard(input.config.guards, guardDetection);
    return {
        node: {
            version: process.version,
            minimum: MIN_NODE,
            meetsMinimum: meetsMinimum(process.version, MIN_NODE),
        },
        nodeSqlite: checkNodeSqlite(),
        providers: PROVIDER_DESCRIPTORS.map((d) => inspectProvider(d, input.config, env)),
        selection: resolveSelection(input.config, input.providerFlag),
        chains: {
            local: providerChain('local', input.config, env).map((p) => p.name),
            remote: providerChain('remote', input.config, env).map((p) => p.name),
        },
        harness: { detected: harnessDetection.harness, source: harnessDetection.source },
        guard: {
            rules: denyPatterns(input.config.guards).length,
            allowRules: allowPatterns(input.config.guards).length,
            denyWhenUnknown: input.config.guards?.denyWhenUnknown ?? false,
            model: guardVerdict.model,
            source: guardVerdict.source,
            verdict: guardVerdict.guard,
            matched: guardVerdict.matched,
            reason: guardVerdict.reason,
        },
        config: inspectConfigFile(configPath),
        // doctor is the "what could be borrowed" view, so it always probes
        // fresh (and rewrites the cache); regular runs read the cache instead.
        borrow: {
            decisions: Object.fromEntries(
                BORROW_HARNESSES.map((harness) => {
                    const decision = input.config.borrow?.[harness];
                    const fallback = harness === 'claude' ? 'granted' : 'not asked';
                    return [
                        harness,
                        decision === true ? 'granted' : decision === false ? 'refused' : fallback,
                    ];
                }),
            ) as Record<BorrowHarness, 'granted' | 'refused' | 'not asked'>,
            probes: discoverAuto({ env, fresh: true, ...input.auto }).probes,
        },
    };
}

function mark(ok: boolean): string {
    return ok ? '[ok]' : '[!!]';
}

export function renderDoctorReport(report: DoctorReport): string {
    const lines: string[] = [];

    lines.push('modlens doctor');
    lines.push('(local diagnostics only: no network calls, no provider quota spent)');
    lines.push('');

    lines.push('Node');
    lines.push(
        `  ${mark(report.node.meetsMinimum)} ${report.node.version} (minimum ${report.node.minimum})`,
    );
    lines.push(`  ${mark(report.nodeSqlite.available)} ${report.nodeSqlite.detail}`);
    lines.push('');

    lines.push('Providers');
    for (const provider of report.providers) {
        lines.push(`  ${mark(provider.ready)} ${provider.name}: ${provider.detail}`);
        if (provider.fix) {
            lines.push(`       fix: ${provider.fix}`);
        }
    }
    lines.push('');

    lines.push('Selected provider');
    const canonicalNote =
        report.selection.canonical && report.selection.canonical !== report.selection.provider
            ? ` (canonical: ${report.selection.canonical})`
            : report.selection.canonical === null
              ? ' (unknown provider name)'
              : '';
    lines.push(`  ${report.selection.provider}${canonicalNote}`);
    lines.push(`  reason: ${report.selection.reason}`);
    lines.push('');

    lines.push('Failover chains (what a run tries, in order)');
    const chainLine = (chain: string[]) =>
        chain.length > 0 ? chain.join(' -> ') : '(none available)';
    lines.push(`  local:  ${chainLine(report.chains.local)}`);
    lines.push(`  remote: ${chainLine(report.chains.remote)}`);
    lines.push('');

    lines.push('Harness');
    lines.push(
        report.harness.detected
            ? `  ${report.harness.detected} (via ${report.harness.source})`
            : `  none detected (${report.harness.source})`,
    );
    lines.push('');

    lines.push('Guard (should the vision engine run for the active model?)');
    lines.push(
        `  rules: ${report.guard.rules} deny pattern(s), ${report.guard.allowRules} allow pattern(s)${report.guard.allowRules > 0 ? ' (allowlist mode)' : ''}, denyWhenUnknown: ${report.guard.denyWhenUnknown}`,
    );
    lines.push(`  active model: ${report.guard.model ?? 'unknown'} (via ${report.guard.source})`);
    lines.push(
        `  verdict: ${report.guard.verdict}${report.guard.matched ? ` (matched "${report.guard.matched}")` : ''}, ${report.guard.reason}`,
    );
    lines.push('');

    lines.push('Borrow (may modlens spend other local logins? config "borrow.<harness>")');
    lines.push(
        `  decisions: ${Object.entries(report.borrow.decisions)
            .map(([harness, decision]) => `${harness} ${decision}`)
            .join(', ')}`,
    );
    for (const probe of report.borrow.probes) {
        if (!probe.cliFound) {
            lines.push(`  ${probe.harness}: cli not found`);
            continue;
        }
        const parts: string[] = [];
        const shown = probe.visionModels.slice(0, 3).join(', ');
        parts.push(
            probe.visionModels.length === 0
                ? 'no vision models'
                : `${probe.visionModels.length} vision model(s): ${shown}${probe.visionModels.length > 3 ? ', ...' : ''}`,
        );
        if (probe.loggedIn !== undefined) {
            parts.push(probe.loggedIn ? 'logged in' : 'no credentials found');
        }
        parts.push(`via ${probe.source}, ${probe.elapsedMs}ms`);
        if (probe.error) {
            parts.push(`error: ${probe.error}`);
        }
        lines.push(`  ${probe.harness}: ${parts.join(', ')}`);
    }
    lines.push('');

    lines.push('Config file');
    lines.push(`  path: ${report.config.path}`);
    if (report.config.exists) {
        lines.push(
            `  ${mark(report.config.permissionsOk)} exists, mode ${report.config.mode ?? '?'}`,
        );
    } else {
        lines.push('  not present');
    }
    if (report.config.note) {
        lines.push(`  note: ${report.config.note}`);
    }

    return lines.join('\n');
}
