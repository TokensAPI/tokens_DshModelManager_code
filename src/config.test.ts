import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    assertNoRetiredEndpointBinding,
    CONFIG_TEMPLATE,
    defaultProviderName,
    initConfigFile,
    loadConfigFile,
    providerConfiguredInFile,
    renderEffectiveConfig,
    resolveProviderSettings,
    saveProviderBundle,
    setConfigValue,
    useProviderBundle,
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
    it('takes credentials from the file and nowhere else (#42)', () => {
        // These bindings existed and were removed: an ambient key silently
        // replacing a configured one is a 401 with nothing in it naming the
        // environment as the source.
        const settings = resolveProviderSettings(
            'gemini-api',
            { providers: { 'gemini-api': { apiKey: 'from-file', model: 'm1' } } },
            { GEMINI_API_KEY: 'from-env' },
        );
        expect(settings.apiKey).toBe('from-file');
        expect(settings.model).toBe('m1');
    });

    it('uses the environment whole for a provider the file never mentions', () => {
        const settings = resolveProviderSettings(
            'openai',
            {},
            { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://gw.example.com/v1' },
        );
        expect(settings.baseUrl).toBe('https://gw.example.com/v1');
        expect(settings.apiKey).toBe('k');
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

    it('shows the file values, and never invents one from the environment', () => {
        const rendered = renderEffectiveConfig(
            {
                provider: 'gemini-api',
                providers: { 'gemini-api': { model: 'm1', apiKey: 'AIzaFromFile12345' } },
            },
            { GEMINI_API_KEY: 'AIzaFromEnv12345' },
        );
        const parsed = JSON.parse(rendered) as {
            provider?: string;
            providers: Record<string, Record<string, string>>;
        };
        expect(parsed.provider).toBe('gemini-api');
        // The key is the file's, masked, and tagged file; the ambient one is
        // not shown, because it is not used.
        expect(parsed.providers['gemini-api'].apiKey).toMatch(/\(file\)$/);
        expect(parsed.providers['gemini-api'].apiKey).not.toContain('FromFile');
        expect(rendered).not.toContain('FromEnv');
        // model came from the file, tagged file.
        expect(parsed.providers['gemini-api'].model).toBe('m1 (file)');
    });

    it('masks proxy credentials everywhere config show renders them', () => {
        // config show output is written to be pasted into issues; a proxy
        // URL's userinfo is a credential exactly like an apiKey.
        const fromFile = JSON.parse(
            renderEffectiveConfig(
                {
                    proxy: 'http://alice:s3cr3t@proxy.example:8080',
                    providers: { openai: { proxy: 'socks5://bob:hunter2@10.0.0.1:1080' } },
                },
                {},
            ),
        ) as { proxy?: string; providers: Record<string, Record<string, string>> };
        expect(fromFile.proxy).toBe('http://***@proxy.example:8080/ (file)');
        expect(fromFile.providers.openai.proxy).toBe('socks5://***@10.0.0.1:1080 (file)');
        expect(JSON.stringify(fromFile)).not.toContain('s3cr3t');
        expect(JSON.stringify(fromFile)).not.toContain('hunter2');

        const fromEnv = JSON.parse(
            renderEffectiveConfig({}, { HTTPS_PROXY: 'http://carol:t0ps3cret@proxy.example:8080' }),
        ) as { proxy?: string };
        expect(fromEnv.proxy).toBe('http://***@proxy.example:8080/ (env)');

        // A proxy without credentials renders untouched.
        const plain = JSON.parse(
            renderEffectiveConfig({ proxy: 'http://proxy.example:8080' }, {}),
        ) as { proxy?: string };
        expect(plain.proxy).toBe('http://proxy.example:8080 (file)');
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

    it('records per-harness reuse decisions as strict booleans, empty clears', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('reuse.codex', 'true', file);
        setConfigValue('reuse.pi', 'false', file);
        expect(loadConfigFile(file).reuse).toEqual({ codex: true, pi: false });
        setConfigValue('reuse.codex', '', file);
        expect(loadConfigFile(file).reuse).toEqual({ pi: false });
        expect(() => setConfigValue('reuse.codex', 'maybe', file)).toThrow('true or false');
        expect(() => setConfigValue('reuse.gemini', 'true', file)).toThrow('Unknown reuse');
        // auto never shipped; it is just an unknown key like any other.
        expect(() => setConfigValue('auto', 'true', file)).toThrow('Invalid config key');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('round-trips guards.allowModels the same way', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('guards.allowModels', '["deepseek-v4-*", "glm-5.*"]', file);
        expect(loadConfigFile(file).guards?.allowModels).toEqual(['deepseek-v4-*', 'glm-5.*']);
        setConfigValue('guards.allowModels', 'minimax-m2.5*, qwen3-coder*', file);
        expect(loadConfigFile(file).guards?.allowModels).toEqual(['minimax-m2.5*', 'qwen3-coder*']);
        setConfigValue('guards.allowModels', '', file);
        expect(loadConfigFile(file).guards?.allowModels).toBeUndefined();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('renders reuse decisions and allowModels in the effective config', async () => {
        const { renderEffectiveConfig } = await import('./config.ts');
        const rendered = renderEffectiveConfig(
            { reuse: { codex: false, pi: true }, guards: { allowModels: ['deepseek-v4-*'] } },
            {},
        );
        expect(rendered).toContain('"codex": "false (file)"');
        expect(rendered).toContain('"pi": "true (file)"');
        expect(rendered).toContain('allowModels');
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

describe('structuredOutput (#37)', () => {
    it('stores a boolean and clears on empty', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-so-'));
        const file = path.join(dir, 'config.json');
        setConfigValue('openai.structuredOutput', 'true', file);
        expect(loadConfigFile(file).providers?.openai?.structuredOutput).toBe(true);
        setConfigValue('openai.structuredOutput', 'false', file);
        expect(loadConfigFile(file).providers?.openai?.structuredOutput).toBe(false);
        setConfigValue('openai.structuredOutput', '', file);
        expect(loadConfigFile(file).providers?.openai?.structuredOutput).toBeUndefined();
    });

    it('shows in the effective config, both ways', () => {
        for (const value of [true, false]) {
            const rendered = renderEffectiveConfig({
                providers: { openai: { structuredOutput: value } },
            });
            expect(JSON.parse(rendered).providers.openai.structuredOutput).toBe(`${value} (file)`);
        }
        expect(
            JSON.parse(renderEffectiveConfig({ providers: { openai: { model: 'x' } } })).providers
                .openai.structuredOutput,
        ).toBeUndefined();
    });

    it('refuses it on a provider that would never read it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-so-'));
        const file = path.join(dir, 'config.json');
        expect(() => setConfigValue('anthropic.structuredOutput', 'true', file)).toThrow(
            /openai provider only/,
        );
        // The alias resolves to openai, so it is accepted.
        expect(() => setConfigValue('openai-compat.structuredOutput', 'true', file)).not.toThrow();
    });

    it('refuses a value that is neither true nor false', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-so-'));
        const file = path.join(dir, 'config.json');
        expect(() => setConfigValue('openai.structuredOutput', 'yes', file)).toThrow(
            /must be true or false/,
        );
    });
});

describe('one provider, one source (#42)', () => {
    // The reported failure was a configured Kimi endpoint answering 401
    // because an ambient OPENAI_API_KEY replaced the configured key. The
    // defect is not which side wins a field: a baseUrl and an apiKey are one
    // credential, and drawing halves from two places builds a pairing that
    // exists in neither. So a provider's settings come from one place.
    it('takes the file whole when the file mentions this provider', () => {
        const settings = resolveProviderSettings(
            'openai',
            { providers: { openai: { apiKey: 'file-key', baseUrl: 'https://kimi.example/v1' } } },
            { OPENAI_API_KEY: 'ambient-key', OPENAI_BASE_URL: 'https://api.openai.com/v1' },
        );
        expect(settings.apiKey).toBe('file-key');
        expect(settings.baseUrl).toBe('https://kimi.example/v1');
    });

    it('does not fill a gap from the environment, which is how the pair got split', () => {
        // Endpoint from the file, key from the environment: exactly the
        // combination that answered 401, and exactly what a field-level
        // "file wins" rule would still produce.
        const settings = resolveProviderSettings(
            'openai',
            { providers: { openai: { baseUrl: 'https://kimi.example/v1' } } },
            { OPENAI_API_KEY: 'ambient-key' },
        );
        expect(settings.apiKey).toBeUndefined();
    });

    it('takes the environment whole when the file says nothing about it', () => {
        // A container or CI job that only exports variables keeps working,
        // and both halves come from the same place, so they still match.
        const settings = resolveProviderSettings(
            'openai',
            { providers: { 'gemini-api': { apiKey: 'g' } } },
            { OPENAI_API_KEY: 'env-key', OPENAI_BASE_URL: 'https://gw.example/v1' },
        );
        expect(settings.apiKey).toBe('env-key');
        expect(settings.baseUrl).toBe('https://gw.example/v1');
    });

    it('counts an alias entry as the file mentioning it', () => {
        const settings = resolveProviderSettings(
            'gemini-api',
            { providers: { gemini: { model: 'm' } } },
            { GEMINI_API_KEY: 'env-key' },
        );
        expect(settings.model).toBe('m');
        expect(settings.apiKey).toBeUndefined();
    });

    // What makes the file the source is the key being there, not what is
    // under it. Reading emptiness as silence let a provider slide back onto
    // the variables its entry was written to displace, and clearing the last
    // field is how an entry ends up empty in ordinary use.
    it('counts an emptied entry as the file mentioning it', () => {
        const config = { providers: { 'gemini-api': {} } };
        expect(providerConfiguredInFile('gemini-api', config)).toBe(true);
        expect(
            resolveProviderSettings('gemini-api', config, { GEMINI_API_KEY: 'env-key' }),
        ).toEqual({});
    });

    it('counts an emptied alias entry too', () => {
        const config = { providers: { gemini: {} } };
        expect(providerConfiguredInFile('gemini-api', config)).toBe(true);
        expect(
            resolveProviderSettings('gemini-api', config, { GEMINI_API_KEY: 'env-key' }),
        ).toEqual({});
    });

    it('leaves an emptied entry behind when the last field is cleared', () => {
        // The path that produces one without anybody hand-editing JSON.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-empty-'));
        const configPath = path.join(dir, 'config.json');
        setConfigValue('openai.structuredOutput', 'true', configPath);
        setConfigValue('openai.structuredOutput', '', configPath);
        const config = loadConfigFile(configPath);
        expect(config.providers?.openai).toEqual({});
        expect(resolveProviderSettings('openai', config, { OPENAI_API_KEY: 'env-key' })).toEqual(
            {},
        );
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('labels the source it actually used', () => {
        const fromEnv = JSON.parse(
            renderEffectiveConfig({}, { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://x/v1' }),
        ) as { providers: Record<string, Record<string, string>> };
        expect(fromEnv.providers.openai.baseUrl).toBe('https://x/v1 (env)');
        const fromFile = JSON.parse(
            renderEffectiveConfig(
                { providers: { openai: { baseUrl: 'https://y/v1' } } },
                { OPENAI_BASE_URL: 'https://x/v1' },
            ),
        ) as { providers: Record<string, Record<string, string>> };
        expect(fromFile.providers.openai.baseUrl).toBe('https://y/v1 (file)');
    });

    it('prints one row per provider, under its canonical name', () => {
        // An alias entry and a bound variable are one provider. Two rows put
        // a value on screen that no run reads, in a view whose whole job is
        // to say what runs.
        const shown = JSON.parse(
            renderEffectiveConfig(
                { providers: { gemini: { model: 'm' } } },
                { GEMINI_API_KEY: 'env-key' },
            ),
        ) as { providers: Record<string, Record<string, string>> };
        expect(Object.keys(shown.providers)).toEqual(['gemini-api']);
        expect(shown.providers['gemini-api']).toEqual({ model: 'm (file)' });
    });

    it('shows an emptied entry rather than hiding why the variables went quiet', () => {
        const shown = JSON.parse(
            renderEffectiveConfig({ providers: { 'gemini-api': {} } }, { GEMINI_API_KEY: 'k' }),
        ) as { providers: Record<string, Record<string, string>> };
        expect(shown.providers['gemini-api']).toEqual({});
    });
});

describe('the retired endpoint bindings tell their users (#42)', () => {
    it('refuses when the variable is set and the file has no endpoint', () => {
        // Silence here would deliver a gateway's key, and the image beside
        // it, to the vendor's own endpoint.
        expect(
            () =>
                assertNoRetiredEndpointBinding(
                    'anthropic',
                    { apiKey: 'k' },
                    {
                        ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
                    },
                ),
            // The reference is the platform's own spelling, the same way the
            // masking test below checks it. Asserting the POSIX form
            // unconditionally is what kept Windows CI red from 3.17.0.
        ).toThrow(
            process.platform === 'win32'
                ? /ANTHROPIC_BASE_URL.*anthropic\.baseUrl \$env:ANTHROPIC_BASE_URL/s
                : /ANTHROPIC_BASE_URL.*anthropic\.baseUrl "\$ANTHROPIC_BASE_URL"/s,
        );
    });

    it('masks credentials the endpoint URL carries, since errors travel', () => {
        // An error lands in logs, issue reports and screenshots.
        let message = '';
        try {
            assertNoRetiredEndpointBinding(
                'openai',
                { apiKey: 'k' },
                {
                    OPENAI_BASE_URL: 'https://user:hunter2@gw.example/v1',
                },
            );
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain('gw.example');
        expect(message).not.toContain('hunter2');
        // The command is runnable because the shell expands the variable, so
        // nobody is asked to paste a masked value back into their config.
        // The reference is the platform's own spelling, since a POSIX form is
        // not runnable where this bug was reported from.
        expect(message).toContain(
            process.platform === 'win32'
                ? 'openai.baseUrl $env:OPENAI_BASE_URL'
                : 'openai.baseUrl "$OPENAI_BASE_URL"',
        );
        expect(message).not.toMatch(/baseUrl \S*\*\*\*/);
    });

    it('says nothing to anyone the change did not affect', () => {
        // Endpoint in the file: the variable is irrelevant.
        expect(() =>
            assertNoRetiredEndpointBinding(
                'anthropic',
                { baseUrl: 'https://x/v1' },
                {
                    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
                },
            ),
        ).not.toThrow();
        // No variable: the default endpoint was always what they used.
        expect(() =>
            assertNoRetiredEndpointBinding('anthropic', { apiKey: 'k' }, {}),
        ).not.toThrow();
        // A provider with no retired binding.
        expect(() =>
            assertNoRetiredEndpointBinding('gemini-api', {}, { ANTHROPIC_BASE_URL: 'https://x' }),
        ).not.toThrow();
    });
});

describe('setConfigValue accepts only names a provider answers to', () => {
    // 'OpenAI.apiKey' used to be saved verbatim, reported as saved, and then
    // never read: the file is read back by exact lowercase key, so the
    // environment quietly kept answering for the provider the user thought
    // they had just configured, and the effective view showed two rows for
    // one provider.
    function tmpConfig(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-cfg-'));
        return path.join(dir, 'config.json');
    }

    it('folds a mis-cased provider onto the key reads use', () => {
        const file = tmpConfig();
        setConfigValue('OpenAI.apiKey', 'sk-value-123456', file);

        const config = loadConfigFile(file);
        expect(config.providers?.openai?.apiKey).toBe('sk-value-123456');
        expect(config.providers && 'OpenAI' in config.providers).toBe(false);
    });

    it('keeps an alias as the storage key, folded', () => {
        const file = tmpConfig();
        setConfigValue('Gemini.apiKey', 'g-key-123456', file);

        const config = loadConfigFile(file);
        expect(config.providers?.gemini?.apiKey).toBe('g-key-123456');
    });

    it('refuses a name no provider answers to, naming the valid ones', () => {
        const file = tmpConfig();
        expect(() => setConfigValue('opeanai.apiKey', 'sk-x', file)).toThrow(
            /Unknown provider: opeanai/,
        );
        expect(fs.existsSync(file)).toBe(false);
    });
});

describe('saved copies of the openai slot (#67)', () => {
    // Switching gateways used to overwrite providers.openai and lose the
    // previous key. A saved copy is inert data: resolution, guards, and the
    // env bindings never read it, and only save/use write it.
    function tmpConfig(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-saved-'));
        return path.join(dir, 'config.json');
    }

    const dashscope = {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-alibaba-123456',
        model: 'qwen3-vl-plus',
    };
    const ark = {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'ak-bytedance-123456',
        model: 'doubao-seed-1.6-vision',
    };

    function seed(file: string, settings: Record<string, unknown>): void {
        fs.writeFileSync(file, JSON.stringify({ providers: { openai: settings } }));
    }

    it('snapshots the slot under a label and swaps another one in, whole', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);

        fs.writeFileSync(
            file,
            JSON.stringify({
                providers: { openai: ark },
                saved: JSON.parse(fs.readFileSync(file, 'utf-8')).saved,
            }),
        );
        saveProviderBundle('openai', 'ark', file);
        useProviderBundle('openai', 'dashscope', false, file);

        const config = loadConfigFile(file);
        expect(config.providers?.openai).toEqual(dashscope);
        // The other bundle survived the switch: that is the whole point.
        expect(config.saved?.openai?.ark).toEqual(ark);
    });

    it('refuses to drop an unsaved active slot, and --discard means it', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);
        // The user edits the slot afterwards; the edit is nowhere saved.
        setConfigValue('openai.model', 'qwen3-vl-max', file);

        expect(() => useProviderBundle('openai', 'dashscope', false, file)).toThrow(
            /not saved under any label/,
        );
        useProviderBundle('openai', 'dashscope', true, file);
        expect(loadConfigFile(file).providers?.openai).toEqual(dashscope);
    });

    it('folds an alias-spelled section into the snapshot and clears it on use', () => {
        const file = tmpConfig();
        // openai-compat is an alias spelling of the same slot; the canonical
        // key wins on conflict, and use must remove every spelling or the
        // leftover section would keep merging into reads beside the bundle.
        fs.writeFileSync(
            file,
            JSON.stringify({
                providers: {
                    'openai-compat': { baseUrl: 'https://old.example/v1', model: 'old-model' },
                    openai: { model: 'qwen3-vl-plus', apiKey: 'sk-alibaba-123456' },
                },
            }),
        );
        saveProviderBundle('openai', 'merged', file);

        const saved = loadConfigFile(file).saved?.openai?.merged;
        expect(saved?.model).toBe('qwen3-vl-plus');
        expect(saved?.baseUrl).toBe('https://old.example/v1');

        useProviderBundle('openai', 'merged', false, file);
        const config = loadConfigFile(file);
        expect(config.providers && 'openai-compat' in config.providers).toBe(false);
        expect(config.providers?.openai).toEqual(saved);
    });

    it('refuses labels that are not labels and slots that are not openai', () => {
        const file = tmpConfig();
        seed(file, dashscope);

        expect(() => saveProviderBundle('openai', 'Bad Label', file)).toThrow(/lowercase/);
        expect(() => saveProviderBundle('gemini-api', 'work', file)).toThrow(
            /Only the openai slot/,
        );
        expect(() => saveProviderBundle('openai', 'empty', tmpConfig())).toThrow(/Nothing to save/);
    });

    it('names the saved labels when the asked-for one does not exist', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);

        expect(() => useProviderBundle('openai', 'ark', false, file)).toThrow(/Saved: dashscope/);
    });

    it('masks every saved key in the effective view', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);

        const view = renderEffectiveConfig(loadConfigFile(file), {});
        expect(view).toContain('dashscope');
        expect(view).not.toContain('sk-alibaba-123456');
    });

    it('survives ordinary config set round-trips untouched', () => {
        const file = tmpConfig();
        seed(file, dashscope);
        saveProviderBundle('openai', 'dashscope', file);
        setConfigValue('gemini-api.apiKey', 'g-key-123', file);

        expect(loadConfigFile(file).saved?.openai?.dashscope).toEqual(dashscope);
    });
});
