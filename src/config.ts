import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GuardsConfig } from './guard/rules.ts';
import { providerAliases } from './providers/index.ts';
import { parseExtraBody } from './util/extraBody.ts';
import { parseJsonOrExplain } from './util/json.ts';

// Layered configuration: CLI flags > environment variables > ~/.modlens/config.json > built-ins.

export interface ProviderSettings {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    /**
     * Vendor-specific fields merged into the request body of the API providers
     * (turning thinking off is the usual reason). Not a string like the rest,
     * so the string-only fields have their own type below.
     */
    extraBody?: Record<string, unknown>;
}

/** The settings that hold a plain string, the only ones env vars can bind to. */
export type ProviderStringField = 'apiKey' | 'baseUrl' | 'model';

const STRING_FIELDS: ProviderStringField[] = ['apiKey', 'baseUrl', 'model'];

/** Harnesses whose local logins modlens can be granted to borrow. */
export const BORROW_HARNESSES = ['claude', 'codex', 'opencode', 'pi'] as const;
export type BorrowHarness = (typeof BORROW_HARNESSES)[number];

export interface ModlensConfig {
    provider?: string;
    providers?: Record<string, ProviderSettings>;
    /** Invocation guard: when the active model already sees images, skip the engine. */
    guards?: GuardsConfig;
    /**
     * Per-harness borrow decisions, written by the onboarding conversation:
     * true = the user allowed borrowing this harness's login for reads,
     * false = they refused (do not ask again), absent = never asked.
     * `claude` absent counts as granted for compatibility: claude-cli predates
     * this model as a built-in provider.
     */
    borrow?: Partial<Record<BorrowHarness, boolean>>;
}

export const CONFIG_DIR = path.join(os.homedir(), '.modlens');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const ENV_BINDINGS: Record<string, Partial<Record<ProviderStringField, string>>> = {
    'gemini-api': { apiKey: 'GEMINI_API_KEY' },
    openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
};

export function loadConfigFile(configPath = CONFIG_PATH): ModlensConfig {
    let raw: string;
    try {
        raw = fs.readFileSync(configPath, 'utf-8');
    } catch (error) {
        // Only a missing file means "no config". Permissions or a directory in
        // its place are real problems, not a reason to fall back to defaults.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw new Error(
            `Cannot read ${configPath}: ${(error as Error).message}. Fix the file or its permissions.`,
        );
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return parsed as ModlensConfig;
    } catch (error) {
        throw new Error(
            `Failed to parse ${configPath}: ${(error as Error).message}. Fix or delete the file.`,
        );
    }
}

export function defaultProviderName(config: ModlensConfig): string {
    return config.provider?.trim() || 'antigravity-cli';
}

/** Resolve settings for one provider with env vars overriding the config file. */
export function resolveProviderSettings(
    providerName: string,
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): ProviderSettings {
    // Settings saved under an alias (config set gemini.apiKey) were invisible
    // once the name resolved to its canonical form.
    const aliasNames = Object.entries(providerAliases())
        .filter(([alias, canonical]) => canonical === providerName && alias !== providerName)
        .map(([alias]) => alias);
    const fromFile = {
        ...Object.assign({}, ...aliasNames.map((alias) => config.providers?.[alias] ?? {})),
        ...(config.providers?.[providerName] ?? {}),
    };
    const bindings = ENV_BINDINGS[providerName] ?? {};

    const settings: ProviderSettings = { ...fromFile };
    for (const [field, envName] of Object.entries(bindings) as Array<
        [ProviderStringField, string]
    >) {
        const value = env[envName]?.trim();
        if (value) {
            settings[field] = value;
        }
    }
    return settings;
}

/** Set a dotted key like "gemini-api.apiKey" or "provider" and persist with 0600 perms. */
export function setConfigValue(dottedKey: string, value: string, configPath = CONFIG_PATH): void {
    const config = loadConfigFile(configPath);

    if (dottedKey === 'provider') {
        config.provider = value;
    } else if (dottedKey === 'auto') {
        throw new Error(
            'The auto switch was replaced by per-harness grants. Use: modlens config set borrow.<claude|codex|opencode|pi> true|false',
        );
    } else if (dottedKey.startsWith('borrow.')) {
        const harness = dottedKey.slice('borrow.'.length);
        if (!(BORROW_HARNESSES as readonly string[]).includes(harness)) {
            throw new Error(
                `Unknown borrow harness: ${harness}. Use ${BORROW_HARNESSES.join(', ')}.`,
            );
        }
        const key = harness as BorrowHarness;
        const normalized = value.trim().toLowerCase();
        if (normalized === '') {
            delete config.borrow?.[key];
            if (config.borrow && Object.keys(config.borrow).length === 0) {
                delete config.borrow;
            }
        } else if (normalized !== 'true' && normalized !== 'false') {
            throw new Error(`borrow.${harness} must be true or false (empty clears).`);
        } else {
            config.borrow ??= {};
            config.borrow[key] = normalized === 'true';
        }
    } else if (dottedKey.startsWith('guards.')) {
        setGuardsValue(config, dottedKey.slice('guards.'.length), value);
    } else {
        const dot = dottedKey.indexOf('.');
        if (dot <= 0 || dot === dottedKey.length - 1) {
            throw new Error(
                `Invalid config key: ${dottedKey}. Use "provider", "borrow.<claude|codex|opencode|pi>", "guards.<denyModels|allowModels|denyWhenUnknown>", or "<provider>.<apiKey|baseUrl|model|extraBody>".`,
            );
        }
        const providerName = dottedKey.slice(0, dot);
        const field = dottedKey.slice(dot + 1);
        if (field === 'extraBody') {
            config.providers ??= {};
            config.providers[providerName] ??= {};
            // An empty value clears it, so a user who no longer wants the
            // passthrough does not have to hand-edit the file.
            if (value.trim() === '') {
                delete config.providers[providerName].extraBody;
            } else {
                config.providers[providerName].extraBody = parseExtraBody(
                    value,
                    `${providerName}.extraBody`,
                );
            }
        } else if (!STRING_FIELDS.includes(field as ProviderStringField)) {
            throw new Error(
                `Unknown config field: ${field}. Use apiKey, baseUrl, model, or extraBody.`,
            );
        } else {
            config.providers ??= {};
            config.providers[providerName] ??= {};
            config.providers[providerName][field as ProviderStringField] = value;
        }
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
        // best effort on platforms without chmod
    }
}

/** Accepts a JSON array of globs or a comma-separated list. Empty clears. */
function setGuardsValue(config: ModlensConfig, field: string, value: string): void {
    if (field === 'denyModels' || field === 'allowModels') {
        if (value.trim() === '') {
            delete config.guards?.[field];
        } else {
            config.guards ??= {};
            config.guards[field] = parseModelList(value, `guards.${field}`);
        }
    } else if (field === 'denyWhenUnknown') {
        const normalized = value.trim().toLowerCase();
        if (normalized !== 'true' && normalized !== 'false') {
            throw new Error('guards.denyWhenUnknown must be true or false.');
        }
        config.guards ??= {};
        config.guards.denyWhenUnknown = normalized === 'true';
    } else {
        throw new Error(
            `Unknown guards field: ${field}. Use denyModels, allowModels, or denyWhenUnknown.`,
        );
    }
    if (config.guards && Object.keys(config.guards).length === 0) {
        delete config.guards;
    }
}

function parseModelList(value: string, key: string): string[] {
    if (value.trim().startsWith('[')) {
        const parsed = parseJsonOrExplain(value, key);
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            throw new Error(`${key} must be a JSON array of glob strings.`);
        }
        return parsed as string[];
    }
    return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

/**
 * The starter file holds nothing but the shape. Pre-filling every provider and
 * every default looked helpful and was not: it buried the one real decision in
 * placeholders, and writing today's defaults into the file freezes them, so a
 * later change to a default model would be silently overridden by this copy.
 */
export const CONFIG_TEMPLATE: ModlensConfig = {
    // Empty means the built-in default provider.
    provider: '',
    providers: {},
};

/** Write a starter config. Refuses to overwrite unless force is set. */
export function initConfigFile(configPath = CONFIG_PATH, force = false): void {
    if (!force && fs.existsSync(configPath)) {
        throw new Error(`${configPath} already exists. Use --force to overwrite.`);
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
        // best effort on platforms without chmod
    }
}

/**
 * Render the effective config: the file merged with environment variables, with
 * API keys masked and every value tagged with where it came from (file or env).
 *
 * Reading only the file misled anyone who set a key through GEMINI_API_KEY (or
 * the other bound vars): the value modlens actually uses never showed up.
 */
export function renderEffectiveConfig(
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const providerNames = new Set<string>(Object.keys(config.providers ?? {}));
    for (const [providerName, bindings] of Object.entries(ENV_BINDINGS)) {
        if (Object.values(bindings).some((envName) => env[envName]?.trim())) {
            providerNames.add(providerName);
        }
    }

    const providers: Record<string, Record<string, string>> = {};
    for (const name of [...providerNames].sort()) {
        const fileSettings = config.providers?.[name] ?? {};
        const bindings = ENV_BINDINGS[name] ?? {};
        const fields: Record<string, string> = {};
        for (const field of STRING_FIELDS) {
            const envName = bindings[field];
            const envValue = envName ? env[envName]?.trim() : undefined;
            const value = envValue ?? fileSettings[field];
            const source = envValue ? 'env' : fileSettings[field] !== undefined ? 'file' : null;
            if (value !== undefined && source) {
                const shown = field === 'apiKey' ? maskKey(value) : value;
                fields[field] = `${shown} (${source})`;
            }
        }
        // No env binding and no secret to mask, but it changes what gets sent,
        // so it belongs in the effective view.
        if (fileSettings.extraBody !== undefined) {
            fields.extraBody = `${JSON.stringify(fileSettings.extraBody)} (file)`;
        }
        if (Object.keys(fields).length > 0) {
            providers[name] = fields;
        }
    }

    const effective: {
        provider?: string;
        providers: Record<string, Record<string, string>>;
        guards?: Record<string, string>;
    } = {
        providers,
    };
    if (config.provider?.trim()) {
        effective.provider = config.provider.trim();
    }
    if (config.guards) {
        const guards: Record<string, string> = {};
        if (config.guards.denyModels !== undefined) {
            guards.denyModels = `${JSON.stringify(config.guards.denyModels)} (file)`;
        }
        if (config.guards.denyWhenUnknown !== undefined) {
            guards.denyWhenUnknown = `${config.guards.denyWhenUnknown} (file)`;
        }
        if (Object.keys(guards).length > 0) {
            effective.guards = guards;
        }
    }
    return JSON.stringify(effective, null, 2);
}

function maskKey(key: string): string {
    if (key.length <= 8) {
        return '****';
    }
    return `${key.slice(0, 6)}...${key.slice(-2)}`;
}
