import { describe, expect, it } from 'vitest';
import {
    type JsonSchemaNode,
    missingSchemaFields,
    schemaViolations,
    strictSchema,
    VISION_RESULT_SCHEMA,
    visionResponseFormat,
} from './schema.ts';

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

    it('accepts null on a field the schema does not require', () => {
        // A model with nothing to note writes null, and leaving the field out
        // was already fine, so rejecting null cost a whole read over an empty
        // list (issue #37).
        const quiet = structuredClone(VALID) as Record<string, unknown>;
        (quiet.visual as Record<string, unknown>).notes = null;
        (quiet.visual as Record<string, unknown>).style = null;
        expect(missingSchemaFields(quiet)).toEqual([]);
    });

    it('still refuses null where the contract requires a value', () => {
        const empty = structuredClone(VALID) as Record<string, unknown>;
        empty.visual = null;
        expect(missingSchemaFields(empty)).toEqual(['visual']);
        const noText = structuredClone(VALID);
        noText.ocr.lines[0].text = null as unknown as string;
        expect(missingSchemaFields(noText)).toContain('ocr.lines[0].text');
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

describe('strict schema for structured output (#37)', () => {
    it('requires every property and makes the optional ones nullable', () => {
        const schema = strictSchema(VISION_RESULT_SCHEMA as JsonSchemaNode);
        // Strict mode has no optional properties: everything is required, and
        // what this contract does not require becomes nullable instead.
        expect(schema.required).toEqual(Object.keys(schema.properties ?? {}));
        expect(schema.additionalProperties).toBe(false);
        const visual = schema.properties?.visual;
        expect(visual?.required).toEqual(['dominant_colors', 'style', 'notes']);
        expect(visual?.properties?.notes?.anyOf?.[1]).toEqual({ type: 'null' });
        // A required one keeps its plain shape.
        expect(schema.properties?.summary).toEqual({ type: 'string' });
    });

    it('carries the same fields as the contract it is derived from', () => {
        // Derived, not written out, so a field added to one cannot go missing
        // from the other.
        const schema = strictSchema(VISION_RESULT_SCHEMA as JsonSchemaNode);
        expect(Object.keys(schema.properties ?? {})).toEqual(
            Object.keys(VISION_RESULT_SCHEMA.properties),
        );
        const format = visionResponseFormat() as {
            type: string;
            json_schema: { name: string; strict: boolean; schema: JsonSchemaNode };
        };
        expect(format.type).toBe('json_schema');
        expect(format.json_schema.strict).toBe(true);
        expect(format.json_schema.schema).toEqual(schema);
    });

    it('descends into array items', () => {
        const schema = strictSchema(VISION_RESULT_SCHEMA as JsonSchemaNode);
        const line = schema.properties?.ocr?.properties?.lines?.items;
        expect(line?.additionalProperties).toBe(false);
        expect(line?.properties?.language?.anyOf?.[1]).toEqual({ type: 'null' });
        expect(line?.properties?.text).toEqual({ type: 'string' });
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
