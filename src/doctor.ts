// `modlens doctor`: diagnose local config and routing without spending any
// provider quota or making a single network request. Everything here reads the
// local machine only (Node version, PATH, the config file, process ancestry).
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import {
    CONFIG_PATH,
    type ModlensConfig,
    type ProviderSettings,
    resolveProviderSettings,
} from './config.ts';
import { resolveProvider } from './providers/index.ts';
import { detectHarnessDetailed, type HarnessSource } from './recoverPaste/detect.ts';

/** The lowest Node this release supports (see package.json engines). */
export const MIN_NODE = '22.13';

type SettingSource = 'env' | 'file' | 'missing';

interface RequiredSetting {
    field: keyof ProviderSettings;
    env?: string;
}

interface ProviderDescriptor {
    name: string;
    kind: 'subprocess' | 'api';
    /** subprocess providers: the binary they invoke and how to install it. */
    bin?: string;
    install?: string;
    /** api providers: the settings they need and how to supply them. */
    required?: RequiredSetting[];
    fix?: string;
}

// Ordered to match listProviders(): agy first (the zero-config default), then
// the key-based routes, then the Claude CLI.
const DESCRIPTORS: ProviderDescriptor[] = [
    {
        name: 'antigravity-cli',
        kind: 'subprocess',
        bin: 'agy',
        install:
            'curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # sign in, then exit',
    },
    {
        name: 'gemini-api',
        kind: 'api',
        required: [{ field: 'apiKey', env: 'GEMINI_API_KEY' }],
        fix: 'modlens config set gemini-api.apiKey <key>   # free key: https://aistudio.google.com',
    },
    {
        name: 'openai',
        kind: 'api',
        required: [
            { field: 'baseUrl', env: 'OPENAI_BASE_URL' },
            { field: 'apiKey', env: 'OPENAI_API_KEY' },
            { field: 'model' },
        ],
        fix: 'modlens config set openai.baseUrl <url> / openai.apiKey <key> / openai.model <name>',
    },
    {
        name: 'anthropic',
        kind: 'api',
        required: [{ field: 'apiKey', env: 'ANTHROPIC_API_KEY' }],
        fix: 'modlens config set anthropic.apiKey <key>',
    },
    {
        name: 'claude-cli',
        kind: 'subprocess',
        bin: 'claude',
        install: 'install the Claude Code CLI, then run `claude` once to sign in',
    },
];

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
    harness: { detected: string | null; source: HarnessSource };
    config: {
        path: string;
        exists: boolean;
        mode: string | null;
        permissionsOk: boolean;
        note?: string;
    };
}

export interface DoctorInput {
    config: ModlensConfig;
    env?: NodeJS.ProcessEnv;
    providerFlag?: string;
    configPath?: string;
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
function findOnPath(bin: string, env: NodeJS.ProcessEnv): string | null {
    const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        const full = path.join(dir, bin);
        try {
            if (fs.statSync(full).isFile()) {
                return full;
            }
        } catch {
            // not here, keep looking
        }
    }
    return null;
}

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
        const permissionsOk = (mode & 0o077) === 0;
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
    return {
        node: {
            version: process.version,
            minimum: MIN_NODE,
            meetsMinimum: meetsMinimum(process.version, MIN_NODE),
        },
        nodeSqlite: checkNodeSqlite(),
        providers: DESCRIPTORS.map((d) => inspectProvider(d, input.config, env)),
        selection: resolveSelection(input.config, input.providerFlag),
        harness: (() => {
            const detection = detectHarnessDetailed();
            return { detected: detection.harness, source: detection.source };
        })(),
        config: inspectConfigFile(configPath),
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

    lines.push('Harness');
    lines.push(
        report.harness.detected
            ? `  ${report.harness.detected} (via ${report.harness.source})`
            : `  none detected (${report.harness.source})`,
    );
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
