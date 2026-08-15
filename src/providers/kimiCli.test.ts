import { describe, expect, it } from 'vitest';
import { buildKimiCliInvocation, parseKimiCliOutput } from './kimiCli.ts';

const VALID = {
    summary: 'a red square',
    ocr: { full_text: '', lines: [] },
    layout: { regions: [] },
    semantics: { scene: 'test', entities: [] },
    visual: { dominant_colors: ['#ff5050'] },
    uncertainty: [],
};

// Every line here was observed from kimi 0.36.1, not read off a doc.
const ok = (result: unknown) =>
    [
        JSON.stringify({ role: 'meta', type: 'system.version', version: '0.36.1' }),
        JSON.stringify({ role: 'assistant', content: JSON.stringify(result) }),
        JSON.stringify({
            role: 'meta',
            type: 'session.resume_hint',
            session_id: 's1',
            content: 'To resume this session: kimi -r s1',
        }),
    ].join('\n');

describe('buildKimiCliInvocation', () => {
    it('isolates skills, or kimi reads the image by calling modlens back', () => {
        // Observed: with skill discovery on, kimi loads the modlens skill and
        // runs modlens to read the image, so a provider that shells out to
        // kimi would recurse into itself. Pointing --skills-dir at an empty
        // directory makes it use its own tool and feed the image to the model.
        const invocation = buildKimiCliInvocation({
            imageSource: '/tmp/red.png',
            imageKind: 'local',
            timeoutMs: 5000,
        });
        const skillsDir = invocation.args[invocation.args.indexOf('--skills-dir') + 1];
        expect(skillsDir).toBeTruthy();
        expect(invocation.args).toContain('--output-format');
        expect(invocation.args[invocation.args.indexOf('--output-format') + 1]).toBe('stream-json');
        // --auto is refused alongside --prompt by the CLI itself.
        expect(invocation.args).not.toContain('--auto');
        expect(invocation.command).toBe('kimi');
    });

    it('asks for the JSON template, since this CLI cannot enforce a schema', () => {
        const invocation = buildKimiCliInvocation({
            imageSource: '/tmp/red.png',
            imageKind: 'local',
            timeoutMs: 5000,
        });
        const prompt = invocation.args[invocation.args.indexOf('-p') + 1];
        expect(prompt).toContain('/tmp/red.png');
        expect(prompt).toContain('"summary"');
        expect(invocation.args).not.toContain('--json-schema');
    });

    it('refuses a remote image, which this route cannot fetch', () => {
        expect(() =>
            buildKimiCliInvocation({
                imageSource: 'https://x/y.png',
                imageKind: 'remote',
                timeoutMs: 5000,
            }),
        ).toThrow(/local files only/);
    });

    it('passes the model through when one is chosen', () => {
        const invocation = buildKimiCliInvocation({
            imageSource: '/tmp/red.png',
            imageKind: 'local',
            timeoutMs: 5000,
            settings: { model: 'aliyun/qwen3.8-max' },
        });
        expect(invocation.args[invocation.args.indexOf('-m') + 1]).toBe('aliyun/qwen3.8-max');
    });
});

describe('parseKimiCliOutput', () => {
    it('takes the assistant line out of the ndjson envelope', () => {
        const parsed = parseKimiCliOutput(ok(VALID));
        expect((parsed.result as { summary: string }).summary).toBe('a red square');
    });

    it('reads a fenced or chatty answer, since nothing enforced the shape', () => {
        const chatty = [
            JSON.stringify({ role: 'meta', type: 'system.version', version: '0.36.1' }),
            JSON.stringify({
                role: 'assistant',
                content: `Here you go:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``,
            }),
        ].join('\n');
        expect((parseKimiCliOutput(chatty).result as { summary: string }).summary).toBe(
            'a red square',
        );
    });

    it('names the failure when the run produced no answer', () => {
        // Observed on an unconfigured install: the version line, then nothing,
        // with the reason on stderr and exit 1.
        const versionOnly = JSON.stringify({
            role: 'meta',
            type: 'system.version',
            version: '0.36.1',
        });
        expect(() => parseKimiCliOutput(versionOnly)).toThrow(/no answer/i);
    });

    it('ignores tool traffic and takes the final answer', () => {
        const withTools = [
            JSON.stringify({ role: 'meta', type: 'system.version', version: '0.36.1' }),
            JSON.stringify({ role: 'assistant', content: null }),
            JSON.stringify({ role: 'tool', tool_call_id: 'c1', content: '<image ...>' }),
            JSON.stringify({ role: 'assistant', content: JSON.stringify(VALID) }),
        ].join('\n');
        expect((parseKimiCliOutput(withTools).result as { summary: string }).summary).toBe(
            'a red square',
        );
    });
});
