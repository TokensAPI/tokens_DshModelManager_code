import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Git distribution', () => {
    it('ships the CLI without an install-time lifecycle build', () => {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        const bundle = readFileSync(join(root, 'dist/main.js'), 'utf8');

        expect(pkg.scripts.prepare).toBeUndefined();
        expect(pkg.scripts.prepack).toBeUndefined();
        expect(pkg.scripts.prepublishOnly).toBe('pnpm build');
        expect(pkg.files).toContain('dist');
        expect(bundle).toContain('#!/usr/bin/env node');
    });

    it('ships bilingual market metadata and the private registry target', () => {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        expect(pkg.publishConfig.registry).toBe('https://npm.tokensapi.ai/');
        for (const field of ['displayName', 'summary']) {
            const labels = pkg.tokenscowork[field];
            expect(labels['zh-CN'].trim()).not.toBe('');
            expect(labels['en-US'].trim()).not.toBe('');
            expect(labels['en-US']).not.toBe(labels['zh-CN']);
            expect(labels['en-US']).not.toMatch(/[\u3400-\u9fff]/);
        }
        expect(pkg.tokenscowork.summary['zh-CN']).toContain('视觉桥接');
        expect(pkg.tokenscowork.summary['en-US']).toContain('vision bridge');
        expect(pkg.files).toContain('docs');
        const chinese = readFileSync(join(root, 'README.md'), 'utf8');
        const english = readFileSync(join(root, 'docs/README.en-US.md'), 'utf8');
        expect(chinese).toContain('docs/README.en-US.md');
        expect(english).toContain('../README.md');
    });
});
