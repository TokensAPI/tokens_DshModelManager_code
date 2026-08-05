import * as fs from 'fs';
import * as path from 'path';

const MIME_BY_EXT: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
};

// A remote image is pulled fully into memory and base64-encoded, so an
// unbounded download is a memory-exhaustion vector. 25 MB comfortably clears a
// dense screenshot or a high-res photo while capping the damage.
export const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;

// Types we are willing to hand to a provider. The four raster formats below can
// be confirmed from their file header; heic/heif cannot be sniffed here, so they
// are trusted only when the extension says so.
const ALLOWED_MIME = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/heic',
    'image/heif',
]);

const SNIFFERS: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
    {
        mime: 'image/png',
        test: (b) =>
            b.length >= 8 &&
            b[0] === 0x89 &&
            b[1] === 0x50 &&
            b[2] === 0x4e &&
            b[3] === 0x47 &&
            b[4] === 0x0d &&
            b[5] === 0x0a &&
            b[6] === 0x1a &&
            b[7] === 0x0a,
    },
    {
        mime: 'image/jpeg',
        test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    },
    {
        mime: 'image/gif',
        test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)),
    },
    {
        mime: 'image/webp',
        test: (b) =>
            b.length >= 12 &&
            b.toString('ascii', 0, 4) === 'RIFF' &&
            b.toString('ascii', 8, 12) === 'WEBP',
    },
];

/** Confirm an image type from its file header, or null if unrecognized. */
export function sniffImageMime(buffer: Buffer): string | null {
    for (const { mime, test } of SNIFFERS) {
        if (test(buffer)) {
            return mime;
        }
    }
    return null;
}

function extMime(source: string): string | null {
    // Local paths go straight through path.extname. Routing them through new URL
    // truncated the extension at a literal # or ? (a fragment/query only exists
    // in URLs), so /tmp/shot#2.png fell back to the wrong type. Only remote URLs,
    // where a query string is real, get URL parsing.
    const ext = /^https?:\/\//i.test(source)
        ? path.extname(new URL(source).pathname).toLowerCase()
        : path.extname(source).toLowerCase();
    return MIME_BY_EXT[ext] ?? null;
}

export function mimeTypeFor(source: string): string {
    return extMime(source) ?? 'image/jpeg';
}

/**
 * Decide the media type from the bytes first, then fall back to the extension
 * or the server's content-type. The file header wins because it cannot be
 * faked by renaming a file or by a lying server, and a type outside the allow
 * list is rejected rather than silently relabelled image/jpeg.
 */
export function resolveImageMime(buffer: Buffer, source: string, contentType?: string): string {
    const sniffed = sniffImageMime(buffer);
    if (sniffed) {
        return sniffed;
    }
    const declared = contentType?.split(';')[0]?.trim().toLowerCase();
    const candidate = extMime(source) ?? (declared?.startsWith('image/') ? declared : null);
    if (candidate && ALLOWED_MIME.has(candidate)) {
        return candidate;
    }
    throw new Error(
        `Unsupported or unrecognized image type for ${source}. Allowed: ${[...ALLOWED_MIME].join(', ')}.`,
    );
}

export function readLocalImageBase64(filePath: string): { data: string; mimeType: string } {
    const buffer = fs.readFileSync(filePath);
    const mimeType = resolveImageMime(buffer, filePath);
    return { data: buffer.toString('base64'), mimeType };
}

/** Download a remote image, for APIs that only accept inline bytes. */
export async function fetchRemoteImageBase64(
    url: string,
    timeoutMs: number,
): Promise<{ data: string; mimeType: string }> {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
        throw new Error(`Failed to download image (${response.status}): ${url}`);
    }

    // Trust the advertised size to reject an oversized download before reading a
    // single byte, then enforce the same limit while streaming, because
    // content-length can be absent or a lie.
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) {
        throw new Error(
            `Remote image is ${declaredLength} bytes, over the ${MAX_REMOTE_IMAGE_BYTES}-byte limit: ${url}`,
        );
    }

    const buffer = await readCapped(response, url);
    const contentType = response.headers.get('content-type') ?? undefined;
    const mimeType = resolveImageMime(buffer, url, contentType);
    return { data: buffer.toString('base64'), mimeType };
}

async function readCapped(response: Response, url: string): Promise<Buffer> {
    const body = response.body;
    if (!body) {
        // No stream to meter (e.g. a mocked Response): read then check.
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_REMOTE_IMAGE_BYTES) {
            throw new Error(
                `Remote image exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit: ${url}`,
            );
        }
        return buffer;
    }

    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.byteLength;
        if (total > MAX_REMOTE_IMAGE_BYTES) {
            await reader.cancel();
            throw new Error(
                `Remote image exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit: ${url}`,
            );
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}
