// ---------------------------------------------------------------------------
// Pure mapping + redaction helpers shared by every adapter.
//
// Rules (from the handoff contract):
//   - fromDigest  = sha256First(senderExternalId, 16)   (never the raw id)
//                   (16 hex chars == the first 8 bytes of the SHA-256 digest;
//                    handoff acceptance checklist: 'first 16 hex chars')
//   - bodyPreview = plain-text, PII-stripped, truncated to 500 chars
//   - subjectPreview <= 200 chars
// These are pure and deterministic so they are unit-testable in isolation.
// ---------------------------------------------------------------------------

import { sha256First } from '../../operator/index.ts';

export const SUBJECT_PREVIEW_MAX = 200;
export const BODY_PREVIEW_MAX = 500;

/**
 * Digest a sender's external id to a stable 16-hex-char token (the first 8
 * bytes of the SHA-256 digest). The handoff wire-shape note's 'SHA-256 first-8'
 * refers to those 8 bytes; the acceptance checklist states it as 'first 16 hex
 * chars'. Both describe the same value emitted here.
 */
export function digestSender(senderExternalId: string): string {
  return sha256First(senderExternalId, 16);
}

// PII patterns stripped from body previews before they ever leave the daemon.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// E.164-ish and common separated phone numbers (>=7 digits with separators).
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;
// Long digit runs that look like card / account numbers (13-19 digits).
const LONG_NUMBER_RE = /\b\d{13,19}\b/g;
// IPv4 addresses.
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

// --- Secret / token patterns -----------------------------------------------
// These must run BEFORE the generic numeric/email scrubbers and are ordered
// most-specific first so a long opaque secret is never partially redacted.
//
// `Authorization: Bearer <token>` / bare `Bearer <token>`.
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// JSON Web Tokens: three base64url segments separated by dots (header.payload.sig).
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
// Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs-... and legacy xox*-.
const SLACK_TOKEN_RE = /\bxox[abeoprs]-[A-Za-z0-9-]{8,}/gi;
// Common prefixed provider keys: OpenAI sk-/sk-proj-, GitHub gh[poursa]_,
// Google AIza..., Stripe sk_live_/pk_live_/rk_live_, Slack-app xapp-, AWS AKIA...
const PREFIXED_KEY_RE =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[poursa]_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{16,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|xapp-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})/g;
// `token=`, `api_key=`, `access_token: ...`, `secret = ...` style key/value pairs.
const KV_SECRET_RE =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd|authorization|auth)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9._~+/=-]{6,})/gi;
// Generic high-entropy opaque blobs (>=24 chars of base64url/hex) not already
// caught above — catches raw API keys pasted without a recognizable prefix.
const OPAQUE_SECRET_RE = /\b[A-Za-z0-9_-]{24,}\b/g;

/**
 * Replace PII and credentials with stable redaction tokens (does not alter the
 * length budget). Secrets/tokens are scrubbed before the email/phone/number
 * passes so an OAuth/bearer/API token can never leak into a preview.
 */
export function stripPii(input: string): string {
  return input
    .replace(BEARER_RE, '[token]')
    .replace(JWT_RE, '[token]')
    .replace(SLACK_TOKEN_RE, '[token]')
    .replace(PREFIXED_KEY_RE, '[token]')
    .replace(KV_SECRET_RE, (match) => {
      const sep = match.includes('=') ? '=' : ':';
      const key = match.slice(0, match.indexOf(sep)).trimEnd();
      return `${key}${sep}[token]`;
    })
    .replace(EMAIL_RE, '[email]')
    .replace(IPV4_RE, '[ip]')
    .replace(LONG_NUMBER_RE, '[number]')
    .replace(PHONE_RE, (match) => {
      // Avoid eating short numeric tokens that survived LONG_NUMBER_RE; only
      // redact when there are at least 7 digits.
      const digits = match.replace(/\D/g, '');
      return digits.length >= 7 ? '[phone]' : match;
    })
    // Sweep any remaining long opaque blob (e.g. a bare API key) last so we do
    // not clobber the redaction tokens we just inserted.
    .replace(OPAQUE_SECRET_RE, (match) => (/^[A-Za-z]+$/.test(match) ? match : '[token]'));
}

// --- Markup / MIME de-structuring ------------------------------------------
// Email BODY[TEXT] is frequently raw HTML and/or a multipart/MIME payload with
// boundary lines and Content-* headers. Previews must be human-readable plain
// text, so we de-MIME (prefer the text/plain part), strip tags, and decode the
// handful of HTML entities that survive into previews. This is a no-op on text
// that is already plain.
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

/** True when the text looks like a MIME multipart payload (has boundary lines). */
function isMultipart(text: string): boolean {
  return /^--[^\r\n]+\r?\n/m.test(text) && /content-type:/i.test(text);
}

/**
 * Given a multipart body, return the decoded text/plain part if present,
 * otherwise the text/html part, otherwise the original input. Strips the
 * per-part MIME headers so only the body bytes remain.
 */
function extractMimePart(text: string): string {
  const boundaryMatch = /^--([^\r\n]+?)(?:--)?\r?$/m.exec(text);
  if (!boundaryMatch) return text;
  const boundary = boundaryMatch[1]!;
  const parts = text.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\r?\n?`));
  let htmlPart: string | undefined;
  for (const rawPart of parts) {
    const split = /\r?\n\r?\n/.exec(rawPart);
    if (!split) continue;
    const headers = rawPart.slice(0, split.index);
    const body = rawPart.slice(split.index + split[0].length);
    const ctype = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim().toLowerCase();
    if (!ctype) continue;
    if (ctype === 'text/plain') return body.trim();
    if (ctype === 'text/html' && htmlPart === undefined) htmlPart = body;
  }
  return (htmlPart ?? text).trim();
}

/** Strip stray top-level MIME/Content-* headers from a single-part body. */
function stripMimeHeaders(text: string): string {
  return text.replace(
    /^(?:content-type|content-transfer-encoding|content-disposition|content-id|mime-version|--[^\r\n]+)\b[^\r\n]*\r?\n/gim,
    '',
  );
}

/** Decode the small set of HTML entities that matter for plain-text previews. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#(\d{1,7});/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    });
}

/**
 * Convert HTML/MIME body text into readable plain text. Drops <script>/<style>
 * blocks entirely, turns block-level tags into spaces, removes all remaining
 * tags, decodes entities, and de-MIMEs multipart payloads. Plain text passes
 * through unchanged (modulo entity decoding).
 */
export function stripMarkup(input: string): string {
  let text = input;
  if (isMultipart(text)) {
    text = extractMimePart(text);
  }
  text = stripMimeHeaders(text);
  // Drop script/style contents before tag removal so their bodies never leak.
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Only treat as HTML if there is an actual tag; avoids mangling plain text
  // that merely contains a stray '<'.
  if (/<[a-z!/][^>]*>/i.test(text)) {
    text = text
      .replace(/<\/?(?:br|p|div|tr|li|h[1-6]|table|ul|ol|blockquote|hr)\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, '');
  }
  return decodeEntities(text);
}

/** Collapse whitespace and trim — keeps previews single-line and tidy. */
export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** Build a display-safe subject preview (<=200 chars, no PII, single line). */
export function toSubjectPreview(raw: string | undefined | null): string {
  const normalized = normalizeWhitespace(stripPii(raw ?? ''));
  return normalized.slice(0, SUBJECT_PREVIEW_MAX);
}

/**
 * Build a display-safe body preview (<=500 chars, plain text, PII-stripped,
 * single line). HTML/MIME is de-structured to readable text first so previews
 * of real-world (HTML/multipart) emails never leak tags or MIME headers.
 */
export function toBodyPreview(raw: string | undefined | null): string {
  const plain = stripMarkup(raw ?? '');
  const normalized = normalizeWhitespace(stripPii(plain));
  return normalized.slice(0, BODY_PREVIEW_MAX);
}
