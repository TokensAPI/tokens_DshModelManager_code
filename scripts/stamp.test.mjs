import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    docTargets,
    readPackageVersion,
    readStampedVersions,
    repoRoot,
    stampTargets,
    unpinnedInstalls,
} from './stamp.mjs';

// Every file git tracks. An extension allowlist is a losing game: a stale
// install command reads the same in a .mdx, an .adoc, or a JSON manifest, and
// the file type that gets added next is the one nobody updated the list for.
// Binary blobs are skipped by extension, since only those can be misread.
const BINARY = /\.(png|jpe?g|gif|webp|heic|heif|ico|pdf|zip|gz|woff2?|ttf)$/i;

function trackedFiles(root) {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf-8' })
        .split('\0')
        .filter((name) => name !== '' && !BINARY.test(name))
        .map((name) => join(root, name));
}

describe('launcher version stamping', () => {
    it('keeps the launchers and every doc install command pinned to the package version', () => {
        const version = readPackageVersion();
        for (const stamped of readStampedVersions()) {
            expect(stamped.version, `${stamped.name} is not stamped to ${version}`).toBe(version);
        }
    });

    it('pins every install command in every tracked file', () => {
        const offenders = [];
        for (const file of trackedFiles(repoRoot)) {
            // This file's own table of bad forms is the fixture below, not a
            // command anyone would run.
            if (file.endsWith('stamp.test.mjs')) continue;
            for (const command of unpinnedInstalls(readFileSync(file, 'utf-8'))) {
                offenders.push(`${file}: ${command}`);
            }
        }
        expect(offenders, 'these install whatever survived the release-age gate').toEqual([]);
    });

    it('recognizes every shape of an unpinned install', () => {
        // The rules themselves, pinned. Reviewing this check by hand is how
        // five different ways of writing an unpinned install got past it.
        const unpinned = [
            'add @liustack/modlens@latest',
            "add '@liustack/modlens@latest'",
            'add "@liustack/modlens@latest"',
            'add  @liustack/modlens@latest',
            'add @liustack/modlens',
            'add @liustack/modlens@^3.16.0',
            'add @liustack/modlens@next',
            'add @liustack/modlens@3',
            'add @liustack/modlens@3.16.4+local',
            'add @liustack/modlens@$VERSION',
            // Two commands on one row: the flag belongs to the first.
            'add @liustack/modlens@1.2.3 --config.minimumReleaseAge=0 | add @liustack/modlens@latest',
            'dsh plugin \\\n  add @liustack/modlens@latest',
        ];
        for (const command of unpinned) {
            expect(unpinnedInstalls(command), command).not.toEqual([]);
        }
        const fine = [
            'add @liustack/modlens@1.2.3',
            'add @liustack/modlens@latest --config.minimumReleaseAge=0',
            'npx --yes --package @liustack/modlens@1.2.3 modlens',
            'the `@latest` tag does not skip the gate',
        ];
        for (const command of fine) {
            expect(unpinnedInstalls(command), command).toEqual([]);
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
