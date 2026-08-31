export const BUILTIN_VISION_MODEL_PATTERNS: readonly string[];
export const BUILTIN_TEXT_MODEL_PATTERNS: readonly string[];

export function isBuiltinVisionModel(modelId: unknown): boolean;
export function builtinModelVisionMode(modelId: unknown): 'native' | 'bridge' | 'unknown';
