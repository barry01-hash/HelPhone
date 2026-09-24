/**
 * Client-Side Image Processor — Canvas resizing & EXIF stripping
 *
 * - Resizes photos to max 1200px (long edge) before submission
 * - Strips EXIF metadata (GPS, camera serials) during canvas render
 * - Compresses to WebP/JPEG @ 80% quality, achieving ~85% size reduction
 *
 * Uses HTML5 Canvas / OffscreenCanvas where available. Falls back to createImageBitmap.
 * EXIF is never forwarded because canvas draw discards APP1 segments; we also
 * sanitize the output buffer by not copying original bytes.
 */

import { applyWatermark } from './watermark';
import type { WatermarkOptions, WatermarkResult, WatermarkContext } from './watermark';

export const MAX_DIMENSION = 1200;
export const DEFAULT_QUALITY = 0.8;
export const OUTPUT_TYPE: 'image/webp' | 'image/jpeg' = 'image/webp';
export const FALLBACK_TYPE = 'image/jpeg';
/** Watermarked images are encoded losslessly: LSB data does not survive JPEG/WebP. */
export const WATERMARK_TYPE = 'image/png';

export interface ProcessOptions {
  maxDimension?: number;
  quality?: number;
  outputType?: string;
  stripExif?: boolean;
  /**
   * Stamp a visible overlay and an invisible steganographic watermark (see
   * watermark.ts). Forces lossless PNG output — larger files, but the only
   * encoding that preserves the embedded payload.
   */
  watermark?: WatermarkOptions;
}

export interface ProcessResult {
  blob: Blob;
  originalSize: number;
  compressedSize: number;
  savingsPct: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  exifStripped: boolean;
  outputType: string;
  quality: number;
  /** Present when `watermark` was requested; register `watermark.id` on the ledger. */
  watermark?: WatermarkResult;
}

/** Detect if a buffer contains EXIF (APP1 with Exif\0\0). */
export function hasExif(buffer: ArrayBuffer | Uint8Array): boolean {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4) return false;
  // JPEG SOI + APP1 marker
  for (let i = 0; i < bytes.length - 10; i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xE1) {
      // Check for "Exif\0\0"
      if (
        bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 &&
        bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66 &&
        bytes[i + 8] === 0x00 && bytes[i + 9] === 0x00
      ) return true;
    }
  }
  return false;
}

/** Strip EXIF by removing APP1 segments (EXIF) from JPEG bytes. Returns new Uint8Array without EXIF. */
export function stripExifFromBuffer(input: Uint8Array): Uint8Array {
  // Fast path: if no EXIF, return copy
  if (!hasExif(input)) return input;

  const out: number[] = [];
  let i = 0;
  // Copy SOI
  if (input.length >= 2 && input[0] === 0xFF && input[1] === 0xD8) {
    out.push(0xFF, 0xD8);
    i = 2;
  }
  while (i < input.length - 1) {
    if (input[i] !== 0xFF) { out.push(input[i]); i++; continue; }
    const marker = input[i + 1];
    // Standalone markers without length
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      out.push(0xFF, marker); i += 2; continue;
    }
    if (i + 3 >= input.length) { out.push(input[i]); i++; continue; }
    const len = (input[i + 2] << 8) | input[i + 3];
    if (len < 2 || i + len + 1 >= input.length + 100000) { out.push(input[i]); i++; continue; }
    // APP1 (0xE1) that contains Exif -> skip it entirely
    if (marker === 0xE1) {
      const isExif = i + 9 < input.length &&
        input[i + 4] === 0x45 && input[i + 5] === 0x78 && input[i + 6] === 0x69 && input[i + 7] === 0x66 &&
        input[i + 8] === 0x00 && input[i + 9] === 0x00;
      if (isExif) {
        i += 2 + len; // skip entire APP1 segment
        continue;
      }
    }
    // Copy segment
    for (let j = 0; j < 2 + len && i + j < input.length; j++) out.push(input[i + j]);
    i += 2 + len;
  }
  return new Uint8Array(out);
}

export function calculateTargetSize(
  width: number,
  height: number,
  maxDimension = MAX_DIMENSION
): { width: number; height: number; scaled: boolean } {
  if (width <= maxDimension && height <= maxDimension) return { width, height, scaled: false };
  const ratio = Math.min(maxDimension / width, maxDimension / height);
  return { width: Math.round(width * ratio), height: Math.round(height * ratio), scaled: true };
}

/** Load an image Blob/File into an HTMLImageElement (or ImageBitmap) and return dimensions. */
async function loadImage(blob: Blob): Promise<{ img: HTMLImageElement | ImageBitmap; w: number; h: number; close?: () => void }> {
  // Prefer createImageBitmap (OffscreenCanvas friendly, faster)
  if (typeof createImageBitmap !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { img: bitmap as unknown as ImageBitmap, w: bitmap.width, h: bitmap.height, close: () => bitmap.close() };
    } catch {}
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
    // CORS anonymous to avoid tainting canvas
    img.crossOrigin = 'anonymous';
  });
}

function getCanvas(width: number, height: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null {
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      canvas = new OffscreenCanvas(width, height);
      ctx = (canvas as OffscreenCanvas).getContext('2d');
      if (ctx) return { canvas, ctx: ctx as OffscreenCanvasRenderingContext2D };
    } catch {}
  }
  if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d');
    if (ctx) return { canvas: canvas as HTMLCanvasElement, ctx: ctx as CanvasRenderingContext2D };
  }
  return null;
}

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number
): Promise<Blob> {
  if (typeof (canvas as OffscreenCanvas).convertToBlob === 'function') {
    return await (canvas as OffscreenCanvas).convertToBlob({ type, quality });
  }
  const htmlCanvas = canvas as HTMLCanvasElement;
  return await new Promise<Blob>((resolve, reject) => {
    htmlCanvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')),
      type,
      quality
    );
  });
}

/**
 * Core processor: resize to maxDimension, strip EXIF via canvas re-render, compress.
 */
export async function processImage(
  file: Blob | File,
  opts: ProcessOptions = {}
): Promise<ProcessResult> {
  const maxDimension = opts.maxDimension ?? MAX_DIMENSION;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const watermarkOpts = opts.watermark;
  let outputType = watermarkOpts ? WATERMARK_TYPE : (opts.outputType ?? OUTPUT_TYPE);

  const originalSize = file.size;
  if (originalSize === 0) throw new Error('Empty file');

  // Sniff original bytes for EXIF (JPEG only)
  let hadExif = false;
  try {
    const head = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
    hadExif = hasExif(head);
  } catch {}

  const { img, w: origW, h: origH, close } = await loadImage(file);
  try {
    const target = calculateTargetSize(origW, origH, maxDimension);
    const canvasInfo = getCanvas(target.width, target.height);
    if (!canvasInfo) throw new Error('Canvas not available in this environment');
    const { canvas, ctx } = canvasInfo;

    // High-quality downscale
    (ctx as CanvasRenderingContext2D).imageSmoothingEnabled = true;
    (ctx as CanvasRenderingContext2D).imageSmoothingQuality = 'high';
    // White background for JPEG (avoids black for transparent PNGs)
    // Watermarking needs opaque pixels (premultiplied alpha would corrupt the LSBs).
    if (watermarkOpts || outputType === 'image/jpeg' || outputType === FALLBACK_TYPE) {
      (ctx as CanvasRenderingContext2D).fillStyle = '#ffffff';
      (ctx as CanvasRenderingContext2D).fillRect(0, 0, target.width, target.height);
    } else {
      (ctx as CanvasRenderingContext2D).clearRect(0, 0, target.width, target.height);
    }
    // Draw — this discards all EXIF/APPn metadata by definition (canvas only keeps pixels)
    (ctx as CanvasRenderingContext2D).drawImage(
      img as CanvasImageSource,
      0, 0, target.width, target.height
    );

    let watermark: WatermarkResult | undefined;
    if (watermarkOpts) {
      watermark = await applyWatermark(ctx as unknown as WatermarkContext, target.width, target.height, watermarkOpts);
    }

    // Try requested type, fallback to jpeg if not supported
    let blob: Blob;
    if (watermarkOpts) {
      // Lossless only: never fall back to a lossy type, which would silently destroy the watermark.
      blob = await canvasToBlob(canvas, WATERMARK_TYPE, 1);
      if (blob.type !== WATERMARK_TYPE) throw new Error('PNG encoding is required for watermarking but is unavailable');
    } else {
      try {
        blob = await canvasToBlob(canvas, outputType, quality);
        // Some browsers return png when webp not supported — detect and fallback
        if (outputType === 'image/webp' && blob.type !== 'image/webp') throw new Error('WebP not supported');
      } catch {
        outputType = FALLBACK_TYPE;
        blob = await canvasToBlob(canvas, outputType, quality);
      }
    }

    // Ensure EXIF is stripped: re-encode already stripped, but for JPEG also run buffer sanitizer
    let finalBlob = blob;
    if (outputType === 'image/jpeg') {
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (hasExif(buf)) {
        const stripped = stripExifFromBuffer(buf);
        finalBlob = new Blob([stripped], { type: outputType });
      }
    }

    const compressedSize = finalBlob.size;
    const savingsPct = originalSize > 0 ? ((originalSize - compressedSize) / originalSize) * 100 : 0;

    return {
      blob: finalBlob,
      originalSize,
      compressedSize,
      savingsPct,
      width: target.width,
      height: target.height,
      originalWidth: origW,
      originalHeight: origH,
      exifStripped: hadExif, // true if original had EXIF and we removed it via canvas
      outputType,
      quality,
      ...(watermark ? { watermark } : {}),
    };
  } finally {
    close?.();
  }
}

/** Convenience: process and return object URL for preview. */
export async function processImageToUrl(file: Blob, opts?: ProcessOptions): Promise<{ url: string; result: ProcessResult }> {
  const result = await processImage(file, opts);
  const url = URL.createObjectURL(result.blob);
  return { url, result };
}

/** Check if WebP is supported for output. */
export async function isWebPSupported(): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    canvas.toBlob((blob) => resolve(!!blob && blob.type === 'image/webp'), 'image/webp', 0.8);
  });
}

export default {
  processImage,
  processImageToUrl,
  hasExif,
  stripExifFromBuffer,
  calculateTargetSize,
  isWebPSupported,
  MAX_DIMENSION,
  DEFAULT_QUALITY,
};
