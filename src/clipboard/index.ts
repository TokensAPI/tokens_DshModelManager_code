// Clipboard capture as a two-phase immutable-snapshot protocol (spec:
// .issues/2026-08-13-clipboard). Phase one captures the clipboard exactly
// once in a single platform process and freezes bytes + evidence into a
// private snapshot; phase two consumes only the snapshot by its unguessable
// id and never re-reads the clipboard. The clipboard itself is a global
// single slot with no transactions, so every guarantee this module makes is
// anchored to the snapshot, not to the slot.
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Machine-readable failure identifiers, stable across releases. */
export type ClipboardErrorCode =
    | 'CLIPBOARD_NO_IMAGE'
    | 'CLIPBOARD_MULTIPLE_IMAGES'
    | 'CLIPBOARD_UNSUPPORTED_TYPE'
    | 'CLIPBOARD_FILE_NOT_IMAGE'
    | 'CLIPBOARD_SNAPSHOT_EXPIRED'
    | 'CLIPBOARD_CAPTURE_RACE'
    | 'CLIPBOARD_TOOL_MISSING'
    | 'CLIPBOARD_TOO_LARGE';

export class ClipboardError extends Error {
    constructor(
        readonly code: ClipboardErrorCode,
        message: string,
    ) {
        super(`${code}: ${message}`);
    }
}

/** What one platform capture attempt saw, before any policy is applied. */
interface RawCapture {
    kind: 'png' | 'tiff' | 'file' | 'none' | 'multi' | 'race';
    base64?: string;
    path?: string;
    count?: number;
    revisionBefore?: number;
    revisionAfter?: number;
}

export interface ClipboardSnapshotMeta {
    snapshotId: string;
    sha256: string;
    normalizedSha256?: string;
    bytes: number;
    sourceMime: string;
    normalizedMime: string;
    createdAt: string;
    expiresAt: string;
    revision?: number;
}

export interface CaptureOptions {
    /** Snapshot store root, default <tmpdir>/modlens-clip. */
    storeDir?: string;
    /** Snapshot lifetime, default 30 minutes. */
    ttlMs?: number;
    /** Raw-byte ceiling, default 25 MB (matches the inline image cap). */
    maxBytes?: number;
    /** Injectable platform capture for tests. */
    runCapture?: () => RawCapture;
    /** Injectable TIFF->PNG converter for tests (macOS uses sips). */
    convertTiff?: (from: string, to: string) => void;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const CAPTURE_RETRIES = 3;
// How long a meta-less snapshot dir may sit before the sweeper treats it as
// crashed-capture garbage rather than a capture still writing its files.
const STALE_GRACE_MS = 10 * 60 * 1000;

const MAGIC: Array<{ mime: string; ext: string; bytes: number[] }> = [
    { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/gif', ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
    { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
    { mime: 'image/tiff', ext: 'tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
    { mime: 'image/tiff', ext: 'tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
];

function sniffMime(buffer: Buffer): { mime: string; ext: string } | null {
    for (const magic of MAGIC) {
        if (magic.bytes.every((byte, index) => buffer[index] === byte)) {
            return { mime: magic.mime, ext: magic.ext };
        }
    }
    return null;
}

// One process, one transaction-shaped read: revision before, enumerate, take
// the bytes, revision after. A mismatch means the slot changed mid-read and
// the attempt is discarded, never hashed. PNG is preferred raw, TIFF rides as
// TIFF (normalized later, outside the race window), a lone file URL is
// reported as a path for the caller to validate, and multiple pasteboard
// items are refused rather than silently taking the first.
const MAC_JXA = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const before = Number(pb.changeCount);
const items = pb.pasteboardItems;
const count = items ? Number(items.count) : 0;
let out = { kind: 'none', revisionBefore: before };
if (count > 1) {
  out = { kind: 'multi', count: count, revisionBefore: before };
} else if (count === 1) {
  // String UTIs, not $.NSPasteboardType* constants: the bridge leaves some
  // AppKit string constants undefined, and dataForType(undefined) throws.
  // NSData has no .js bridge either, so nil-ness is asked via isNil() alone.
  const png = pb.dataForType('public.png');
  const tiff = pb.dataForType('public.tiff');
  const fileUrl = pb.propertyListForType('public.file-url');
  if (png && !png.isNil()) {
    out = { kind: 'png', base64: png.base64EncodedStringWithOptions(0).js, revisionBefore: before };
  } else if (tiff && !tiff.isNil()) {
    out = { kind: 'tiff', base64: tiff.base64EncodedStringWithOptions(0).js, revisionBefore: before };
  } else if (fileUrl && !fileUrl.isNil()) {
    out = { kind: 'file', path: $.NSURL.URLWithString(fileUrl).path.js, revisionBefore: before };
  }
}
out.revisionAfter = Number(pb.changeCount);
JSON.stringify(out);
`;

function defaultRunCapture(): RawCapture {
    if (process.platform === 'darwin') {
        const stdout = execFileSync('osascript', ['-l', 'JavaScript', '-e', MAC_JXA], {
            encoding: 'utf-8',
            maxBuffer: 128 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return JSON.parse(stdout.trim()) as RawCapture;
    }
    // Windows and Linux need their capability-probed capture paths verified
    // on target machines first (spec boundary); refusing beats guessing.
    throw new ClipboardError(
        'CLIPBOARD_TOOL_MISSING',
        `clipboard capture is not yet wired for ${process.platform}. Save the image to a file and run modlens -i <path> instead.`,
    );
}

function defaultConvertTiff(from: string, to: string): void {
    execFileSync('sips', ['-s', 'format', 'png', from, '--out', to], { stdio: 'ignore' });
}

function storeRoot(options: CaptureOptions): string {
    return options.storeDir ?? path.join(os.tmpdir(), 'modlens-clip');
}

/** Drop every snapshot past its expiry; runs lazily on every clip command. */
export function sweepSnapshots(options: CaptureOptions = {}): void {
    const root = storeRoot(options);
    let entries: string[];
    try {
        entries = fs.readdirSync(root);
    } catch {
        return;
    }
    for (const entry of entries) {
        const entryPath = path.join(root, entry);
        try {
            const meta = JSON.parse(
                fs.readFileSync(path.join(entryPath, 'meta.json'), 'utf-8'),
            ) as ClipboardSnapshotMeta;
            if (Date.parse(meta.expiresAt) < Date.now()) {
                fs.rmSync(entryPath, { recursive: true, force: true });
            }
        } catch {
            // No readable meta: either leftovers of a crashed capture, or a
            // concurrent capture still inside its mkdir-to-meta window (which
            // spans TIFF transcoding). Only reap once it is clearly stale.
            try {
                if (Date.now() - fs.statSync(entryPath).mtimeMs > STALE_GRACE_MS) {
                    fs.rmSync(entryPath, { recursive: true, force: true });
                }
            } catch {
                // Gone already; a concurrent sweep won.
            }
        }
    }
}

/**
 * Phase one: capture the clipboard into an immutable snapshot. Returns the
 * snapshot meta plus the path of the (possibly normalized) image file for the
 * caller to analyze; the evidence is stored beside it by the CLI afterwards.
 */
export function captureSnapshot(options: CaptureOptions = {}): {
    meta: ClipboardSnapshotMeta;
    imagePath: string;
    dir: string;
} {
    sweepSnapshots(options);
    const runCapture = options.runCapture ?? defaultRunCapture;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

    let raw: RawCapture | null = null;
    for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt += 1) {
        const candidate = runCapture();
        if (
            candidate.revisionBefore !== undefined &&
            candidate.revisionAfter !== undefined &&
            candidate.revisionBefore !== candidate.revisionAfter
        ) {
            raw = null;
            continue;
        }
        raw = candidate;
        break;
    }
    if (raw === null) {
        throw new ClipboardError(
            'CLIPBOARD_CAPTURE_RACE',
            'the clipboard kept changing during capture; retry when it settles.',
        );
    }
    if (raw.kind === 'none') {
        throw new ClipboardError(
            'CLIPBOARD_NO_IMAGE',
            'no image on the clipboard. Take a screenshot to the clipboard first (macOS: Cmd+Ctrl+Shift+4).',
        );
    }
    if (raw.kind === 'multi') {
        throw new ClipboardError(
            'CLIPBOARD_MULTIPLE_IMAGES',
            `the clipboard holds ${raw.count} items; copy exactly one image and retry.`,
        );
    }

    let buffer: Buffer;
    let sourceMime: string;
    if (raw.kind === 'file') {
        const filePath = raw.path ?? '';
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(filePath);
        } catch {
            throw new ClipboardError(
                'CLIPBOARD_FILE_NOT_IMAGE',
                `copied file not found: ${filePath}`,
            );
        }
        if (!stat.isFile()) {
            throw new ClipboardError(
                'CLIPBOARD_FILE_NOT_IMAGE',
                'the copied item is not a regular file.',
            );
        }
        if (stat.size > maxBytes) {
            throw new ClipboardError(
                'CLIPBOARD_TOO_LARGE',
                `copied file is ${stat.size} bytes; the clipboard limit is ${maxBytes}.`,
            );
        }
        buffer = fs.readFileSync(filePath);
        const sniffed = sniffMime(buffer);
        if (!sniffed) {
            throw new ClipboardError(
                'CLIPBOARD_FILE_NOT_IMAGE',
                'the copied file does not look like a supported image (png/jpeg/gif/webp/tiff).',
            );
        }
        sourceMime = sniffed.mime;
    } else {
        buffer = Buffer.from(raw.base64 ?? '', 'base64');
        if (buffer.length === 0) {
            throw new ClipboardError('CLIPBOARD_NO_IMAGE', 'the clipboard image data was empty.');
        }
        sourceMime = raw.kind === 'png' ? 'image/png' : 'image/tiff';
    }
    if (buffer.length > maxBytes) {
        throw new ClipboardError(
            'CLIPBOARD_TOO_LARGE',
            `clipboard image is ${buffer.length} bytes; the limit is ${maxBytes}.`,
        );
    }

    const snapshotId = crypto.randomBytes(16).toString('hex');
    const root = storeRoot(options);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = path.join(root, snapshotId);
    fs.mkdirSync(dir, { mode: 0o700 });

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const sourceExt = sniffMime(buffer)?.ext ?? 'bin';
    const sourceFile = path.join(dir, `source.${sourceExt}`);
    fs.writeFileSync(sourceFile, buffer, { mode: 0o600 });

    // Engines want plain formats; TIFF is normalized to PNG after the race
    // window has closed, and both hashes are reported under distinct names.
    let imagePath = sourceFile;
    let normalizedMime = sourceMime;
    let normalizedSha256: string | undefined;
    if (sourceMime === 'image/tiff') {
        const convert = options.convertTiff ?? defaultConvertTiff;
        const normalized = path.join(dir, 'normalized.png');
        convert(sourceFile, normalized);
        fs.chmodSync(normalized, 0o600);
        imagePath = normalized;
        normalizedMime = 'image/png';
        normalizedSha256 = crypto
            .createHash('sha256')
            .update(fs.readFileSync(normalized))
            .digest('hex');
    }

    const now = Date.now();
    const meta: ClipboardSnapshotMeta = {
        snapshotId,
        sha256,
        ...(normalizedSha256 === undefined ? {} : { normalizedSha256 }),
        bytes: buffer.length,
        sourceMime,
        normalizedMime,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
        ...(raw.revisionBefore === undefined ? {} : { revision: raw.revisionBefore }),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
    return { meta, imagePath, dir };
}

/** Persist the analysis next to the snapshot so phase two never re-analyzes. */
export function storeEvidence(dir: string, evidence: unknown): void {
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2), {
        mode: 0o600,
    });
}

/** Phase two: consume a snapshot by id. Never touches the clipboard. */
export function readSnapshot(
    snapshotId: string,
    options: CaptureOptions = {},
): { meta: ClipboardSnapshotMeta; evidence: unknown } {
    sweepSnapshots(options);
    const dir = path.join(storeRoot(options), snapshotId);
    let meta: ClipboardSnapshotMeta;
    try {
        meta = JSON.parse(
            fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'),
        ) as ClipboardSnapshotMeta;
    } catch {
        throw new ClipboardError(
            'CLIPBOARD_SNAPSHOT_EXPIRED',
            `snapshot ${snapshotId} does not exist or has expired; capture the clipboard again and re-confirm with the user.`,
        );
    }
    let evidence: unknown = null;
    try {
        evidence = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'), 'utf-8'));
    } catch {
        // Capture crashed before evidence landed; the snapshot is still valid
        // for re-analysis by the caller.
    }
    return { meta, evidence };
}

/** Explicit cleanup: one snapshot, or the whole store. */
export function dropSnapshots(target: string | 'all', options: CaptureOptions = {}): number {
    const root = storeRoot(options);
    if (target === 'all') {
        let count = 0;
        try {
            count = fs.readdirSync(root).length;
        } catch {
            return 0;
        }
        fs.rmSync(root, { recursive: true, force: true });
        return count;
    }
    const dir = path.join(root, target);
    if (!fs.existsSync(dir)) {
        return 0;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return 1;
}
