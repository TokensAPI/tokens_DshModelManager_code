import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { captureSnapshot, dropSnapshots, readSnapshot, storeEvidence } from './index.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 9, 9]);

function tempStore(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'modlens-clip-test-'));
}

const pngCapture = () => ({
    kind: 'png' as const,
    base64: PNG.toString('base64'),
    revisionBefore: 7,
    revisionAfter: 7,
});

describe('clipboard snapshots', () => {
    it('captures a png into an immutable snapshot and serves it back by id', () => {
        const storeDir = tempStore();
        const { meta, imagePath, dir } = captureSnapshot({ storeDir, runCapture: pngCapture });
        expect(meta.sha256).toHaveLength(64);
        expect(meta.sourceMime).toBe('image/png');
        expect(meta.normalizedMime).toBe('image/png');
        expect(meta.revision).toBe(7);
        expect(fs.readFileSync(imagePath)).toEqual(PNG);
        storeEvidence(dir, { result: { summary: 'S' } });
        const { meta: again, evidence } = readSnapshot(meta.snapshotId, { storeDir });
        expect(again.sha256).toBe(meta.sha256);
        expect((evidence as { result: { summary: string } }).result.summary).toBe('S');
        expect(dropSnapshots(meta.snapshotId, { storeDir })).toBe(1);
        expect(() => readSnapshot(meta.snapshotId, { storeDir })).toThrow(
            /CLIPBOARD_SNAPSHOT_EXPIRED/,
        );
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('discards torn reads and reports a race after bounded retries', () => {
        const storeDir = tempStore();
        let calls = 0;
        expect(() =>
            captureSnapshot({
                storeDir,
                runCapture: () => {
                    calls += 1;
                    return { ...pngCapture(), revisionAfter: 8 };
                },
            }),
        ).toThrow(/CLIPBOARD_CAPTURE_RACE/);
        expect(calls).toBe(3);
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('refuses empty, multi-item, oversized, and non-image-file clipboards distinctly', () => {
        const storeDir = tempStore();
        expect(() =>
            captureSnapshot({ storeDir, runCapture: () => ({ kind: 'none' as const }) }),
        ).toThrow(/CLIPBOARD_NO_IMAGE/);
        expect(() =>
            captureSnapshot({ storeDir, runCapture: () => ({ kind: 'multi' as const, count: 3 }) }),
        ).toThrow(/CLIPBOARD_MULTIPLE_IMAGES/);
        expect(() => captureSnapshot({ storeDir, runCapture: pngCapture, maxBytes: 4 })).toThrow(
            /CLIPBOARD_TOO_LARGE/,
        );
        const sourceDir = tempStore();
        const textFile = path.join(sourceDir, 'note.txt');
        fs.writeFileSync(textFile, 'plain text');
        expect(() =>
            captureSnapshot({
                storeDir,
                runCapture: () => ({ kind: 'file' as const, path: textFile }),
            }),
        ).toThrow(/CLIPBOARD_FILE_NOT_IMAGE/);
        fs.rmSync(sourceDir, { recursive: true, force: true });
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('normalizes tiff after the race window and reports both hashes', () => {
        const storeDir = tempStore();
        const { meta, imagePath } = captureSnapshot({
            storeDir,
            runCapture: () => ({
                kind: 'tiff' as const,
                base64: TIFF.toString('base64'),
                revisionBefore: 1,
                revisionAfter: 1,
            }),
            convertTiff: (_from, to) => fs.writeFileSync(to, PNG),
        });
        expect(meta.sourceMime).toBe('image/tiff');
        expect(meta.normalizedMime).toBe('image/png');
        expect(meta.normalizedSha256).toBeDefined();
        expect(meta.normalizedSha256).not.toBe(meta.sha256);
        expect(imagePath.endsWith('normalized.png')).toBe(true);
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('accepts a copied image file after magic-byte validation', () => {
        const storeDir = tempStore();
        const sourceDir = tempStore();
        const jpeg = path.join(sourceDir, 'photo.jpg');
        fs.writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6]));
        const { meta } = captureSnapshot({
            storeDir,
            runCapture: () => ({ kind: 'file' as const, path: jpeg }),
        });
        expect(meta.sourceMime).toBe('image/jpeg');
        fs.rmSync(sourceDir, { recursive: true, force: true });
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('never sweeps a fresh meta-less dir (a capture mid-write), only stale ones', () => {
        const storeDir = tempStore();
        const fresh = path.join(storeDir, 'a'.repeat(32));
        const stale = path.join(storeDir, 'b'.repeat(32));
        fs.mkdirSync(fresh);
        fs.mkdirSync(stale);
        const old = new Date(Date.now() - 11 * 60 * 1000);
        fs.utimesSync(stale, old, old);
        captureSnapshot({ storeDir, runCapture: pngCapture });
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(stale)).toBe(false);
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it('sweeps expired snapshots lazily', () => {
        const storeDir = tempStore();
        const { meta } = captureSnapshot({ storeDir, runCapture: pngCapture, ttlMs: -1 });
        expect(() => readSnapshot(meta.snapshotId, { storeDir })).toThrow(
            /CLIPBOARD_SNAPSHOT_EXPIRED/,
        );
        fs.rmSync(storeDir, { recursive: true, force: true });
    });
});
