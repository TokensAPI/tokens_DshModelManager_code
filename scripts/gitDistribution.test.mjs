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
});
