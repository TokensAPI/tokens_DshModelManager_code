// Errors are the one place credentials love to travel: subprocess stderr,
// gateway error bodies, and probe failures all get quoted into messages that
// end up in terminals, meta.attempts, model contexts, and the discovery
// cache. Everything quoted into an error goes through here first.

/**
 * Token shapes worth catching even when the concrete secret is unknown.
 * Erring toward redacting too much: an over-redacted error stays actionable,
 * a leaked key does not.
 */
const TOKEN_SHAPES: RegExp[] = [
    // Vendor-prefixed keys (OpenAI/Anthropic sk-, Stripe rk/pk, Slack xox*).
    /\b(?:sk|rk|pk|xox[a-z])-[A-Za-z0-9_-]{12,}\b/g,
    // Google API keys.
    /\bAIza[A-Za-z0-9_-]{20,}\b/g,
    // GitHub tokens.
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    // JWTs (three base64url segments, the first spelling {"alg" or {"typ").
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    // Auth headers: "Bearer xyz" / "Authorization: xyz" (space form is real).
    /\b(?:bearer|authorization)\b[=:\s]+"?[A-Za-z0-9._~+/-]{12,}"?/gi,
    // Labeled keys need an explicit = or : separator; prose like
    // "token limit_exceeded" is diagnostics, not a credential.
    /\b(?:token|api[-_]?key)\b\s*[=:]\s*"?[A-Za-z0-9._~+/-]{12,}"?/gi,
];

/**
 * Strip likely credentials from text about to travel into an error message,
 * a cache file, or a model context. Known secrets are replaced exactly first,
 * then the shape patterns run as the second net.
 */
export function redactSecrets(
    text: string,
    knownSecrets: ReadonlyArray<string | undefined | null> = [],
): string {
    let out = text;
    for (const secret of knownSecrets) {
        // Very short strings would tear unrelated text; real keys are longer.
        if (secret && secret.length >= 6) {
            out = out.split(secret).join('[redacted]');
        }
    }
    for (const shape of TOKEN_SHAPES) {
        out = out.replace(shape, '[redacted]');
    }
    return out;
}
