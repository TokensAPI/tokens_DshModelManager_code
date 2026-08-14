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
        expect(out).toContain('proxy.example:8080');
    });
});

describe('maskUrlCredentials', () => {
    it('masks userinfo while keeping the URL recognizable', () => {
        expect(maskUrlCredentials('http://alice:s3cr3t@proxy.example:8080')).toBe(
            'http://***@proxy.example:8080',
        );
        expect(maskUrlCredentials('socks5://bob@10.0.0.1:1080')).toBe('socks5://***@10.0.0.1:1080');
    });

    it('leaves credential-free URLs untouched', () => {
        expect(maskUrlCredentials('http://proxy.example:8080')).toBe('http://proxy.example:8080');
    });
});
