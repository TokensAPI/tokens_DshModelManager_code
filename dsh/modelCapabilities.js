// One fallback table for every part of this package that must classify a
// model when its provider does not publish structured input modalities.
// Provider metadata remains authoritative; this table is used only when the
// model catalog omits `input` / `input_modalities` entirely.
export const BUILTIN_VISION_MODEL_PATTERNS = Object.freeze([
  'claude-*',
  'gpt-4o*',
  'gpt-4.1*',
  'gpt-5*',
  'o3*',
  'o4*',
  'gemini-*',
  'glm-*v*',
  'qwen*-vl*',
  'qwen3.5-plus*',
  'qwen3.6-plus*',
  'qwen3.6-35b-a3b*',
  'kimi-k2.5*',
  'kimi-k2.6*',
  'kimi-k2.7*',
  'kimi-k3*',
  'moonshot-v1-*vision*',
  'minimax-vl*',
  'minimax-m3*',
  'deepseek-vl*',
  'deepseek-ocr*',
  'janus*',
  'pixtral*',
  'llama-4*',
  'llama-3.2-*vision*',
  'grok-4*',
  'grok-2-vision*',
  'internvl*',
])

// Text-only product routes that are verified even though the current
// TokensAPI catalog does not publish input modalities. Keep this list narrow:
// an unlisted future model becomes `unknown` and must be confirmed explicitly
// instead of being silently sent through the vision bridge.
export const BUILTIN_TEXT_MODEL_PATTERNS = Object.freeze([
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-v3.2',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'glm-5.2',
])

function globMatch(pattern, value) {
  const regex = pattern
    .split(/([*?])/)
    .map((part) => {
      if (part === '*') return '.*'
      if (part === '?') return '.'
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${regex}$`, 'i').test(value)
}

/** Match provider-prefixed and bare model ids against the shared fallback. */
export function isBuiltinVisionModel(modelId) {
  const normalized = String(modelId ?? '').trim()
  const bare = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized
  return BUILTIN_VISION_MODEL_PATTERNS.some((pattern) => globMatch(pattern, bare))
}

/** Return a verified fallback mode, or `unknown` when names are insufficient. */
export function builtinModelVisionMode(modelId) {
  const normalized = String(modelId ?? '').trim()
  const bare = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized
  if (BUILTIN_VISION_MODEL_PATTERNS.some((pattern) => globMatch(pattern, bare))) return 'native'
  if (BUILTIN_TEXT_MODEL_PATTERNS.some((pattern) => globMatch(pattern, bare))) return 'bridge'
  return 'unknown'
}
