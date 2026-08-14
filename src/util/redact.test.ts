import { describe, expect, it } from 'vitest';
import { maskUrlCredentials, redactSecrets } from './redact.ts';

describe('redactSecrets', () => {
    it('replaces known secrets exactly, wherever they appear', () => {
        const out = redactSecrets('401 for key my-Secret-Key-9 (my-Secret-Key-9)', [
            'my-Secret-Key-9',
        ]);
        expect(out).not.toContain('my-Secret-Key-9');
        expect(out).toContain('[redacted]');
    });

    it('catches vendor token shapes without knowing the secret', () => {
        const samples = [
            'error: sk-proj-abc123DEF456ghi789jkl was rejected',
            'AIzaSyD-1234567890abcdefghijklmnop denied',
            'push failed for ghp_ABCDEFGHIJKLMNOPQRST123456',
            'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpM',
            'Authorization: Bearer abc.def-ghi_jkl123456789',
            'api_key=verylongsecretvalue123 in query',
        ];
        for (const sample of samples) {
            const out = redactSecrets(sample);
            expect(out).toContain('[redacted]');
        }
        expect(redactSecrets(samples[0])).not.toContain('sk-proj-');
    });

    it('leaves ordinary error text alone', () => {
        const text = 'Gemini API error 429: quota exceeded, retry in 30s (model gemini-3.6-flash)';
        expect(redactSecrets(text)).toBe(text);
    });

    it('ignores empty and too-short known secrets', () => {
        expect(redactSecrets('code ab12 failed', ['ab12', undefined, null, ''])).toBe(
            'code ab12 failed',
        );
    });

    it('strips URL userinfo, the shape proxy URLs leak credentials in', () => {
        const out = redactSecrets(
            'connect ECONNREFUSED via http://alice:s3cr3t@proxy.example:8080',
        );
        expect(out).not.toContain('alice');
        expect(out).not.toContain('s3cr3t');
        expect(out).toContain('http://[redacted]@proxy.example:8080');
    });

    it('masks the whole userinfo when the password itself contains @', () => {
        // WHATWG URLs fold unescaped extra @s into the password; stopping at
        // the first @ used to leak the password's tail ("ss@host").
        const out = redactSecrets('via http://alice:p@ss@proxy.example:8080');
        expect(out).toBe('via http://[redacted]@proxy.example:8080');
    });

    it('never tears scheme-less prose that merely contains //text@', () => {
        const generated = 'TypeError: unexpected token //foo@bar in generated source';
        expect(redactSecrets(generated)).toBe(generated);
        const mention = 'diagnostic: see //owner@example.com for escalation';
        expect(redactSecrets(mention)).toBe(mention);
    });

    it('stops at the authority: an @ inside a query or fragment is content', () => {
        // Greedy-to-last-@ must not cross ? or #, or the real host and query
        // get swallowed and query text impersonates the host.
        expect(redactSecrets('http://alice:secret@proxy.example?contact=owner@example.net')).toBe(
            'http://[redacted]@proxy.example?contact=owner@example.net',
        );
        const noCreds = 'fetch http://example.com?email=owner@example.net failed';
        expect(redactSecrets(noCreds)).toBe(noCreds);
        const fragment = 'see http://example.com#mail=owner@example.net';
        expect(redactSecrets(fragment)).toBe(fragment);
    });
});

describe('maskUrlCredentials', () => {
    it('masks userinfo while keeping the URL recognizable', () => {
        expect(maskUrlCredentials('http://alice:s3cr3t@proxy.example:8080')).toBe(
            'http://***@proxy.example:8080',
        );
        expect(maskUrlCredentials('socks5://bob@10.0.0.1:1080')).toBe('socks5://***@10.0.0.1:1080');
    });

    it('masks up to the last @, so a password containing @ leaves no tail', () => {
        expect(maskUrlCredentials('http://alice:p@ss@proxy.example:8080')).toBe(
            'http://***@proxy.example:8080',
        );
    });

    it('leaves credential-free URLs untouched', () => {
        expect(maskUrlCredentials('http://proxy.example:8080')).toBe('http://proxy.example:8080');
        expect(maskUrlCredentials('http://proxy.example:8080/path@segment')).toBe(
            'http://proxy.example:8080/path@segment',
        );
        expect(maskUrlCredentials('http://proxy.example?contact=owner@example.net')).toBe(
            'http://proxy.example?contact=owner@example.net',
        );
    });
});
