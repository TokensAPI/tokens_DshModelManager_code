import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    CONFIG_TEMPLATE,
    defaultProviderName,
    initConfigFile,
    loadConfigFile,
    renderEffectiveConfig,
    resolveProviderSettings,
    setConfigValue,
} from './config.ts';

describe('defaultProviderName', () => {
    it('falls back to antigravity-cli without config', () => {
        expect(defaultProviderName({})).toBe('antigravity-cli');
        expect(defaultProviderName({ provider: '  ' })).toBe('antigravity-cli');
    });

    it('honors an explicit provider', () => {
        expect(defaultProviderName({ provider: 'gemini-api' })).toBe('gemini-api');
    });
});

describe('resolveProviderSettings', () => {
    it('env vars override config file values, unbound fields pass through', () => {
        const settings = resolveProviderSettings(
            'gemini-api',
            { providers: { 'gemini-api': { apiKey: 'from-file', model: 'm1' } } },
            { GEMINI_API_KEY: 'from-env' },
        );
        expect(settings.apiKey).toBe('from-env');
        expect(settings.model).toBe('m1');
    });

    it('binds openai and anthropic base urls from env', () => {
        const settings = resolveProviderSettings(
            'openai',
            {},
            {
                OPENAI_API_KEY: 'k',
                OPENAI_BASE_URL: 'https://gw.example.com/v1',
            },
        );
        expect(settings.baseUrl).toBe('https://gw.example.com/v1');
    });
});

describe('setConfigValue + loadConfigFile + renderEffectiveConfig', () => {
    it('round-trips dotted keys and masks keys on render', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('provider', 'gemini-api', file);
        setConfigValue('gemini-api.apiKey', 'AIzaSecretSecret123', file);
        const loaded = loadConfigFile(file);
        expect(loaded.provider).toBe('gemini-api');
        expect(loaded.providers?.['gemini-api']?.apiKey).toBe('AIzaSecretSecret123');
        expect(renderEffectiveConfig(loaded, {})).not.toContain('SecretSecret');
        expect(() => setConfigValue('gemini-api.password', 'x', file)).toThrow(
            'Unknown config field',
        );
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('merges env vars over the file and labels each value source', () => {
        const rendered = renderEffectiveConfig(
            { provider: 'gemini-api', providers: { 'gemini-api': { model: 'm1' } } },
            { GEMINI_API_KEY: 'AIzaFromEnv12345' },
        );
        const parsed = JSON.parse(rendered) as {
            provider?: string;
            providers: Record<string, Record<string, string>>;
        };
        expect(parsed.provider).toBe('gemini-api');
        // apiKey came from the environment, masked, and tagged env.
        expect(parsed.providers['gemini-api'].apiKey).toMatch(/\(env\)$/);
        expect(parsed.providers['gemini-api'].apiKey).not.toContain('FromEnv');
        // model came from the file, tagged file.
        expect(parsed.providers['gemini-api'].model).toBe('m1 (file)');
    });

    it('stores extraBody as parsed JSON, clears it on an empty value, and shows it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('openai.extraBody', '{"thinking":{"type":"disabled"}}', file);
        // An object, not the string: the provider merges it into the request body.
        expect(loadConfigFile(file).providers?.openai?.extraBody).toEqual({
            thinking: { type: 'disabled' },
        });
        const rendered = JSON.parse(renderEffectiveConfig(loadConfigFile(file), {})) as {
            providers: Record<string, Record<string, string>>;
        };
        expect(rendered.providers.openai.extraBody).toBe('{"thinking":{"type":"disabled"}} (file)');
        expect(() => setConfigValue('openai.extraBody', '{oops', file)).toThrow(
            'openai.extraBody is not valid JSON',
        );
        setConfigValue('openai.extraBody', '', file);
        expect(loadConfigFile(file).providers?.openai?.extraBody).toBeUndefined();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('rejects malformed json with a fix hint', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, '{broken');
        expect(() => loadConfigFile(file)).toThrow('Fix or delete the file');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('guards config', () => {
    it('round-trips guards.denyModels from a JSON array or a comma list', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('guards.denyModels', '["gemini-3*", "gpt-5.6*"]', file);
        expect(loadConfigFile(file).guards?.denyModels).toEqual(['gemini-3*', 'gpt-5.6*']);
        setConfigValue('guards.denyModels', 'claude-*, qwen-vl-*', file);
        expect(loadConfigFile(file).guards?.denyModels).toEqual(['claude-*', 'qwen-vl-*']);
        // An empty value clears the list without hand-editing the file.
        setConfigValue('guards.denyModels', '', file);
        expect(loadConfigFile(file).guards?.denyModels).toBeUndefined();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('parses guards.denyWhenUnknown as a boolean and rejects other fields', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('guards.denyWhenUnknown', 'true', file);
        expect(loadConfigFile(file).guards?.denyWhenUnknown).toBe(true);
        setConfigValue('guards.denyWhenUnknown', 'false', file);
        expect(loadConfigFile(file).guards?.denyWhenUnknown).toBe(false);
        expect(() => setConfigValue('guards.denyWhenUnknown', 'maybe', file)).toThrow(
            'true or false',
        );
        expect(() => setConfigValue('guards.nope', 'x', file)).toThrow('Unknown guards field');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('shows guards in the effective config render', () => {
        const rendered = renderEffectiveConfig(
            { guards: { denyModels: ['gemini-3*'], denyWhenUnknown: true } },
            {},
        );
        const parsed = JSON.parse(rendered) as { guards?: Record<string, string> };
        expect(parsed.guards?.denyModels).toBe('["gemini-3*"] (file)');
        expect(parsed.guards?.denyWhenUnknown).toBe('true (file)');
    });
});

describe('initConfigFile', () => {
    it('writes the starter template and refuses to overwrite without force', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-init-'));
        const file = path.join(dir, 'config.json');
        initConfigFile(file);
        expect(loadConfigFile(file)).toEqual(CONFIG_TEMPLATE);
        expect(() => initConfigFile(file)).toThrow('already exists');
        initConfigFile(file, true);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
