import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    docTargets,
    readPackageVersion,
    readStampedVersions,
    repoRoot,
    stampTargets,
} from './stamp.mjs';

describe('launcher version stamping', () => {
    it('keeps the launchers and every doc install command pinned to the package version', () => {
        const version = readPackageVersion();
        for (const stamped of readStampedVersions()) {
            expect(stamped.version, `${stamped.name} is not stamped to ${version}`).toBe(version);
        }
    });

    it('pins the install commands rather than leaving them on @latest', () => {
        // @latest resolves against what survives pnpm's release-age filter, so
        // it hands a new reader a version from a day ago. Whatever else the
        // docs say, the command they print has to install the current release.
        for (const target of docTargets(repoRoot, '@liustack/modlens')) {
            // Per command, not per file: troubleshooting carries both a
            // pinned command and the deliberate gate-lifting one, so a
            // file-wide search for the flag would pass a pinned command that
            // had been reverted to @latest.
            for (const line of readFileSync(target.file, 'utf-8').split('\n')) {
                // The spec stops at the first character that cannot be part
                // of one, since these commands sit inside prose and code
                // fences (a trailing backtick is not part of the version).
                const install = line.match(/add @liustack\/modlens@([\w.-]+)/);
                if (install === null) {
                    continue;
                }
                const spec = install[1];
                const lifted = line.includes('--config.minimumReleaseAge=0');
                expect(
                    /^\d+\.\d+\.\d+$/.test(spec) || lifted,
                    `${target.file}: "${line.trim()}" installs whatever survived the release-age gate`,
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
