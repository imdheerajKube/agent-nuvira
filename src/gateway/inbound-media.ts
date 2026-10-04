/**
 * Inbound document hydration for the gateway (`src/gateway/inbound-media.ts`).
 *
 * A messaging transport delivers a DOCUMENT (a PDF report, a DOCX contract, a
 * spreadsheet) as bytes + a filename — never as text. The bridge only extracted
 * `conversation` / `extendedTextMessage`, so a document message arrived with an
 * empty `text` and was dropped at `if (!text) continue`: the sender's own file
 * vanished with no reply and no record.
 *
 * This module is the fix for the inbound half of that gap. The bridge DOWNLOADS
 * the bytes, they ride on `InboundMessage.media`, and `handleInbound` calls
 * `hydrateInboundMedia` — which writes them to the artifact sandbox and runs the
 * SAME `read_extract` the agent uses for a file in the project folder. The
 * returned section is prepended to the turn's text, so a caption + a document
 * becomes one request the model can act on.
 *
 * Extraction (not the download) is what makes the file usable: a document whose
 * bytes never become text is still a message the agent cannot answer. When the
 * file cannot be extracted the section says so, with the typed code and the
 * concrete alternatives `read_extract` produces — never a silent empty result.
 *
 * Never throws: a media failure must not break the text turn it arrived with.
 */

import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { artifactsDir } from '../tools/modality/shared.js';

/** A media attachment that rode in on an inbound message. */
export interface InboundMedia {
  type: 'image' | 'video' | 'audio' | 'document';
  /** The file's bytes (already downloaded by the transport). */
  data: Uint8Array;
  /** The sender's filename, when the transport provides one. */
  filename?: string;
  /** MIME type, when the transport provides one. */
  mimetype?: string;
  /** The transport's caption on the media message (may carry the instruction). */
  caption?: string;
}

/** What we are willing to write + extract in one inbound turn. */
export const MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024;

/** How long an extracted inbound attachment is kept before the sweep (ms). */
export const INBOUND_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sandbox size cap (bytes). Past this, the OLDEST remaining files are swept
 * even if they are still inside the TTL — a long-running gateway fed scanned
 * reports should not grow without bound.
 */
export const INBOUND_MEDIA_MAX_BYTES = 200 * 1024 * 1024;

/** MIME type → extension, for transports that omit a filename. */
const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/csv': '.csv',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/html': '.html',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** Image extensions — extraction cannot read them; a vision call can. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff']);

/**
 * Sniff a document/image extension from the file's MAGIC BYTES.
 *
 * WHY THIS EXISTS. A transport's `fileName` is not guaranteed to carry an
 * extension — WhatsApp in particular delivers a document whose name may be just
 * the sender's title (live: an 8 MB, 28-page PDF named `Divya Sharma_report`).
 * `read_extract` dispatches on the extension, so the file was persisted as
 * `…-Divya Sharma_report` and refused with `unsupported_format: (no extension)`
 * even though the bytes were a perfectly good `%PDF-1.4`. The MIME→extension
 * fallback only fired when the filename was ABSENT, never to AUGMENT a present
 * but extensionless name.
 *
 * Sniffing the bytes is the reliable signal: it is what the file actually IS,
 * independent of what the transport chose to call it. Returns the canonical
 * extension (with the leading dot) or null when nothing matches — in which case
 * the caller keeps the name as-is and read_extract gives its honest refusal.
 */
export function sniffExtension(data: Uint8Array | undefined): string | null {
  if (!data || data.byteLength < 4) return null;
  const b = data;
  const startsWith = (sig: number[]): boolean => sig.every((v, i) => b[i] === v);
  // PDF: %PDF
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return '.pdf';
  // PNG
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return '.png';
  // JPEG: FF D8 FF
  if (startsWith([0xff, 0xd8, 0xff])) return '.jpg';
  // GIF: GIF8
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return '.gif';
  // WEBP: RIFF....WEBP
  if (
    startsWith([0x52, 0x49, 0x46, 0x46])
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return '.webp';
  // BMP: BM
  if (startsWith([0x42, 0x4d])) return '.bmp';
  // TIFF: II*0 / MM0*
  if (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a])) return '.tiff';
  // ZIP container — OOXML (docx/xlsx/pptx). All three share the PK header, so
  // the container alone cannot name the exact type; `.docx` is the safest
  // default (read_extract reads it as an OOXML package). Only applied when the
  // name carried NO usable extension.
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06])) return '.docx';
  return null;
}

/**
 * Does this name end in a KNOWN readable document/image extension?
 *
 * `foo.pdf` and `foo.tar.gz` are both fine (the LAST segment wins), but
 * `Divya Sharma_report` is not — and neither is `report.txt.pdf` mistaken for
 * anything but a PDF. The set is the union of what `read_extract` reads and the
 * image types this module routes to `describe_image`.
 */
const KNOWN_DOC_EXTS = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx',
  '.txt', '.md', '.markdown', '.text', '.log', '.csv', '.tsv',
  '.json', '.xml', '.yaml', '.yml', '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff',
]);

function hasKnownExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return KNOWN_DOC_EXTS.has(name.slice(dot).toLowerCase());
}

/**
 * Ensure a persisted name carries a usable extension: keep a known one, else
 * append the MIME-derived extension, else the sniffed one, else nothing.
 */
function ensureExtension(name: string, media: InboundMedia): string {
  if (hasKnownExtension(name)) return name;
  const mime = (media.mimetype ?? '').split(';')[0].trim().toLowerCase();
  const fromMime = MIME_EXT[mime];
  if (fromMime) return `${name}${fromMime}`;
  const sniffed = sniffExtension(media.data);
  if (sniffed) return `${name}${sniffed}`;
  return name;
}

/** A human label for the media kind (used in the section heading). */
function labelFor(media: InboundMedia): string {
  switch (media.type) {
    case 'image': return 'Image';
    case 'video': return 'Video';
    case 'audio': return 'Audio';
    default: return 'Document';
  }
}

/**
 * Reduce a sender-supplied name to a safe basename that keeps its extension —
 * the name is untrusted and must never escape the artifact dir.
 */
export function safeInboundName(media: InboundMedia): string {
  const base = (media.filename ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  // A sender-supplied name is kept, but a name with NO usable extension gets
  // one appended (MIME first, then magic bytes). Without this an extensionless
  // `Divya Sharma_report` persisted as-is and `read_extract` refused a valid
  // PDF with `unsupported_format: (no extension)`.
  if (cleaned) return ensureExtension(cleaned.slice(0, 120), media);
  const mime = (media.mimetype ?? '').split(';')[0].trim().toLowerCase();
  const ext =
    MIME_EXT[mime]
    ?? sniffExtension(media.data)
    ?? (media.type === 'document' ? '.bin' : `.${media.type}`);
  return `inbound-${media.type}${ext}`;
}

/** Human byte size for an error line ("512 B" / "512 KB" / "20 MB"). */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Write the bytes into the artifact sandbox, or explain why we could not. */
function persist(media: InboundMedia, maxBytes: number): { path: string } | { error: string } {
  if (!media.data || media.data.byteLength === 0) {
    return { error: 'the file was empty (zero bytes)' };
  }
  if (media.data.byteLength > maxBytes) {
    return { error: `the file is larger than the ${formatBytes(maxBytes)} limit` };
  }
  // A unique name per delivery: the same document sent twice must not clobber
  // the first copy (its extracted text is already in the conversation).
  const path = join(artifactsDir('inbound'), `${Date.now().toString(36)}-${safeInboundName(media)}`);
  writeFileSync(path, Buffer.from(media.data));
  return { path };
}

/** A document that arrived but could not be turned into text. */
export interface InboundMediaFailure {
  /** The attachment's display name. */
  name: string;
  /** The media kind (only 'document' triggers the sender reply — see below). */
  type: InboundMedia['type'];
  /** A short, sender-safe reason (no stack traces, no not artifact paths). */
  reason: string;
}

/** The outcome of hydrating one inbound attachment. */
export interface HydratedInboundMedia {
  /**
   * The labelled context section to prepend to the turn, or null when there is
   * nothing to add. Never null in practice: extracted text, an image note, or a
   * refusal note all produce a section.
   */
  section: string | null;
  /**
   * Set when a DOCUMENT arrived but could not be turned into text. The registry
   * auto-replies with this to the sender — a document that produces no text and
   * no reply is precisely the failure this whole path exists to remove.
   */
  failure?: InboundMediaFailure;
}

/**
 * Render the sender-facing reply for a document that could not be extracted.
 *
 * Built from `reason` alone on purpose: the model-facing section carries the
 * saved artifact path and agent-jargon alternatives (`call read_extract again
 * with ocr:true`), neither of which belongs in a chat with the person who sent
 * the file.
 */
export function formatMediaFailureReply(failure: InboundMediaFailure): string {
  const kind = failure.type === 'document' ? 'document' : failure.type === 'audio' ? 'voice note' : failure.type;
  const advice = failure.type === 'document'
    ? 'If you can, re-send it as PDF, DOCX, XLSX, PPTX, CSV or plain text.'
    : 'Send it as a text message instead.';
  return `I couldn't read your ${kind} "${failure.name}" — ${failure.reason} ${advice}`;
}

/**
 * Extract an inbound media attachment into a labelled context section. Never
 * throws — a failure is reported as `failure` (plus a refusal section) instead.
 *
 * The saved path is always included so the model can follow up on the ORIGINAL
 * file (e.g. `read_extract` with `ocr:true` for a scanned PDF, or
 * `describe_image` for an image) instead of only seeing the extracted text.
 */
export async function hydrateInboundMedia(
  media: InboundMedia,
  opts: { maxBytes?: number } = {},
): Promise<HydratedInboundMedia> {
  const maxBytes = typeof opts.maxBytes === 'number' && opts.maxBytes > 0 ? opts.maxBytes : MAX_INBOUND_MEDIA_BYTES;
  const name = media.filename?.trim() || safeInboundName(media);
  // A DOCUMENT is the only kind that must become text: an image is expected to
  // need the vision tool, and audio/video are not extraction jobs — replying
  // "could not be extracted" to a voice note would be true but useless.
  const documentFailure = (reason: string): { failure?: InboundMediaFailure } =>
    media.type === 'document' ? { failure: { name, type: media.type, reason } } : {};
  try {
    const stored = persist(media, maxBytes);
    if ('error' in stored) {
      return {
        section: `[${labelFor(media)}: ${name} could not be read — ${stored.error}]`,
        ...documentFailure(stored.error),
      };
    }
    const { path } = stored;
    const ext = extname(path).toLowerCase();

    if (IMAGE_EXTS.has(ext)) {
      return { section: `[Image: ${name} — saved at ${path}. Call describe_image on that path to read it.]` };
    }

    // A VOICE NOTE is audio, not a document: read_extract has no audio reader,
    // so route it through the SAME transcription path the `transcribe` tool
    // uses (whisper.cpp / faster-whisper). A voice note that produces no text
    // and no reply is the same silent drop as an unreadable document.
    if (media.type === 'audio') {
      const voice = await import('../tools/modality/voice.js');
      if (!voice.isTranscribeAvailable()) {
        const reason = 'transcription is not set up on this machine';
        return {
          section: `[Voice note: ${name} — saved at ${path}, but could not be transcribed: ${reason}.]`,
          failure: { name, type: media.type, reason },
        };
      }
      const result = await voice.transcribe(path);
      if (!result.ok || !result.text) {
        const reason = 'the audio could not be transcribed';
        return {
          section: `[Voice note: ${name} — saved at ${path}, but could not be transcribed: ${result.error ?? reason}.]`,
          failure: { name, type: media.type, reason },
        };
      }
      return { section: `[Voice note: ${name} — transcript]\n${result.text}` };
    }

    // Lazy import: the gateway should not pay to load the extractor stack
    // (pdf.js / SheetJS) until a document actually arrives.
    const { getReadExtractManager } = await import('../tools/read-extract.js');
    const result = await getReadExtractManager().extract(path);

    if (!result.success) {
      const reason = result.error ?? 'unknown error';
      const alt = result.alternatives && result.alternatives.length > 0
        ? ` Instead: ${result.alternatives.join(' | ')}`
        : '';
      return {
        section: `[${labelFor(media)}: ${name} — saved at ${path}, but could not be extracted (${result.code ?? 'error'}): ${reason}${alt}]`,
        ...documentFailure(reason),
      };
    }

    const meta = result.metadata ?? {};
    const notes: string[] = [];
    if (meta.pages) notes.push(`${meta.pages} page(s)`);
    if (meta.sheets && meta.sheets.length > 0) notes.push(`sheets: ${meta.sheets.join(', ')}`);
    if (meta.slides) notes.push(`${meta.slides} slide(s)`);
    if (meta.truncated) notes.push('truncated');
    const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';

    return { section: `[${labelFor(media)}: ${name}${suffix} — saved at ${path}]\n${result.text}` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      section: `[${labelFor(media)}: ${name} could not be read — ${reason}]`,
      ...documentFailure(reason),
    };
  }
}

/** The effective inbound-attachment policy (config `gateway.inboundAttachments`). */
export interface InboundAttachmentPolicy {
  /** When false, attachments are accepted but never downloaded or extracted. */
  enabled: boolean;
  /** Per-attachment byte cap (default MAX_INBOUND_MEDIA_BYTES). */
  maxBytes: number;
}

/**
 * Read the effective inbound-attachment policy from config. Never throws — an
 * absent config (or a throwing ConfigManager) means the safe default: enabled,
 * with the module's own cap.
 */
export function inboundAttachmentPolicy(cm?: { getAll?: () => unknown }): InboundAttachmentPolicy {
  try {
    const cfg = (cm?.getAll?.() as
      | { gateway?: { inboundAttachments?: { enabled?: boolean; maxBytes?: number } } }
      | undefined)?.gateway?.inboundAttachments;
    const maxBytes =
      typeof cfg?.maxBytes === 'number' && Number.isFinite(cfg.maxBytes) && cfg.maxBytes > 0
        ? cfg.maxBytes
        : MAX_INBOUND_MEDIA_BYTES;
    return { enabled: cfg?.enabled !== false, maxBytes };
  } catch {
    return { enabled: true, maxBytes: MAX_INBOUND_MEDIA_BYTES };
  }
}

/** A remote attachment to fetch before hydration (Discord CDN URL / Slack file). */
export interface RemoteAttachment {
  /** The attachment's media kind (already classified by the caller). */
  type: InboundMedia['type'];
  url: string;
  filename?: string;
  mimetype?: string;
  size?: number;
  /** True when fetching the URL needs an Authorization bearer token (Slack). */
  authenticated?: boolean;
  /** The token to send when `authenticated` (the caller supplies its own). */
  token?: string;
}

/**
 * Download a remote attachment's bytes (never throws — null on any failure or
 * an over-cap size). Shared by the webhook receiver and the real-time Discord
 * gateway / Slack Socket Mode transports, so one code path fetches every
 * inbound attachment.
 */
export async function downloadInboundAttachment(att: RemoteAttachment): Promise<InboundMedia | null> {
  if (att.size !== undefined && att.size > MAX_INBOUND_MEDIA_BYTES) return null;
  try {
    const headers: Record<string, string> = {};
    if (att.authenticated) {
      if (!att.token) return null;
      headers.authorization = `Bearer ${att.token}`;
    }
    const res = await fetch(att.url, { headers });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_INBOUND_MEDIA_BYTES) return null;
    return { type: att.type, data: buf, filename: att.filename, mimetype: att.mimetype };
  } catch {
    return null;
  }
}

/** What a sandbox sweep did (returned for the caller's log line). */
export interface InboundPruneResult {
  removed: number;
  bytesFreed: number;
  kept: number;
}

/** Best-effort delete (never throws). */
function removeFile(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sweep the inbound artifact sandbox: remove files older than `maxAgeMs`, then
 * (if still over `maxBytes`) the OLDEST of what remains until it fits. Safe to
 * call on a schedule — never throws, and a file that cannot be removed is
 * skipped rather than aborting the sweep.
 */
export function pruneInboundMedia(
  opts: { maxAgeMs?: number; maxBytes?: number; now?: number } = {},
): InboundPruneResult {
  const maxAgeMs = opts.maxAgeMs ?? INBOUND_MEDIA_TTL_MS;
  const maxBytes = opts.maxBytes ?? INBOUND_MEDIA_MAX_BYTES;
  const now = opts.now ?? Date.now();
  const result: InboundPruneResult = { removed: 0, bytesFreed: 0, kept: 0 };

  let dir: string;
  try {
    dir = artifactsDir('inbound');
  } catch {
    return result;
  }

  let entries: Array<{ path: string; mtimeMs: number; size: number }>;
  try {
    entries = readdirSync(dir)
      .map((entry) => {
        const full = join(dir, entry);
        const stat = statSync(full);
        return stat.isFile() ? { path: full, mtimeMs: stat.mtimeMs, size: stat.size } : null;
      })
      .filter((e): e is { path: string; mtimeMs: number; size: number } => e !== null);
  } catch {
    return result;
  }

  // 1. Age: anything past the TTL goes.
  const survivors: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) {
      if (removeFile(entry.path)) {
        result.removed += 1;
        result.bytesFreed += entry.size;
      }
    } else {
      survivors.push(entry);
    }
  }

  // 2. Size: oldest-first until under the cap.
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = survivors.reduce((n, e) => n + e.size, 0);
  let swept = 0;
  while (total > maxBytes && swept < survivors.length) {
    const entry = survivors[swept];
    if (removeFile(entry.path)) {
      result.removed += 1;
      result.bytesFreed += entry.size;
      total -= entry.size;
    }
    swept += 1;
  }

  result.kept = survivors.length - swept;
  return result;
}
