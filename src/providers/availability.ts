// Provider availability and the failover chain, one source of truth shared by
// the doctor's readiness report and the analyzer's failover. A provider is
// "available" when its prerequisites are on this machine: the binary on PATH
// for subprocess providers, the required settings present for API providers.
// Availability is a build-time filter for the chain; a provider that looks
// available can still fail at run time (quota, timeout, a bad result), which
// is what failover itself handles.
import * as fs from 'fs';
import * as path from 'path';
import { type ModlensConfig, type ProviderSettings, resolveProviderSettings } from '../config.ts';
import { resolveProvider, type VisionProvider } from './index.ts';

export interface RequiredSetting {
    field: keyof ProviderSettings;
    env?: string;
}

export interface ProviderDescriptor {
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
export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
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

export function findOnPath(bin: string, env: NodeJS.ProcessEnv): string | null {
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

/** Whether a provider's prerequisites are on this machine right now. */
export function providerAvailable(
    name: string,
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.name === name);
    if (!descriptor) {
        return false;
    }
    if (descriptor.kind === 'subprocess') {
        return findOnPath(descriptor.bin as string, env) !== null;
    }
    const settings = resolveProviderSettings(name, config, env);
    return (descriptor.required ?? []).every((req) => Boolean(settings[req.field]?.trim()));
}

// The failover orders. Local images lead with the zero-config agent. Remote
// URLs lead with the inline API providers, because only the inline download
// path runs the private-address guards, the magic-byte image check, and the
// size cap; an agent fetching a URL on its own passes through none of those,
// so agents stay at the back. claude-cli reads local files only, so it never
// joins the remote chain.
const LOCAL_FAILOVER_ORDER = [
    'antigravity-cli',
    'gemini-api',
    'openai',
    'anthropic',
    'claude-cli',
] as const;
const REMOTE_FAILOVER_ORDER = ['gemini-api', 'openai', 'anthropic', 'antigravity-cli'] as const;

/**
 * The providers a run should try, in order, filtered to what is actually set
 * up on this machine. A configured default provider is a preference: it moves
 * to the front of the region it is allowed in. For a remote URL an agent
 * never jumps ahead of the inline providers (the guards above), so a
 * configured agent default keeps its place at the back of the remote chain.
 */
export function providerChain(
    kind: 'local' | 'remote',
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): VisionProvider[] {
    const names: string[] = [...(kind === 'remote' ? REMOTE_FAILOVER_ORDER : LOCAL_FAILOVER_ORDER)];

    const preferred = config.provider?.trim();
    if (preferred) {
        let canonical: string | null = null;
        try {
            canonical = resolveProvider(preferred).name;
        } catch {
            canonical = null; // an unknown name in the config is not a preference
        }
        const index = canonical ? names.indexOf(canonical) : -1;
        if (index > 0 && canonical) {
            const isAgent = Boolean(resolveProvider(canonical).isolateWorkdir);
            if (kind === 'local' || !isAgent) {
                names.splice(index, 1);
                names.unshift(canonical);
            }
        }
    }

    return names
        .filter((name) => providerAvailable(name, config, env))
        .map((name) => resolveProvider(name));
}
