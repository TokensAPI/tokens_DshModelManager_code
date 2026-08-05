// JSON schema enforced on the provider via structured output.
// Fields that vision models tend to fabricate (pixel bboxes, numeric
// confidence) are intentionally excluded.
export const VISION_RESULT_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        ocr: {
            type: 'object',
            properties: {
                full_text: { type: 'string' },
                lines: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            text: { type: 'string' },
                            language: { type: 'string' },
                        },
                        required: ['text'],
                    },
                },
            },
            required: ['full_text', 'lines'],
        },
        layout: {
            type: 'object',
            properties: {
                regions: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            type: {
                                type: 'string',
                                enum: [
                                    'title',
                                    'subtitle',
                                    'paragraph',
                                    'list',
                                    'table',
                                    'chart',
                                    'form',
                                    'code',
                                    'image',
                                    'icon',
                                    'other',
                                ],
                            },
                            reading_order: { type: 'number' },
                            text: { type: 'string' },
                        },
                        required: ['type', 'reading_order', 'text'],
                    },
                },
            },
            required: ['regions'],
        },
        semantics: {
            type: 'object',
            properties: {
                scene: { type: 'string' },
                intent: { type: 'string' },
                entities: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            type: { type: 'string' },
                            evidence: { type: 'string' },
                        },
                        required: ['name', 'type'],
                    },
                },
                relations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            subject: { type: 'string' },
                            predicate: { type: 'string' },
                            object: { type: 'string' },
                        },
                        required: ['subject', 'predicate', 'object'],
                    },
                },
            },
            required: ['scene', 'entities'],
        },
        visual: {
            type: 'object',
            properties: {
                dominant_colors: { type: 'array', items: { type: 'string' } },
                style: { type: 'string' },
                notes: { type: 'array', items: { type: 'string' } },
            },
        },
        uncertainty: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'ocr', 'layout', 'semantics', 'uncertainty'],
} as const;

export function visionResultSchemaJson(): string {
    return JSON.stringify(VISION_RESULT_SCHEMA);
}

/**
 * Required fields the vision contract promises, nested ones included. Returns
 * the paths that are absent or the wrong type.
 *
 * Server-side schema enforcement only covers some routes (gemini responseSchema,
 * anthropic tool input_schema, agy/claude-cli --json-schema), and even those can
 * hand back a shell that only looks right. This is the portable check the
 * analyzer runs over every provider's result, so a structurally broken payload
 * fails loudly instead of reaching the caller as if it were evidence.
 */
export function missingSchemaFields(result: unknown): string[] {
    const missing: string[] = [];
    const root = (result ?? {}) as Record<string, unknown>;
    const child = (key: string) =>
        (root[key] && typeof root[key] === 'object' ? root[key] : {}) as Record<string, unknown>;

    const expect = (path: string, ok: boolean) => {
        if (!ok) {
            missing.push(path);
        }
    };

    expect('summary', typeof root.summary === 'string');
    expect('ocr', typeof root.ocr === 'object' && root.ocr !== null);
    expect('ocr.full_text', typeof child('ocr').full_text === 'string');
    expect('ocr.lines', Array.isArray(child('ocr').lines));
    expect('layout', typeof root.layout === 'object' && root.layout !== null);
    expect('layout.regions', Array.isArray(child('layout').regions));
    expect('semantics', typeof root.semantics === 'object' && root.semantics !== null);
    expect('semantics.scene', typeof child('semantics').scene === 'string');
    expect('semantics.entities', Array.isArray(child('semantics').entities));
    expect('visual', typeof root.visual === 'object' && root.visual !== null);
    expect('uncertainty', Array.isArray(root.uncertainty));

    return missing;
}
