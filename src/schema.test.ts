import { describe, expect, it } from 'vitest';
import { missingSchemaFields, schemaViolations, VISION_RESULT_SCHEMA } from './schema.ts';

const VALID = {
    summary: 'a tweet screenshot',
    ocr: { full_text: 'hello', lines: [{ text: 'hello', language: 'en' }] },
    layout: { regions: [{ type: 'paragraph', reading_order: 1, text: 'hello' }] },
    semantics: {
        scene: 'social media',
        entities: [{ name: 'hello', type: 'text' }],
        relations: [{ subject: 'a', predicate: 'is', object: 'b' }],
    },
    visual: { dominant_colors: ['#fff'], style: 'flat', notes: ['clean'] },
    uncertainty: ['small text unreadable'],
};

describe('missingSchemaFields', () => {
    it('accepts a fully valid result', () => {
        expect(missingSchemaFields(VALID)).toEqual([]);
    });

    it('checks array elements, not just array existence', () => {
        // These exact shells used to pass when only Array.isArray was checked.
        const broken = structuredClone(VALID) as Record<string, unknown>;
        (broken.ocr as { lines: unknown }).lines = [42];
        (broken.uncertainty as unknown[]) = [1, 2];
        const missing = missingSchemaFields(broken);
        expect(missing).toContain('ocr.lines[0]');
        expect(missing).toContain('uncertainty[0]');
        expect(missing).toContain('uncertainty[1]');
    });

    it('checks field types inside array elements', () => {
        const broken = structuredClone(VALID);
        broken.layout.regions[0].reading_order = 'first' as unknown as number;
        expect(missingSchemaFields(broken)).toContain('layout.regions[0].reading_order');
    });

    it('accepts a region kind outside the common vocabulary', () => {
        // Region kinds are an open set: a closed list rejected `link` on any
        // web screenshot, and a rejected result fails the whole read over a
        // descriptive label (issue #34).
        const open = structuredClone(VALID);
        open.layout.regions[0].type = 'link';
        expect(missingSchemaFields(open)).toEqual([]);
        open.layout.regions[0].type = 'search';
        expect(missingSchemaFields(open)).toEqual([]);
    });

    it('carries the region vocabulary in the schema, not only in the prompt template', () => {
        // Dropping the enum also dropped the only hint those kinds existed.
        // The description restores it for gemini, anthropic, agy, and
        // claude-cli, which send this schema and not the JSON template.
        const kind =
            VISION_RESULT_SCHEMA.properties.layout.properties.regions.items.properties.type;
        expect(kind.description).toContain('paragraph');
        expect(kind.description).toContain('link');
        expect(kind).not.toHaveProperty('enum');
    });

    it('still enforces an enum wherever one is declared', () => {
        // The vision schema declares none, so this pins the machinery
        // directly: a future enum must not pass unchecked.
        const schema = {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['a', 'b'] } },
            required: ['kind'],
        } as const;
        expect(schemaViolations(schema, { kind: 'a' }, '')).toEqual([]);
        expect(schemaViolations(schema, { kind: 'z' }, '')).toContain('kind');
    });

    it('validates optional fields when they are present', () => {
        const broken = structuredClone(VALID) as Record<string, unknown>;
        (broken.visual as Record<string, unknown>).dominant_colors = 'red';
        expect(missingSchemaFields(broken)).toContain('visual.dominant_colors');
    });

    it('reports required fields that are missing entirely', () => {
        expect(missingSchemaFields({ summary: 'only this' })).toEqual([
            'ocr',
            'layout',
            'semantics',
            'visual',
            'uncertainty',
        ]);
        expect(missingSchemaFields(null)).toEqual(['(root)']);
    });

    it('stays in step with the provider schema: every runtime requirement is declared there', () => {
        // One source of truth: the walk reads VISION_RESULT_SCHEMA directly, so
        // this asserts the schema itself still requires what the docs promise.
        expect([...VISION_RESULT_SCHEMA.required]).toEqual([
            'summary',
            'ocr',
            'layout',
            'semantics',
            'visual',
            'uncertainty',
        ]);
    });
});

describe('docs contract', () => {
    it('output-schema.md lists exactly the required fields the schema enforces', () => {
        const fs = require('fs');
        const path = require('path');
        const doc = fs.readFileSync(
            path.join(__dirname, '..', 'docs', 'output-schema.md'),
            'utf-8',
        ) as string;
        const line = doc.split('\n').find((l: string) => l.startsWith('Required fields:'));
        expect(line).toBeDefined();
        for (const field of VISION_RESULT_SCHEMA.required) {
            expect(line).toContain(`\`${field}\``);
        }
        // And nothing is called optional that the schema requires.
        expect(line).not.toMatch(/`visual` is optional/);
    });
});
