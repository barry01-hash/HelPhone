/**
 * src/lib/watermark.ts — Image authenticity watermarking (#537).
 *
 * Two layers are added to an image canvas before upload:
 *
 *  1. A VISIBLE overlay: timestamp, a short cryptographic timestamp hash and,
 *     only if the caller opts in, coarsened coordinates.
 *  2. An INVISIBLE steganographic payload written into the least-significant
 *     bit of the R, G and B channels. The payload records the timestamp, a
 *     nonce and a SHA-256 digest of the image pixels with those LSBs cleared,
 *     so the digest does not depend on the payload it lives in.
 *
 * Verification re-extracts the payload, recomputes the digest to detect pixel
 * tampering, then (optionally) checks the payload's id against a ledger record.
 *
 * Limits, by design:
 *  - LSB embedding does NOT survive lossy re-encoding (JPEG/WebP) or resizing.
 *    Watermarked images must be stored losslessly (PNG); `imageProcessor`
 *    enforces this. A stripped or destroyed watermark verifies as
 *    'no-watermark' / 'corrupted' — it is tamper-EVIDENT, not tamper-proof.
 *  - Trust comes from the ledger: anyone can embed a self-consistent payload,
 *    but only a payload registered on the ledger verifies as 'authentic'.
 *  - Privacy: the app strips EXIF/GPS on purpose, so location is never
 *    included unless `includeLocation` is set, and is rounded to 2 decimals
 *    (~1.1 km) even then.
 */
import type {
  LedgerWatermarkRecord,
  WatermarkPayload,
  WatermarkVerification,
} from '../types/index'

export const WATERMARK_MAGIC = [0x48, 0x50, 0x57, 0x4d] // "HPWM"
export const WATERMARK_VERSION = 1
/** Header = magic(4) + version(1) + payload length(2). Trailer = CRC32(4). */
const HEADER_BYTES = 7
const CRC_BYTES = 4
export const MAX_PAYLOAD_BYTES = 1024
/** Location is rounded to this many decimals (≈1.1 km at 2). */
export const LOCATION_DECIMALS = 2

export interface PixelBuffer {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

// ── Hashing ──────────────────────────────────────────────────────────────────

const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return toHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

let crcTable: Uint32Array | null = null
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * SHA-256 over dimensions plus the R,G,B channels with their LSB cleared. Alpha
 * is ignored (the watermark pass works on opaque pixels). Invariant under
 * embedding, so it can be stored inside the payload.
 */
export async function maskedPixelDigest(px: PixelBuffer): Promise<string> {
  const pixels = px.width * px.height
  const out = new Uint8Array(8 + pixels * 3)
  new DataView(out.buffer).setUint32(0, px.width)
  new DataView(out.buffer).setUint32(4, px.height)
  let o = 8
  for (let i = 0; i < pixels; i++) {
    out[o++] = px.data[i * 4] & 0xfe
    out[o++] = px.data[i * 4 + 1] & 0xfe
    out[o++] = px.data[i * 4 + 2] & 0xfe
  }
  return sha256Hex(out)
}

// ── Payload ──────────────────────────────────────────────────────────────────

export interface PayloadInput {
  /** Unix seconds. */
  timestamp: number
  /** Digest from `maskedPixelDigest`. */
  digest: string
  nonce: string
  /** Opt-in; rounded to LOCATION_DECIMALS. */
  location?: { lat: number; lng: number } | null
  requestId?: string
}

/** Round to the privacy grid and store as integer hundredths of a degree. */
export function coarsenLocation(loc: { lat: number; lng: number }): [number, number] {
  const scale = 10 ** LOCATION_DECIMALS
  return [Math.round(loc.lat * scale), Math.round(loc.lng * scale)]
}

export function randomNonce(bytes = 8): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** The "cryptographic timestamp hash": SHA-256 of `${timestamp}:${nonce}`. */
export function timestampHash(timestamp: number, nonce: string): Promise<string> {
  return sha256Hex(`${timestamp}:${nonce}`)
}

export async function buildPayload(input: PayloadInput): Promise<WatermarkPayload> {
  if (!Number.isInteger(input.timestamp) || input.timestamp < 0) throw new Error('timestamp must be a non-negative integer (unix seconds)')
  if (!/^[0-9a-f]{64}$/.test(input.digest)) throw new Error('digest must be a 64-char hex SHA-256')
  const payload: WatermarkPayload = {
    v: WATERMARK_VERSION,
    ts: input.timestamp,
    n: input.nonce,
    d: input.digest,
    h: await timestampHash(input.timestamp, input.nonce),
  }
  if (input.location) payload.loc = coarsenLocation(input.location)
  if (input.requestId) payload.rid = input.requestId
  return payload
}

/** Canonical bytes of a payload (fixed key order via `buildPayload`). */
export function payloadBytes(payload: WatermarkPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

/** Stable identifier registered on the ledger: SHA-256 of the payload bytes. */
export function watermarkId(payload: WatermarkPayload): Promise<string> {
  return sha256Hex(payloadBytes(payload))
}

// ── Framing + LSB embedding ──────────────────────────────────────────────────

function frame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`Watermark payload too large (${payload.length} > ${MAX_PAYLOAD_BYTES} bytes)`)
  const out = new Uint8Array(HEADER_BYTES + payload.length + CRC_BYTES)
  out.set(WATERMARK_MAGIC, 0)
  out[4] = WATERMARK_VERSION
  out[5] = payload.length >> 8
  out[6] = payload.length & 0xff
  out.set(payload, HEADER_BYTES)
  new DataView(out.buffer).setUint32(HEADER_BYTES + payload.length, crc32(payload))
  return out
}

/** Number of payload bytes an image can hold (1 bit per R/G/B byte). */
export function capacityBytes(width: number, height: number): number {
  return Math.max(0, Math.floor((width * height * 3) / 8) - HEADER_BYTES - CRC_BYTES)
}

/** Write `payload` into a COPY of the pixels' RGB least-significant bits. */
export function embedWatermark(px: PixelBuffer, payload: Uint8Array): Uint8ClampedArray {
  const framed = frame(payload)
  if (framed.length - HEADER_BYTES - CRC_BYTES > capacityBytes(px.width, px.height)) {
    throw new Error('Image too small to hold the watermark')
  }
  const out = new Uint8ClampedArray(px.data)
  let bit = 0
  const total = framed.length * 8
  for (let i = 0; i < out.length && bit < total; i++) {
    if (i % 4 === 3) continue // skip alpha
    const value = (framed[bit >> 3] >> (7 - (bit & 7))) & 1
    out[i] = (out[i] & 0xfe) | value
    bit++
  }
  return out
}

function readBytes(px: PixelBuffer, startByte: number, count: number): Uint8Array | null {
  const out = new Uint8Array(count)
  const capacityBits = Math.floor((px.width * px.height * 3))
  for (let b = 0; b < count * 8; b++) {
    const bit = startByte * 8 + b
    if (bit >= capacityBits) return null
    const channel = bit + Math.floor(bit / 3) // skip every 4th (alpha) byte
    out[b >> 3] |= (px.data[channel] & 1) << (7 - (b & 7))
  }
  return out
}

export type ExtractResult =
  | { kind: 'none' }
  | { kind: 'corrupted' }
  | { kind: 'ok'; bytes: Uint8Array }

/** Read the embedded payload back, validating magic, version, length and CRC. */
export function extractWatermark(px: PixelBuffer): ExtractResult {
  const header = readBytes(px, 0, HEADER_BYTES)
  if (!header || WATERMARK_MAGIC.some((m, i) => header[i] !== m)) return { kind: 'none' }
  const length = (header[5] << 8) | header[6]
  if (header[4] !== WATERMARK_VERSION || length === 0 || length > MAX_PAYLOAD_BYTES) return { kind: 'corrupted' }
  const body = readBytes(px, HEADER_BYTES, length + CRC_BYTES)
  if (!body) return { kind: 'corrupted' }
  const bytes = body.slice(0, length)
  if (new DataView(body.buffer).getUint32(length) !== crc32(bytes)) return { kind: 'corrupted' }
  return { kind: 'ok', bytes }
}

// ── Visible overlay ──────────────────────────────────────────────────────────

/** Minimal 2D-context surface the engine needs (real or OffscreenCanvas). */
export interface WatermarkContext {
  canvas?: { width: number; height: number }
  fillStyle: unknown
  font: string
  textBaseline: string
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  getImageData(x: number, y: number, w: number, h: number): PixelBuffer
  putImageData(data: unknown, x: number, y: number): void
}

export function overlayLines(payload: WatermarkPayload): string[] {
  const lines = [`${new Date(payload.ts * 1000).toISOString()}`, `hash ${payload.h.slice(0, 16)}`]
  if (payload.loc) {
    const scale = 10 ** LOCATION_DECIMALS
    lines.push(`~${(payload.loc[0] / scale).toFixed(LOCATION_DECIMALS)}, ${(payload.loc[1] / scale).toFixed(LOCATION_DECIMALS)}`)
  }
  return lines
}

export function drawOverlay(ctx: WatermarkContext, width: number, height: number, lines: string[]): void {
  const fontPx = Math.max(10, Math.round(Math.min(width, height) / 45))
  const pad = Math.round(fontPx * 0.5)
  const lineH = fontPx + 2
  const boxH = lines.length * lineH + pad * 2
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fillRect(0, height - boxH, width, boxH)
  ctx.fillStyle = '#ffffff'
  ctx.font = `${fontPx}px monospace`
  ctx.textBaseline = 'top'
  lines.forEach((line, i) => ctx.fillText(line, pad, height - boxH + pad + i * lineH))
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface WatermarkOptions {
  /** Unix seconds; defaults to now. Injectable for tests and replays. */
  timestamp?: number
  /** Only stamped when `includeLocation` is true. */
  location?: { lat: number; lng: number } | null
  /** Explicit opt-in. Defaults to false: no coordinates in pixels. */
  includeLocation?: boolean
  requestId?: string
  /** Draw the human-readable overlay (default true). */
  visible?: boolean
  /** Injectable for deterministic tests. */
  nonce?: string
}

export interface WatermarkResult {
  payload: WatermarkPayload
  /** Identifier to register on the ledger. */
  id: string
  /** Digest of the final pixels (LSBs masked). */
  digest: string
}

/**
 * Stamp an already-drawn, OPAQUE canvas: overlay → digest → embed → write back.
 * Call it after the image is drawn and before encoding to a lossless blob.
 */
export async function applyWatermark(ctx: WatermarkContext, width: number, height: number, opts: WatermarkOptions = {}): Promise<WatermarkResult> {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000)
  const nonce = opts.nonce ?? randomNonce()
  const location = opts.includeLocation ? opts.location ?? null : null
  if (opts.includeLocation && location && (!Number.isFinite(location.lat) || !Number.isFinite(location.lng))) {
    throw new Error('location must have finite lat/lng')
  }

  // The overlay only needs fields that don't depend on the image digest.
  if (opts.visible !== false) {
    const preview = await buildPayload({ timestamp, nonce, digest: '0'.repeat(64), location })
    drawOverlay(ctx, width, height, overlayLines(preview))
  }

  const pixels = ctx.getImageData(0, 0, width, height)
  const digest = await maskedPixelDigest(pixels)
  const payload = await buildPayload({ timestamp, nonce, digest, location, requestId: opts.requestId })
  const stamped = embedWatermark(pixels, payloadBytes(payload))
  ctx.putImageData(makeImageData(stamped, width, height), 0, 0)
  return { payload, id: await watermarkId(payload), digest }
}

function makeImageData(data: Uint8ClampedArray, width: number, height: number): unknown {
  return typeof ImageData !== 'undefined' ? new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height) : { data, width, height }
}

// ── Verification ─────────────────────────────────────────────────────────────

export type LedgerLookup = (id: string) => Promise<LedgerWatermarkRecord | null | undefined>

function isPayload(v: unknown): v is WatermarkPayload {
  const p = v as WatermarkPayload
  return (
    !!p && p.v === WATERMARK_VERSION && Number.isInteger(p.ts) && typeof p.n === 'string' &&
    /^[0-9a-f]{64}$/.test(p.d) && /^[0-9a-f]{64}$/.test(p.h) &&
    (p.loc === undefined || (Array.isArray(p.loc) && p.loc.length === 2 && p.loc.every(Number.isInteger))) &&
    (p.rid === undefined || typeof p.rid === 'string')
  )
}

/**
 * Validate an image's watermark. Statuses:
 *  - 'no-watermark'    nothing embedded (or it was stripped)
 *  - 'corrupted'       header/CRC/JSON/hash-chain invalid
 *  - 'tampered'        pixels no longer match the digest in the payload
 *  - 'ledger-unchecked' internally consistent; no ledger lookup supplied
 *  - 'unregistered'    consistent but the ledger has no such record
 *  - 'ledger-mismatch' the ledger record disagrees with the payload
 *  - 'authentic'       consistent and matches a ledger record
 */
export async function verifyWatermark(px: PixelBuffer, lookup?: LedgerLookup): Promise<WatermarkVerification> {
  const extracted = extractWatermark(px)
  if (extracted.kind === 'none') return { status: 'no-watermark' }
  if (extracted.kind === 'corrupted') return { status: 'corrupted' }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(extracted.bytes))
  } catch {
    return { status: 'corrupted' }
  }
  if (!isPayload(payload)) return { status: 'corrupted' }
  if (payload.h !== (await timestampHash(payload.ts, payload.n))) return { status: 'corrupted', payload }
  if (payload.d !== (await maskedPixelDigest(px))) return { status: 'tampered', payload }

  const id = await watermarkId(payload)
  if (!lookup) return { status: 'ledger-unchecked', payload, id }

  const record = await lookup(id)
  if (!record) return { status: 'unregistered', payload, id }
  if (record.digest !== payload.d || record.timestamp !== payload.ts) return { status: 'ledger-mismatch', payload, id, record }
  return { status: 'authentic', payload, id, record }
}
