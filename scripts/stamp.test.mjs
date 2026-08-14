import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    docTargets,
    readPackageVersion,
    readStampedVersions,
    repoRoot,
    stampTargets,
} from './stamp.mjs';

/** Every markdown file in the repo, so a new doc cannot escape the check. */
function markdownFiles(root, skip = new Set(['node_modules', '.git', '.issues', 'dist'])) {
    const found = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = join(root, entry.name);
        if (entry.isDirectory()) {
            found.push(...markdownFiles(full, skip));
        } else if (entry.name.endsWith('.md')) {
            found.push(full);
        }
    }
    return found;
}

describe('launcher version stamping', () => {
    it('keeps the launchers and every doc install command pinned to the package version', () => {
        const version = readPackageVersion();
        for (const stamped of readStampedVersions()) {
            expect(stamped.version, `${stamped.name} is not stamped to ${version}`).toBe(version);
        }
    });

    it('pins every install command in the repo rather than leaving it on @latest', () => {
        // @latest resolves against what survives pnpm's release-age filter, so
        // it hands a new reader a version from a day ago. Whatever else the
        // docs say, the command they print has to install the current release.
        // Every markdown file is scanned, not the stamp list: a new doc nobody
        // added to docTargets is exactly where a stale command would hide.
        for (const file of markdownFiles(repoRoot)) {
            // Per command, not per file: troubleshooting carries both a
            // pinned command and the deliberate gate-lifting one, so a
            // file-wide search for the flag would pass a pinned command that
            // had been reverted to @latest. Continuations are joined first,
            // since a command split across lines with a trailing backslash
            // carries its spec and its flags on different lines.
            const content = readFileSync(file, 'utf-8').replace(/\\\n\s*/g, ' ');
            for (const line of content.split('\n')) {
                // The whole spec, up to whitespace or the closing backtick of
                // a command quoted in prose: a partial read would accept
                // `3.16.4+local` by matching only the part that looks pinned.
                const install = line.match(/add @liustack\/modlens(@[^\s`'")]*)?/);
                if (install === null) {
                    continue;
                }
                const spec = (install[1] ?? '').slice(1);
                const lifted = line.includes('--config.minimumReleaseAge=0');
                expect(
                    /^\d+\.\d+\.\d+$/.test(spec) || lifted,
                    `${file}: "${line.trim()}" installs whatever survived the release-age gate`,
                ).toBe(true);
            }
        }
    });

    it('rewrites only the version value and leaves the line shape intact', () => {
        for (const target of [
            ...stampTargets('/base', '@scope/pkg'),
            ...docTargets('/base', '@scope/pkg'),
        ]) {
            const original = target.format('0.0.0');
            const restamped = original.replace(target.pattern, target.format('9.9.9'));
            expect(restamped).toBe(target.format('9.9.9'));
            expect(restamped).not.toBe(original);
        }
    });
});
