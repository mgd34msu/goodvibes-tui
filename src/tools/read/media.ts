/**
 * Media helpers for the read tool.
 *
 * Handles image validation, metadata extraction, format conversion,
 * archive listing, and binary detection.
 */
import { createRequire } from 'node:module';
import * as zlib from 'node:zlib';
import { logger } from '../../utils/logger.ts';
import { summarizeError } from '../../utils/error-display.ts';

// ---------------------------------------------------------------------------
// Image mode
// ---------------------------------------------------------------------------

/** Controls how image files are processed when read. */
export type ImageMode = 'default' | 'unoptimized' | 'metadata-only' | 'thumbnail-only';

/**
 * Resize target (max edge in px) per ImageMode.
 * null means no resizing (either no image data at all, or full resolution).
 */
export const RESIZE_TARGETS: Record<ImageMode, number | null> = {
  default: 1568,
  unoptimized: null,
  'metadata-only': null,
  'thumbnail-only': 256,
};

// ---------------------------------------------------------------------------
// Size limit
// ---------------------------------------------------------------------------

export const IMAGE_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Extension sets
// ---------------------------------------------------------------------------

export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.tiff',
  '.tif',
  '.avif',
]);

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',
};

export const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.tar.gz']);

// ---------------------------------------------------------------------------
// Magic byte signatures
// ---------------------------------------------------------------------------

/**
 * Magic byte map: extension → list of byte sequences to match at offset 0
 * (or at a specific offset noted inline).
 */
const MAGIC_BYTES: Map<string, Array<{ offset?: number; bytes: number[] }>> = new Map([
  ['.png', [{ bytes: [0x89, 0x50, 0x4e, 0x47] }]],
  ['.jpg', [{ bytes: [0xff, 0xd8, 0xff] }]],
  ['.jpeg', [{ bytes: [0xff, 0xd8, 0xff] }]],
  ['.gif', [{ bytes: [0x47, 0x49, 0x46, 0x38] }]],
  // WebP: RIFF at 0, WEBP at 8
  ['.webp', [{ bytes: [0x52, 0x49, 0x46, 0x46] }, { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }]],
  ['.bmp', [{ bytes: [0x42, 0x4d] }]],
  ['.ico', [{ bytes: [0x00, 0x00, 0x01, 0x00] }]],
  ['.tiff', [{ bytes: [0x49, 0x49, 0x2a, 0x00] }, { bytes: [0x4d, 0x4d, 0x00, 0x2a] }]], // LE + BE
  ['.tif', [{ bytes: [0x49, 0x49, 0x2a, 0x00] }, { bytes: [0x4d, 0x4d, 0x00, 0x2a] }]],   // LE + BE
  // AVIF: ftyp box at offset 4 + brand at offset 8 ('avif', 'avis', or 'mif1')
  // (validated via isAvifBuffer helper — entry kept as sentinel for lookup)
  ['.avif', [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }]],
  // PDF
  ['.pdf', [{ bytes: [0x25, 0x50, 0x44, 0x46] }]],
  // ZIP
  ['.zip', [{ bytes: [0x50, 0x4b, 0x03, 0x04] }]],
  // GZIP
  ['.gz', [{ bytes: [0x1f, 0x8b] }]],
  ['.tgz', [{ bytes: [0x1f, 0x8b] }]],
]);

/** Additional signatures used for detection (determining unknown type). */
const DETECT_SIGNATURES: Array<{ type: string; sigs: Array<{ offset?: number; bytes: number[] }> }> = [
  { type: 'png', sigs: [{ bytes: [0x89, 0x50, 0x4e, 0x47] }] },
  { type: 'jpeg', sigs: [{ bytes: [0xff, 0xd8, 0xff] }] },
  { type: 'gif', sigs: [{ bytes: [0x47, 0x49, 0x46, 0x38] }] },
  { type: 'webp', sigs: [{ bytes: [0x52, 0x49, 0x46, 0x46] }, { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }] },
  { type: 'bmp', sigs: [{ bytes: [0x42, 0x4d] }] },
  { type: 'ico', sigs: [{ bytes: [0x00, 0x00, 0x01, 0x00] }] },
  // Two separate TIFF entries (LE + BE) — matchesSigs uses .every(), so each
  // endianness must be its own entry rather than combined into one sigs array.
  { type: 'tiff', sigs: [{ bytes: [0x49, 0x49, 0x2a, 0x00] }] }, // little-endian
  { type: 'tiff', sigs: [{ bytes: [0x4d, 0x4d, 0x00, 0x2a] }] }, // big-endian
  // AVIF detection is handled specially in validateMagicBytes via isAvifBuffer;
  // sigs intentionally empty — isAvifBuffer() is always called instead.
  { type: 'avif', sigs: [] },
  { type: 'pdf', sigs: [{ bytes: [0x25, 0x50, 0x44, 0x46] }] },
  { type: 'zip', sigs: [{ bytes: [0x50, 0x4b, 0x03, 0x04] }] },
  { type: 'gzip', sigs: [{ bytes: [0x1f, 0x8b] }] },
];

/** Returns true if the buffer contains an AVIF ftyp box with a valid AVIF brand. */
function isAvifBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const hasFtyp =
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
  if (!hasFtyp) return false;
  const brand = buf.subarray(8, 12).toString('ascii');
  return ['avif', 'avis', 'mif1'].includes(brand);
}

function matchesSigs(
  buf: Buffer,
  sigs: Array<{ offset?: number; bytes: number[] }>,
): boolean {
  return sigs.every(({ offset = 0, bytes }) => {
    if (buf.length < offset + bytes.length) return false;
    return bytes.every((b, i) => buf[offset + i] === b);
  });
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Validate that the file's magic bytes match the expected extension.
 * If they don't match, attempts to detect the actual type.
 */
export function validateMagicBytes(
  buffer: Buffer,
  ext: string,
): { valid: boolean; detectedType?: string } {
  const probe = buffer.subarray(0, 16);
  const normalExt = ext.toLowerCase();

  // SVG is text-based — check the first 256 bytes
  if (normalExt === '.svg') {
    const head = buffer.subarray(0, 256).toString('utf-8');
    return { valid: head.includes('<svg') };
  }

  const expectedSigs = MAGIC_BYTES.get(normalExt);
  if (!expectedSigs) {
    // Unknown extension — no validation, assume valid
    return { valid: true };
  }

  // AVIF needs brand check in addition to ftyp box
  if (normalExt === '.avif') {
    const isValid = isAvifBuffer(buffer);
    if (isValid) return { valid: true };
    // Detect actual type
    for (const { type, sigs } of DETECT_SIGNATURES) {
      if (type !== 'avif' && matchesSigs(buffer.subarray(0, 16), sigs)) {
        return { valid: false, detectedType: type };
      }
    }
    return { valid: false };
  }

  // TIFF can be either LE or BE — allow both for .tiff and .tif
  // For extensions with multiple sigs (e.g. webp, tiff), we determine match strategy:
  // - TIFF: ANY sig must match (LE or BE)
  // - WebP: ALL sigs must match
  const isValid =
    normalExt === '.tiff' || normalExt === '.tif'
      ? expectedSigs.some((sig) => matchesSigs(probe, [sig]))
      : matchesSigs(probe, expectedSigs);

  if (isValid) return { valid: true };

  // Detect actual type
  for (const { type, sigs } of DETECT_SIGNATURES) {
    if (type !== 'avif' && matchesSigs(buffer.subarray(0, 16), sigs)) {
      return { valid: false, detectedType: type };
    }
    if (type === 'avif' && isAvifBuffer(buffer)) {
      return { valid: false, detectedType: 'avif' };
    }
  }
  return { valid: false };
}

/** Returns true when the extension belongs to a supported image format. */
export function isImageFile(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/** Returns true when the extension belongs to a supported archive format. */
export function isArchiveFile(ext: string): boolean {
  const lower = ext.toLowerCase();
  return ARCHIVE_EXTENSIONS.has(lower);
}

/** Returns the MIME type for an image extension, or null if unknown. */
export function getImageMediaType(ext: string): string | null {
  return IMAGE_MEDIA_TYPES[ext.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Image metadata
// ---------------------------------------------------------------------------

export interface ImageMetadata {
  width?: number;
  height?: number;
  format: string;
  fileSize: number;
}

/**
 * Extract basic image metadata from a buffer.
 * Supports PNG, JPEG, GIF, BMP. Returns format + fileSize for others.
 */
export function getImageMetadata(buffer: Buffer, ext: string): ImageMetadata {
  const format = ext.toLowerCase().replace(/^\./, '');
  const fileSize = buffer.length;
  const base: ImageMetadata = { format, fileSize };

  try {
    switch (format) {
      case 'png': {
        // IHDR: width at bytes 16-19, height at bytes 20-23 (BE uint32)
        if (buffer.length >= 24) {
          base.width = buffer.readUInt32BE(16);
          base.height = buffer.readUInt32BE(20);
        }
        break;
      }
      case 'jpg':
      case 'jpeg': {
        // Scan for SOF0 (0xFF 0xC0) or SOF2 (0xFF 0xC2) markers
        let i = 2;
        while (i < buffer.length - 8) {
          if (buffer[i] !== 0xff) { i++; continue; }
          const marker = buffer[i + 1];
          if (marker === 0xc0 || marker === 0xc2) {
            // height at +5 (BE uint16), width at +7 (BE uint16)
            base.height = buffer.readUInt16BE(i + 5);
            base.width = buffer.readUInt16BE(i + 7);
            break;
          }
          // Skip segment: length at i+2 (includes 2-byte length field)
          const segLen = buffer.readUInt16BE(i + 2);
          i += 2 + segLen;
        }
        break;
      }
      case 'gif': {
        // Width at bytes 6-7 (LE uint16), height at bytes 8-9 (LE uint16)
        if (buffer.length >= 10) {
          base.width = buffer.readUInt16LE(6);
          base.height = buffer.readUInt16LE(8);
        }
        break;
      }
      case 'bmp': {
        // Width at bytes 18-21 (LE int32), height at bytes 22-25 (LE int32, abs value)
        if (buffer.length >= 26) {
          base.width = buffer.readInt32LE(18);
          base.height = Math.abs(buffer.readInt32LE(22));
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    logger.debug('[media] getImageMetadata failed', { error: summarizeError(err) });
  }

  return base;
}

// ---------------------------------------------------------------------------
// Sharp runtime bridge
// ---------------------------------------------------------------------------

/**
 * Minimal sharp interface covering only the operations used here.
 * Avoids requiring @types/sharp or the sharp package to be installed.
 */
interface SharpInstance {
  metadata(): Promise<{ width?: number; height?: number; format?: string }>;
  resize(options: { width?: number; height?: number }): SharpInstance;
  png(): SharpInstance;
  jpeg(): SharpInstance;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
  toBuffer(): Promise<Buffer>;
}

type SharpFactory = (input: Buffer) => SharpInstance;

/**
 * Lazy-load sharp.
 * Returns the sharp factory function on success, null if unavailable.
 */
export async function tryLoadSharp(): Promise<SharpFactory | null> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    const mod = await dynamicImport('sharp');
    if (typeof mod === 'function') {
      return mod as SharpFactory;
    } else if (typeof mod === 'object' && mod !== null && 'default' in mod && typeof mod.default === 'function') {
      return mod.default as SharpFactory;
    } else {
      throw new Error('sharp module did not expose a callable factory');
    }
  } catch (err) {
    logger.debug('[media] sharp not available — image resizing/conversion disabled', { error: summarizeError(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Image resizing
// ---------------------------------------------------------------------------

export interface ResizeResult {
  buffer: Buffer;
  resized: boolean;
  width?: number;
  height?: number;
}

/**
 * Resize an image buffer so its longest edge is ≤ maxEdge.
 * If sharp is unavailable or the image is already small enough, returns the original.
 *
 * @remarks
 * Format conversion notes (intentional for LLM consumption):
 * - WebP input is converted to PNG (losing WebP compression efficiency), since
 *   sharp's resize pipeline outputs JPEG or PNG only.
 * - GIF input loses animation — only the first frame is preserved.
 * - These trade-offs are intentional: LLMs expect static raster images.
 */
export async function resizeImage(
  buffer: Buffer,
  mediaType: string,
  maxEdge: number,
): Promise<ResizeResult> {
  const sharpFn = await tryLoadSharp();
  if (!sharpFn) return { buffer, resized: false };

  try {
    const instance = sharpFn(buffer);
    const meta = await instance.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const longest = Math.max(w, h);

    if (longest <= maxEdge) {
      return { buffer, resized: false, width: w || undefined, height: h || undefined };
    }

    // Resize preserving aspect ratio
    const isJpeg = mediaType === 'image/jpeg';
    const resizedInstance = instance.resize({
      width: w >= h ? maxEdge : undefined,
      height: h > w ? maxEdge : undefined,
    });
    const formatted = isJpeg ? resizedInstance.jpeg() : resizedInstance.png();
    const resized = await formatted.toBuffer({ resolveWithObject: true });

    return {
      buffer: resized.data,
      resized: true,
      width: resized.info.width,
      height: resized.info.height,
    };
  } catch (err) {
    logger.debug('[media] sharp resize failed', { error: summarizeError(err) });
    return { buffer, resized: false };
  }
}

// ---------------------------------------------------------------------------
// Format conversion
// ---------------------------------------------------------------------------

export interface ConvertResult {
  buffer: Buffer;
  mediaType: string;
  converted: boolean;
  originalFormat: string;
}

/** Extensions that require conversion to a portable format (PNG) for LLM consumption. */
const CONVERT_EXTS = new Set(['.bmp', '.tiff', '.tif', '.avif']);

/**
 * Convert non-portable image formats (BMP, TIFF, AVIF) to PNG using sharp.
 * Returns the original buffer if sharp is unavailable or the format doesn't need conversion.
 */
export async function convertToPortableFormat(
  buffer: Buffer,
  ext: string,
): Promise<ConvertResult> {
  const originalFormat = ext.toLowerCase().replace(/^\./, '');
  if (!CONVERT_EXTS.has(ext.toLowerCase())) {
    return { buffer, mediaType: IMAGE_MEDIA_TYPES[ext.toLowerCase()] ?? 'application/octet-stream', converted: false, originalFormat };
  }

  const sharpFn = await tryLoadSharp();
  if (!sharpFn) {
    return { buffer, mediaType: IMAGE_MEDIA_TYPES[ext.toLowerCase()] ?? 'application/octet-stream', converted: false, originalFormat };
  }

  try {
    const pngBuffer = await sharpFn(buffer).png().toBuffer();
    return { buffer: pngBuffer, mediaType: 'image/png', converted: true, originalFormat };
  } catch (err) {
    logger.debug('[media] format conversion failed', { error: summarizeError(err) });
    return { buffer, mediaType: IMAGE_MEDIA_TYPES[ext.toLowerCase()] ?? 'application/octet-stream', converted: false, originalFormat };
  }
}

// ---------------------------------------------------------------------------
// Archive listing
// ---------------------------------------------------------------------------

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ArchiveEntry {
  name: string;
  size: number;
}

function parseZip(buffer: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  // Find EOCD signature: 0x50 0x4B 0x05 0x06
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return entries;

  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  let pos = centralDirOffset;
  const end = centralDirOffset + centralDirSize;

  while (pos < end && pos + 46 <= buffer.length) {
    // Central directory entry signature: 0x50 0x4B 0x01 0x02
    if (
      buffer[pos] !== 0x50 ||
      buffer[pos + 1] !== 0x4b ||
      buffer[pos + 2] !== 0x01 ||
      buffer[pos + 3] !== 0x02
    ) break;

    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const fileNameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);

    const nameEnd = pos + 46 + fileNameLen;
    if (nameEnd > buffer.length) break;
    const name = buffer.subarray(pos + 46, nameEnd).toString('utf-8');

    entries.push({ name, size: uncompressedSize });
    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

function parseTar(buffer: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let pos = 0;
  while (pos + 512 <= buffer.length) {
    const header = buffer.subarray(pos, pos + 512);
    // Check for end-of-archive (two consecutive zero blocks)
    if (header.every((b) => b === 0)) break;

    // Filename: first 100 bytes, null-terminated
    const nameRaw = header.subarray(0, 100).toString('utf-8').replace(/\0.*/, '');
    if (!nameRaw) { pos += 512; continue; }

    // File size: octal string at offset 124, length 12
    const sizeOctal = header.subarray(124, 136).toString('utf-8').replace(/\0.*/g, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;

    entries.push({ name: nameRaw, size });

    // Advance past header + data blocks (512-byte aligned)
    const dataBlocks = Math.ceil(size / 512);
    pos += 512 + dataBlocks * 512;
  }
  return entries;
}

/**
 * List the contents of an archive file.
 * Supports ZIP, .gz (gunzip + tar parse if tar), .tar, .tgz.
 */
export function listArchiveContents(
  resolvedPath: string,
  buffer: Buffer,
  ext: string,
): string {
  try {
    const lower = ext.toLowerCase();
    let entries: ArchiveEntry[] = [];

    if (lower === '.zip') {
      entries = parseZip(buffer);
    } else if (lower === '.tar') {
      entries = parseTar(buffer);
    } else if (lower === '.gz' || lower === '.tgz') {
      // Gunzip, then try to parse as tar
      const decompressed = zlib.gunzipSync(buffer);
      entries = parseTar(decompressed);
    } else {
      return 'Archive (unsupported format)';
    }

    if (entries.length === 0) {
      return `Archive (0 files): ${resolvedPath}`;
    }

    const lines = entries.map((e) => `  ${e.name} (${humanSize(e.size)})`);
    return `Archive (${entries.length} files):\n${lines.join('\n')}`;
  } catch (err) {
    logger.debug('[media] listArchiveContents failed', { error: summarizeError(err) });
    return 'Archive (unable to list contents)';
  }
}

// ---------------------------------------------------------------------------
// Binary detection by content
// ---------------------------------------------------------------------------

/**
 * Detect binary content by scanning for null bytes in the first sampleSize bytes.
 * Returns true if null bytes are found (indicating binary content).
 */
export function isBinaryByContent(buffer: Buffer, sampleSize = 8192): boolean {
  const probe = buffer.subarray(0, sampleSize);
  return probe.includes(0);
}
