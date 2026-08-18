import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GuardsConfig } from './guard/rules.ts';
import { listProviders, providerAliases, resolveProvider } from './providers/index.ts';
import { parseExtraBody } from './util/extraBody.ts';
import { parseJsonOrExplain } from './util/json.ts';
import { maskUrlCredentials } from './util/redact.ts';

// Layered configuration: CLI flags > environment variables > ~/.modlens/config.json > built-ins.

export interface ProviderSettings {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    /**
     * Proxy URL for this provider's API requests (issue #20). Falls back to
     * the top-level `proxy`, then to HTTPS_PROXY/HTTP_PROXY. Never applies to
     * the SSRF-guarded remote-image download path.
     */
    proxy?: string;
    /**
     * Vendor-specific fields merged into the request body of the API providers
     * (turning thinking off is the usual reason). Not a string like the rest,
     * so the string-only fields have their own type below.
     */
    extraBody?: Record<string, unknown>;
    /**
     * Ask an OpenAI-compatible gateway to enforce the vision contract itself,
     * by sending it as `response_format: json_schema` (issue #37). Off by
     * default: an endpoint that does not support the field answers 400, and
     * the prompt template is what carries the contract everywhere else.
     */
    structuredOutput?: boolean;
}

/** The settings that hold a plain string, the only ones env vars can bind to. */
export type ProviderStringField = 'apiKey' | 'baseUrl' | 'model' | 'proxy';

const STRING_FIELDS: ProviderStringField[] = ['apiKey', 'baseUrl', 'model', 'proxy'];

/** Harnesses whose local logins modlens can be granted to borrow. */
export const REUSE_HARNESSES = ['claude', 'codex', 'opencode', 'pi', 'grok'] as const;
export type ReuseHarness = (typeof REUSE_HARNESSES)[number];

export interface ModlensConfig {
    provider?: string;
    /** Default proxy URL for all API providers (see ProviderSettings.proxy). */
    proxy?: string;
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
    reuse?: Partial<Record<ReuseHarness, boolean>>;
    /**
     * Named saved copies of one provider slot's file settings, keyed by slot
     * then by a user-chosen label (issue #67). Inert data: nothing in
     * resolution, guards, failover, or env binding reads it. Only `config
     * save` and `config use` write it, and only the openai slot is accepted,
     * because it is the one slot users point at many different gateways.
     */
    saved?: Record<string, Record<string, ProviderSettings>>;
}

export const CONFIG_DIR = path.join(os.homedir(), '.modlens');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// A provider's settings come from one place, whole (issue #42). A baseUrl and
// an apiKey are one credential, and drawing halves from two sources builds a
// pairing that exists in neither: an ambient OPENAI_API_KEY set for another
// tool used to replace the key beside a configured endpoint, and the run
// answered 401 with nothing naming the environment as the source. Merging the
// other way round would keep the same shape, so the rule is not about which
// side wins a field: mention a provider in the config file and the file is its
// source, mention nothing and the environment is, which keeps a container that
// only exports variables working with both halves still matching.
const ENV_BINDINGS: Record<string, Partial<Record<ProviderStringField, string>>> = {
    'gemini-api': { apiKey: 'GEMINI_API_KEY' },
    openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
};

/**
 * Every key under `providers` that names this one, its aliases included.
 *
 * Presence of the key is what counts, not whether it holds anything: clearing
 * the last field of an entry leaves `{}` behind, and reading that as "the file
 * says nothing" would hand the provider back to the environment variables the
 * entry was there to displace.
 */
function fileKeysFor(providerName: string, config: ModlensConfig): string[] {
    const aliases = providerAliases();
    return Object.keys(config.providers ?? {}).filter(
        (key) => (aliases[key] ?? key) === providerName,
    );
}

/** Everything the file holds for one provider, its aliases included. */
function fileSettingsFor(providerName: string, config: ModlensConfig): ProviderSettings {
    const keys = fileKeysFor(providerName, config);
    // The canonical key is merged last so it wins over an alias holding the
    // same field.
    const ordered = [
        ...keys.filter((key) => key !== providerName),
        ...keys.filter((key) => key === providerName),
    ];
    return Object.assign({}, ...ordered.map((key) => config.providers?.[key] ?? {}));
}

/** What the environment holds for one provider, through its bound variables. */
function envSettingsFor(providerName: string, env: NodeJS.ProcessEnv): ProviderSettings {
    const settings: ProviderSettings = {};
    for (const [field, variable] of Object.entries(ENV_BINDINGS[providerName] ?? {}) as Array<
        [ProviderStringField, string]
    >) {
        const value = env[variable]?.trim();
        if (value) {
            settings[field] = value;
        }
    }
    return settings;
}

/**
 * The endpoint variables that stop applying the moment the config file names
 * their provider. Someone who routed a gateway through `ANTHROPIC_BASE_URL`
 * and then set `anthropic.apiKey` in the file has, from 3.17.0, a file-sourced
 * provider with no endpoint, and would otherwise have that gateway's key, and
 * the image beside it, delivered to Anthropic's own endpoint. The check fires
 * only in exactly that case: variable set, provider named by the file, no
 * baseUrl there.
 */
const ENDPOINT_BINDINGS: Record<string, { variable: string; consequence: string }> = {
    // No default endpoint, so the run cannot misroute: it simply has nowhere
    // to go, and saying otherwise would invent a danger to justify the error.
    openai: {
        variable: 'OPENAI_BASE_URL',
        consequence: 'this run has no endpoint left to send the image to',
    },
    anthropic: {
        variable: 'ANTHROPIC_BASE_URL',
        consequence: "this run would have sent your key and the image to Anthropic's own endpoint",
    },
};

export function assertNoRetiredEndpointBinding(
    providerName: string,
    settings: ProviderSettings,
    env: NodeJS.ProcessEnv = process.env,
): void {
    const binding = ENDPOINT_BINDINGS[providerName];
    const variable = binding?.variable;
    if (!variable || settings.baseUrl?.trim() || !env[variable]?.trim()) {
        return;
    }
    // The command names the variable rather than its value: the shell expands
    // it, so the migration stays one paste away without the message carrying
    // an endpoint that may hold userinfo. A masked copy identifies which one
    // is meant, since errors travel into logs and screenshots. The spelling
    // follows the platform, because a POSIX form is not runnable where most
    // of the people this affects are (issue #42 came from Windows).
    const shown = maskUrlCredentials(env[variable]?.trim() ?? '');
    const reference = process.platform === 'win32' ? `$env:${variable}` : `"$${variable}"`;
    throw new Error(
        `${variable} is set (${shown}), but the config file configures ${providerName}, and since 3.17.0 a provider takes its settings from one place: the file, whole. ${providerName}.baseUrl is not in it, so ${binding.consequence}. To keep the endpoint you were using, run: modlens config set ${providerName}.baseUrl ${reference}`,
    );
}

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

/**
 * Whether the config file names this provider, aliases included. An entry
 * holding nothing still counts: see fileKeysFor.
 */
export function providerConfiguredInFile(providerName: string, config: ModlensConfig): boolean {
    return fileKeysFor(providerName, config).length > 0;
}

export function resolveProviderSettings(
    providerName: string,
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): ProviderSettings {
    // Settings saved under an alias (config set gemini.apiKey) count as the
    // file naming this provider: they were invisible once the name resolved to
    // its canonical form.
    const mentioned = providerConfiguredInFile(providerName, config);
    const settings: ProviderSettings = mentioned
        ? { ...fileSettingsFor(providerName, config) }
        : envSettingsFor(providerName, env);
    // The top-level proxy is the default; a provider-level one overrides it.
    if (!settings.proxy && config.proxy?.trim()) {
        settings.proxy = config.proxy.trim();
    }
    return settings;
}

/** Set a dotted key like "gemini-api.apiKey" or "provider" and persist with 0600 perms. */
export function setConfigValue(dottedKey: string, value: string, configPath = CONFIG_PATH): void {
    const config = loadConfigFile(configPath);

    if (dottedKey === 'provider') {
        config.provider = value;
    } else if (dottedKey === 'proxy') {
        if (value.trim() === '') {
            delete config.proxy;
        } else {
            config.proxy = value.trim();
        }
    } else if (dottedKey.startsWith('reuse.')) {
        const harness = dottedKey.slice('reuse.'.length);
        if (!(REUSE_HARNESSES as readonly string[]).includes(harness)) {
            throw new Error(
                `Unknown reuse harness: ${harness}. Use ${REUSE_HARNESSES.join(', ')}.`,
            );
        }
        const key = harness as ReuseHarness;
        const normalized = value.trim().toLowerCase();
        if (normalized === '') {
            delete config.reuse?.[key];
            if (config.reuse && Object.keys(config.reuse).length === 0) {
                delete config.reuse;
            }
        } else if (normalized !== 'true' && normalized !== 'false') {
            throw new Error(`reuse.${harness} must be true or false (empty clears).`);
        } else {
            config.reuse ??= {};
            config.reuse[key] = normalized === 'true';
        }
    } else if (dottedKey.startsWith('guards.')) {
        setGuardsValue(config, dottedKey.slice('guards.'.length), value);
    } else {
        const dot = dottedKey.indexOf('.');
        if (dot <= 0 || dot === dottedKey.length - 1) {
            throw new Error(
                `Invalid config key: ${dottedKey}. Use "provider", "proxy", "reuse.<claude|codex|opencode|pi|grok>", "guards.<denyModels|allowModels|denyWhenUnknown>", or "<provider>.<apiKey|baseUrl|model|proxy|extraBody|structuredOutput>".`,
            );
        }
        const typedName = dottedKey.slice(0, dot);
        const field = dottedKey.slice(dot + 1);
        // The file is read back by exact lowercase key, so a mis-cased or
        // unknown name here would be saved, reported as saved, and silently
        // never read, while the environment quietly kept answering for the
        // provider the user thought they had just configured. Fold the case
        // the way -p does, and refuse a name no provider answers to.
        const providerName = typedName.trim().toLowerCase();
        try {
            resolveProvider(providerName);
        } catch {
            throw new Error(
                `Unknown provider: ${typedName}. Use one of ${listProviders().join(', ')} (aliases like ${Object.keys(
                    providerAliases(),
                )
                    .filter((alias) => providerAliases()[alias] !== alias)
                    .slice(0, 4)
                    .join(', ')} work too).`,
            );
        }
        if (field === 'structuredOutput') {
            // Only the openai route reads it, so accepting it anywhere else
            // would report a saved setting that never does anything.
            if ((providerAliases()[providerName] ?? providerName) !== 'openai') {
                throw new Error(
                    `structuredOutput applies to the openai provider only, not ${providerName}.`,
                );
            }
            const normalized = value.trim().toLowerCase();
            if (normalized !== '' && normalized !== 'true' && normalized !== 'false') {
                throw new Error(
                    `${providerName}.structuredOutput must be true or false (empty clears).`,
                );
            }
            config.providers ??= {};
            config.providers[providerName] ??= {};
            if (normalized === '') {
                delete config.providers[providerName].structuredOutput;
            } else {
                config.providers[providerName].structuredOutput = normalized === 'true';
            }
        } else if (field === 'extraBody') {
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
                `Unknown config field: ${field}. Use apiKey, baseUrl, model, proxy, extraBody, or structuredOutput.`,
            );
        } else {
            config.providers ??= {};
            config.providers[providerName] ??= {};
            config.providers[providerName][field as ProviderStringField] = value;
        }
    }

    persistConfig(config, configPath);
}

/** Write the config back with the 0600 permissions every write here uses. */
function persistConfig(config: ModlensConfig, configPath: string): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
        // best effort on platforms without chmod
    }
}

const SAVED_LABEL = /^[a-z][a-z0-9-]*$/;

/** Deep equality over JSON-shaped data; the `use` refusal rests on it. */
function deepEqualJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, i) => deepEqualJson(item, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a as object).sort();
        const kb = Object.keys(b as object).sort();
        return (
            ka.length === kb.length &&
            ka.every(
                (key, i) =>
                    key === kb[i] &&
                    deepEqualJson(
                        (a as Record<string, unknown>)[key],
                        (b as Record<string, unknown>)[key],
                    ),
            )
        );
    }
    return false;
}

/** The one slot `save`/`use` accept, with alias spellings folded onto it. */
function savedSlotFor(slot: string): string {
    const folded = slot.trim().toLowerCase();
    const canonical = providerAliases()[folded] ?? folded;
    if (canonical !== 'openai') {
        throw new Error(
            `Only the openai slot has saved copies; "${slot}" does not. It is the one slot users point at many different gateways.`,
        );
    }
    return canonical;
}

/**
 * Snapshot the openai slot's file settings under a label (issue #67).
 * Switching gateways used to overwrite providers.openai and lose the previous
 * key; a saved copy is where it survives.
 */
export function saveProviderBundle(slot: string, label: string, configPath = CONFIG_PATH): void {
    const canonical = savedSlotFor(slot);
    if (!SAVED_LABEL.test(label)) {
        throw new Error(
            `Labels are lowercase letters, digits and hyphens, starting with a letter: "${label}" is not.`,
        );
    }
    const config = loadConfigFile(configPath);
    const snapshot = fileSettingsFor(canonical, config);
    if (Object.keys(snapshot).length === 0) {
        throw new Error(
            `Nothing to save: the ${canonical} slot is empty in ${configPath}. Configure it first (modlens config set openai.baseUrl <url>).`,
        );
    }
    config.saved ??= {};
    config.saved[canonical] ??= {};
    config.saved[canonical][label] = snapshot;
    persistConfig(config, configPath);
}

/**
 * Replace the openai slot with a saved copy, whole (issue #67). A merge would
 * build an endpoint nobody configured, so the bundle swaps in as one piece.
 * An active slot that is not saved under any label refuses to be overwritten:
 * losing a key silently is the failure this feature exists to remove, so it
 * can only happen when `discard` says so in as many words.
 */
export function useProviderBundle(
    slot: string,
    label: string,
    discard = false,
    configPath = CONFIG_PATH,
): void {
    const canonical = savedSlotFor(slot);
    const config = loadConfigFile(configPath);
    const bundle = config.saved?.[canonical]?.[label];
    if (bundle === undefined) {
        const known = Object.keys(config.saved?.[canonical] ?? {}).sort();
        throw new Error(
            known.length === 0
                ? `No saved copies exist for ${canonical} yet. Save the current one first: modlens config save openai <label>.`
                : `No saved copy named "${label}". Saved: ${known.join(', ')}.`,
        );
    }
    const current = fileSettingsFor(canonical, config);
    const currentSaved =
        Object.keys(current).length === 0 ||
        Object.values(config.saved?.[canonical] ?? {}).some((entry) =>
            deepEqualJson(entry, current),
        );
    if (!currentSaved && !discard) {
        throw new Error(
            `The current ${canonical} settings are not saved under any label and would be lost. Save them first (modlens config save openai <label>) or pass --discard.`,
        );
    }
    // Every alias spelling goes, or an old section under openai-compat would
    // keep merging into reads beside the bundle that just swapped in.
    for (const key of fileKeysFor(canonical, config)) {
        delete config.providers?.[key];
    }
    config.providers ??= {};
    config.providers[canonical] = { ...bundle };
    persistConfig(config, configPath);
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
 * Render the effective config, with API keys masked and every value tagged with
 * the source it actually came from.
 *
 * One row per provider under its canonical name, whichever key the file used:
 * an entry saved as `gemini` and a `GEMINI_API_KEY` beside it are one provider,
 * and printing them as two rows would show a value the run never reads (issue
 * #42).
 */
export function renderEffectiveConfig(
    config: ModlensConfig,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const aliases = providerAliases();
    const providerNames = new Set<string>(
        Object.keys(config.providers ?? {}).map((key) => aliases[key] ?? key),
    );
    // A provider configured only through the environment is still in effect,
    // so it belongs in a view of what is in effect.
    for (const [providerName, bindings] of Object.entries(ENV_BINDINGS)) {
        if (Object.values(bindings).some((variable) => env[variable]?.trim())) {
            providerNames.add(providerName);
        }
    }

    const providers: Record<string, Record<string, string>> = {};
    for (const name of [...providerNames].sort()) {
        const fileSettings = fileSettingsFor(name, config);
        // Whichever source is actually in effect for this provider, labelled
        // as such: the view has to agree with what a run would use.
        const mentioned = providerConfiguredInFile(name, config);
        const effective = mentioned ? fileSettings : envSettingsFor(name, env);
        const source: 'file' | 'env' = mentioned ? 'file' : 'env';
        const fields: Record<string, string> = {};
        for (const field of STRING_FIELDS) {
            const value = effective[field];
            if (value !== undefined) {
                // config show exists to be pasted into issues: keys are
                // masked, and a proxy URL's userinfo is a credential too.
                const shown =
                    field === 'apiKey'
                        ? maskKey(value)
                        : field === 'proxy'
                          ? maskUrlCredentials(value)
                          : value;
                fields[field] = `${shown} (${source})`;
            }
        }
        // No env binding and no secret to mask, but it changes what gets sent,
        // so it belongs in the effective view.
        if (fileSettings.structuredOutput !== undefined) {
            fields.structuredOutput = `${fileSettings.structuredOutput} (file)`;
        }
        if (fileSettings.extraBody !== undefined) {
            fields.extraBody = `${JSON.stringify(fileSettings.extraBody)} (file)`;
        }
        // An entry the file holds but has emptied still prints, as `{}`: it is
        // why the environment is not supplying this provider, so a view that
        // hid it would leave the silence unexplained.
        if (Object.keys(fields).length > 0 || mentioned) {
            providers[name] = fields;
        }
    }

    const effective: {
        provider?: string;
        proxy?: string;
        providers: Record<string, Record<string, string>>;
        saved?: Record<string, Record<string, string>>;
        guards?: Record<string, string>;
        reuse?: Record<string, string>;
    } = {
        providers,
    };
    // Saved copies are inert data, but they hold keys, so the view names
    // them the way it names everything secret: present, masked, never shown.
    const savedView: Record<string, Record<string, string>> = {};
    for (const [slot, bundles] of Object.entries(config.saved ?? {})) {
        for (const label of Object.keys(bundles).sort()) {
            const bundle = bundles[label];
            const parts = [
                bundle.model,
                bundle.baseUrl,
                bundle.apiKey !== undefined ? `key ${maskKey(bundle.apiKey)}` : 'no key',
            ].filter(Boolean);
            savedView[slot] ??= {};
            savedView[slot][label] = parts.join(' @ ');
        }
    }
    if (Object.keys(savedView).length > 0) {
        effective.saved = savedView;
    }
    if (config.provider?.trim()) {
        effective.provider = config.provider.trim();
    }
    if (config.proxy?.trim()) {
        effective.proxy = `${maskUrlCredentials(config.proxy.trim())} (file)`;
    } else if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
        const raw = (env.HTTPS_PROXY ||
            env.https_proxy ||
            env.HTTP_PROXY ||
            env.http_proxy) as string;
        effective.proxy = `${maskUrlCredentials(raw)} (env)`;
    }
    if (config.guards) {
        const guards: Record<string, string> = {};
        if (config.guards.denyModels !== undefined) {
            guards.denyModels = `${JSON.stringify(config.guards.denyModels)} (file)`;
        }
        if (config.guards.allowModels !== undefined) {
            guards.allowModels = `${JSON.stringify(config.guards.allowModels)} (file)`;
        }
        if (config.guards.denyWhenUnknown !== undefined) {
            guards.denyWhenUnknown = `${config.guards.denyWhenUnknown} (file)`;
        }
        if (Object.keys(guards).length > 0) {
            effective.guards = guards;
        }
    }
    // The onboarding flow decides whether to ask by reading this view, so a
    // recorded refusal must be visible or the user gets re-asked forever.
    if (config.reuse && Object.keys(config.reuse).length > 0) {
        effective.reuse = Object.fromEntries(
            Object.entries(config.reuse).map(([harness, granted]) => [
                harness,
                `${granted} (file)`,
            ]),
        );
    }
    return JSON.stringify(effective, null, 2);
}

function maskKey(key: string): string {
    if (key.length <= 8) {
        return '****';
    }
    return `${key.slice(0, 6)}...${key.slice(-2)}`;
}
