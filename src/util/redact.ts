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
    // Labeled keys need an explicit = or : separator. Prose like
    // "token limit_exceeded" is diagnostics, not a credential.
    /\b(?:token|api[-_]?key)\b\s*[=:]\s*"?[A-Za-z0-9._~+/-]{12,}"?/gi,
];

/**
 * A substring that might be a URL: a scheme followed by two slashes in either
 * direction. Backslashes included on purpose, because WHATWG treats them as
 * slashes for the special schemes, so `http:\\user:pass@host` is a URL the
 * runtime happily connects through. Tabs may appear inside (the parser strips
 * them), so the token runs to a space or line break, not to any whitespace.
 */
const URL_CANDIDATE = /\b[a-z][a-z0-9+.-]*:[\\/]{2}[^ \n\r]*/gi;

/** The last-resort regex mask for a candidate the URL parser refuses. */
const RAW_USERINFO = /^([a-z][a-z0-9+.-]*:[\\/]{2})[^\s/?#]*@/i;

/**
 * Rebuild a URL with its userinfo replaced, through the SAME parser the
 * runtime connects with (WHATWG). A regex kept losing to shapes the parser
 * accepts: backslash authorities (`http:\\u:p@h`), slash runs
 * (`http:////u:p@h`), tabs and newlines stripped inside the authority, and
 * backslash paths that relocate the visible host. Parsing first means
 * whatever undici's ProxyAgent would read as credentials is exactly what
 * gets masked, in normalized form. Returns null when the candidate is not a
 * parseable URL or carries no credentials.
 */
function maskParsedUrl(candidate: string, replacement: string): string | null {
    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        return null;
    }
    if (url.username === '' && url.password === '') {
        return null;
    }
    // Rebuilt by hand: the URL serializer percent-encodes characters like
    // brackets in the username, which would garble "[redacted]".
    return `${url.protocol}//${replacement}@${url.host}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Mask userinfo in a URL while keeping it recognizable:
 * http://alice:s3cr3t@proxy:8080 -> http://***@proxy:8080/ (re-serialized in
 * normalized form). For display surfaces (config show) whose whole point is
 * being safe to paste into an issue. redactSecrets is the blunter net for
 * error text. A credential-free URL passes through untouched.
 */
export function maskUrlCredentials(url: string): string {
    return maskParsedUrl(url, '***') ?? url.replace(RAW_USERINFO, '$1***@');
}

/**
 * Strip likely credentials from text about to travel into an error message,
 * a cache file, or a model context. Known secrets are replaced exactly first,
 * then the shape patterns run as the second net, then every URL-shaped token
 * is checked for userinfo through the real parser.
 */
export function redactSecrets(
    text: string,
    knownSecrets: ReadonlyArray<string | undefined | null> = [],
): string {
    let out = text;
    for (const secret of knownSecrets) {
        // Very short strings would tear unrelated text: real keys are longer.
        if (secret && secret.length >= 6) {
            out = out.split(secret).join('[redacted]');
        }
    }
    for (const shape of TOKEN_SHAPES) {
        out = out.replace(shape, '[redacted]');
    }
    // Each URL-shaped token is masked only when the parser confirms it
    // carries credentials, so scheme-less `//text@` prose and ordinary URLs
    // (query @s included) stay verbatim, while every shape the runtime would
    // read credentials out of gets them removed.
    out = out.replace(
        URL_CANDIDATE,
        (token) =>
            maskParsedUrl(token, '[redacted]') ?? token.replace(RAW_USERINFO, '$1[redacted]@'),
    );
    return out;
}
