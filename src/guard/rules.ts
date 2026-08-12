// Guard rules: decide whether the vision engine may fire for the active model.
//
// The deny list holds glob patterns of model names that already have native
// vision. Matching is anchored and case-insensitive, with * and ? as the only
// wildcards: model ids are full of regex metacharacters (gpt-5.6, provider/model),
// so everything else is literal. An unknown model falls open by default: a
// wrongly blocked read breaks the text-only bridge this tool exists for, while
// a wrongly allowed one only wastes a single provider call.

export interface GuardsConfig {
    /** Glob patterns of models with native vision: match means never run the engine. */
    denyModels?: string[];
    /** Deny when the active model cannot be determined (default: proceed). */
    denyWhenUnknown?: boolean;
}

/** Where the active-model verdict came from, strongest signal first. */
export type ModelSource = 'env' | 'storage' | 'self-report' | 'none';

export interface ModelDetection {
    model: string | null;
    provider?: string;
    source: ModelSource;
    /** Harness whose storage was sniffed, when that is where the model came from. */
    harness?: string | null;
    /** A --model self-report kept for the record when storage evidence outranked it. */
    selfReported?: string;
}

/** The detection it judged plus the verdict, so callers see both in one object. */
export interface GuardVerdict extends ModelDetection {
    guard: 'allow' | 'deny';
    /** The deny pattern that matched, on deny by match. */
    matched?: string;
    reason: string;
}

/**
 * The config file is hand-editable and unvalidated on load, so take only what
 * actually looks like patterns: a non-array (say a bare string) or non-string
 * elements are ignored rather than iterated or thrown on mid-read.
 */
export function denyPatterns(guards: GuardsConfig | undefined): string[] {
    const raw = guards?.denyModels;
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((pattern): pattern is string => typeof pattern === 'string');
}

export function globMatch(pattern: string, value: string): boolean {
    const regex = pattern
        .split(/([*?])/)
        .map((part) => {
            if (part === '*') {
                return '.*';
            }
            if (part === '?') {
                return '.';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
    return new RegExp(`^${regex}$`, 'i').test(value);
}

export function evaluateGuard(
    guards: GuardsConfig | undefined,
    detection: ModelDetection,
): GuardVerdict {
    const patterns = denyPatterns(guards);
    if (!detection.model) {
        // Strict === true: the file is hand-editable and a string "false" is
        // truthy, which would flip fail-open into a deny.
        if (guards?.denyWhenUnknown === true) {
            return {
                ...detection,
                guard: 'deny',
                reason: 'model unknown and denyWhenUnknown is set',
            };
        }
        return {
            ...detection,
            guard: 'allow',
            reason:
                patterns.length === 0 ? 'no deny rules configured' : 'model unknown, failing open',
        };
    }
    if (patterns.length === 0) {
        return { ...detection, guard: 'allow', reason: 'no deny rules configured' };
    }
    const candidates = [detection.model];
    if (detection.provider) {
        candidates.push(`${detection.provider}/${detection.model}`);
    }
    for (const pattern of patterns) {
        if (candidates.some((candidate) => globMatch(pattern, candidate))) {
            return {
                ...detection,
                guard: 'deny',
                matched: pattern,
                reason: 'model has native vision per guards.denyModels',
            };
        }
    }
    return { ...detection, guard: 'allow', reason: 'not on the deny list' };
}
