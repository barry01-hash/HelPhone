// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sha256Hex,
  crc32,
  maskedPixelDigest,
  coarsenLocation,
  timestampHash,
  buildPayload,
  payloadBytes,
  watermarkId,
  capacityBytes,
  embedWatermark,
  extractWatermark,
  overlayLines,
  drawOverlay,
  applyWatermark,
  verifyWatermark,
  randomNonce,
  MAX_PAYLOAD_BYTES,
  WATERMARK_MAGIC,
} from "../src/lib/watermark.ts";
import { processImage, WATERMARK_TYPE } from "../src/lib/imageProcessor.ts";

const W = 64;
const H = 64;
const NONCE = "0011223344556677";
const TS = 1_780_000_000;

/** Deterministic pseudo-photo so tests are reproducible. */
function makePixels(w = W, h = H) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = i % 4 === 3 ? 255 : (seed >> 8) & 0xff;
  }
  return { data, width: w, height: h };
}

/** A 2D-context double backed by a pixel buffer; fillText "draws" by mutating pixels. */
function makeCtx(px = makePixels()) {
  const ctx = {
    px,
    calls: [],
    fillStyle: "",
    font: "",
    textBaseline: "",
    fillRect: vi.fn(function () {
      ctx.calls.push("fillRect");
    }),
    fillText: vi.fn(function (t) {
      ctx.calls.push(`text:${t}`);
      ctx.px.data[0] = 7; // overlay changes real pixels, so the digest must cover it
    }),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(ctx.px.data),
      width: ctx.px.width,
      height: ctx.px.height,
    })),
    putImageData: vi.fn((img) => {
      ctx.px = { data: img.data, width: img.width, height: img.height };
    }),
  };
  return ctx;
}

async function stamp(over = {}) {
  const ctx = makeCtx();
  const result = await applyWatermark(ctx, W, H, {
    timestamp: TS,
    nonce: NONCE,
    ...over,
  });
  return { ctx, result, px: ctx.px };
}

describe("primitives", () => {
  it("matches known SHA-256 and CRC-32 test vectors", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("hashes timestamp+nonce deterministically and generates random nonces", async () => {
    expect(await timestampHash(TS, NONCE)).toBe(
      await sha256Hex(`${TS}:${NONCE}`),
    );
    expect(randomNonce()).toMatch(/^[0-9a-f]{16}$/);
    expect(randomNonce(4)).toMatch(/^[0-9a-f]{8}$/);
    expect(randomNonce()).not.toBe(randomNonce());
  });

  it("rounds coordinates to a ~1 km grid as integer hundredths of a degree", () => {
    expect(coarsenLocation({ lat: 6.52437, lng: 3.37921 })).toEqual([652, 338]);
    expect(coarsenLocation({ lat: -33.8688, lng: 151.2093 })).toEqual([
      -3387, 15121,
    ]);
  });

  it("masked digest ignores RGB LSBs and alpha but not upper bits or dimensions", async () => {
    const a = makePixels();
    const base = await maskedPixelDigest(a);

    const lsb = { ...a, data: new Uint8ClampedArray(a.data) };
    lsb.data[10] ^= 1;
    lsb.data[3] = 0; // alpha
    expect(await maskedPixelDigest(lsb)).toBe(base);

    const high = { ...a, data: new Uint8ClampedArray(a.data) };
    high.data[10] ^= 2;
    expect(await maskedPixelDigest(high)).not.toBe(base);

    expect(await maskedPixelDigest({ ...a, width: 32, height: 128 })).not.toBe(
      base,
    );
  });
});

describe("payload", () => {
  const digest = "a".repeat(64);

  it("builds a versioned payload with the timestamp hash, omitting optional fields", async () => {
    const p = await buildPayload({ timestamp: TS, nonce: NONCE, digest });
    expect(p).toEqual({
      v: 1,
      ts: TS,
      n: NONCE,
      d: digest,
      h: await timestampHash(TS, NONCE),
    });
    expect(Object.keys(p)).toEqual(["v", "ts", "n", "d", "h"]);
  });

  it("includes coarse location and request id when given", async () => {
    const p = await buildPayload({
      timestamp: TS,
      nonce: NONCE,
      digest,
      location: { lat: 6.5243, lng: 3.3792 },
      requestId: "42",
    });
    expect(p.loc).toEqual([652, 338]);
    expect(p.rid).toBe("42");
  });

  it.each([
    [{ timestamp: -1, nonce: NONCE, digest }, /timestamp/],
    [{ timestamp: 1.5, nonce: NONCE, digest }, /timestamp/],
    [{ timestamp: TS, nonce: NONCE, digest: "xyz" }, /digest/],
  ])("rejects invalid input %#", async (input, msg) => {
    await expect(buildPayload(input)).rejects.toThrow(msg);
  });

  it("derives a stable ledger id from the payload bytes", async () => {
    const p = await buildPayload({ timestamp: TS, nonce: NONCE, digest });
    expect(await watermarkId(p)).toBe(await sha256Hex(payloadBytes(p)));
    const q = await buildPayload({ timestamp: TS + 1, nonce: NONCE, digest });
    expect(await watermarkId(q)).not.toBe(await watermarkId(p));
  });
});

describe("LSB embedding", () => {
  const bytes = new TextEncoder().encode('{"hello":"world"}');

  it("round-trips a payload", () => {
    const px = makePixels();
    const stamped = { ...px, data: embedWatermark(px, bytes) };
    const out = extractWatermark(stamped);
    expect(out.kind).toBe("ok");
    expect(new TextDecoder().decode(out.bytes)).toBe('{"hello":"world"}');
  });

  it("changes only RGB least-significant bits and never touches alpha or the input", () => {
    const px = makePixels();
    const before = new Uint8ClampedArray(px.data);
    const out = embedWatermark(px, bytes);
    expect(px.data).toEqual(before);
    for (let i = 0; i < out.length; i++) {
      if (i % 4 === 3) expect(out[i]).toBe(px.data[i]);
      else expect(Math.abs(out[i] - px.data[i])).toBeLessThanOrEqual(1);
    }
  });

  it("reports no watermark on an image that has none", () => {
    expect(extractWatermark(makePixels()).kind).toBe("none");
    expect(
      extractWatermark({ data: new Uint8ClampedArray(4), width: 1, height: 1 })
        .kind,
    ).toBe("none");
  });

  it("detects corruption via CRC, bad version, bad length and truncation", () => {
    const px = makePixels();
    const stamped = embedWatermark(px, bytes);
    const flip = (bitIndex) => {
      const d = new Uint8ClampedArray(stamped);
      const idx = bitIndex + Math.floor(bitIndex / 3);
      d[idx] ^= 1;
      return { ...px, data: d };
    };
    expect(extractWatermark(flip(7 * 8 + 3)).kind).toBe("corrupted"); // payload bit
    expect(extractWatermark(flip(4 * 8 + 7)).kind).toBe("corrupted"); // version byte
    expect(extractWatermark(flip(5 * 8 + 0)).kind).toBe("corrupted"); // length high byte → out of range

    // Length claims more data than the image holds.
    const tiny = makePixels(16, 16);
    const forged = embedWatermark(tiny, new Uint8Array(3));
    const claim = new Uint8ClampedArray(forged);
    for (let b = 0; b < 8; b++) {
      const bit = 6 * 8 + b; // low length byte := 0xFF
      const idx = bit + Math.floor(bit / 3);
      claim[idx] = (claim[idx] & 0xfe) | 1;
    }
    expect(extractWatermark({ ...tiny, data: claim }).kind).toBe("corrupted");
  });

  it("enforces capacity and the payload size cap", () => {
    expect(capacityBytes(64, 64)).toBe(Math.floor((64 * 64 * 3) / 8) - 11);
    expect(capacityBytes(1, 1)).toBe(0);
    expect(() => embedWatermark(makePixels(4, 4), new Uint8Array(200))).toThrow(
      /too small/,
    );
    expect(() =>
      embedWatermark(makePixels(), new Uint8Array(MAX_PAYLOAD_BYTES + 1)),
    ).toThrow(/too large/);
    expect(WATERMARK_MAGIC).toEqual([0x48, 0x50, 0x57, 0x4d]);
  });
});

describe("overlay", () => {
  it("shows timestamp and hash, and coarse location only when present", async () => {
    const base = await buildPayload({
      timestamp: TS,
      nonce: NONCE,
      digest: "a".repeat(64),
    });
    const lines = overlayLines(base);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(new Date(TS * 1000).toISOString());
    expect(lines[1]).toBe(`hash ${base.h.slice(0, 16)}`);

    const withLoc = overlayLines({ ...base, loc: [652, 338] });
    expect(withLoc[2]).toBe("~6.52, 3.38");
  });

  it("draws a translucent banner and one text line per entry, scaling the font to the image", () => {
    const ctx = makeCtx();
    drawOverlay(ctx, 900, 450, ["a", "b"]);
    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledTimes(2);
    expect(ctx.font).toBe("10px monospace");
    drawOverlay(ctx, 4500, 3000, ["a"]);
    expect(ctx.font).toBe("67px monospace");
  });
});

describe("applyWatermark", () => {
  it("draws the overlay, embeds a payload and returns a ledger id + digest", async () => {
    const { ctx, result, px } = await stamp();
    expect(ctx.calls.some((c) => c.startsWith("text:hash "))).toBe(true);
    expect(result.payload).toMatchObject({ v: 1, ts: TS, n: NONCE });
    expect(result.id).toBe(await watermarkId(result.payload));
    expect(result.digest).toBe(await maskedPixelDigest(px));
    expect(extractWatermark(px).kind).toBe("ok");
  });

  it("digest covers the overlay pixels (they are drawn before hashing)", async () => {
    const { result } = await stamp();
    const untouched = await maskedPixelDigest(makePixels());
    expect(result.digest).not.toBe(untouched);
  });

  it("is deterministic for a fixed timestamp and nonce", async () => {
    const a = await stamp();
    const b = await stamp();
    expect(a.result).toEqual(b.result);
    expect(a.px.data).toEqual(b.px.data);
  });

  it("uses the current time and a fresh nonce by default", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-24T12:00:00Z") });
    const ctx = makeCtx();
    const r = await applyWatermark(ctx, W, H);
    vi.useRealTimers();
    expect(r.payload.ts).toBe(
      Math.floor(Date.parse("2026-09-24T12:00:00Z") / 1000),
    );
    expect(r.payload.n).toMatch(/^[0-9a-f]{16}$/);
  });

  it("omits coordinates by default even when a location is supplied (privacy opt-in)", async () => {
    const { result, ctx } = await stamp({
      location: { lat: 6.52437, lng: 3.37921 },
    });
    expect(result.payload.loc).toBeUndefined();
    expect(ctx.calls.join()).not.toContain("~");
  });

  it("includes coarsened coordinates only with includeLocation", async () => {
    const { result, ctx } = await stamp({
      includeLocation: true,
      location: { lat: 6.52437, lng: 3.37921 },
      requestId: "77",
    });
    expect(result.payload.loc).toEqual([652, 338]);
    expect(result.payload.rid).toBe("77");
    expect(ctx.calls).toContain("text:~6.52, 3.38");
    expect(JSON.stringify(result.payload)).not.toContain("6.52437");
  });

  it("includeLocation without a location stamps no coordinates, and rejects non-finite ones", async () => {
    expect(
      (await stamp({ includeLocation: true })).result.payload.loc,
    ).toBeUndefined();
    await expect(
      stamp({ includeLocation: true, location: { lat: NaN, lng: 1 } }),
    ).rejects.toThrow(/finite/);
  });

  it("skips the visible overlay when visible is false but still embeds", async () => {
    const { ctx, px } = await stamp({ visible: false });
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(extractWatermark(px).kind).toBe("ok");
  });

  it("uses ImageData when the environment provides it", async () => {
    class FakeImageData {
      constructor(data, width, height) {
        Object.assign(this, { data, width, height, fake: true });
      }
    }
    vi.stubGlobal("ImageData", FakeImageData);
    const ctx = makeCtx();
    await applyWatermark(ctx, W, H, { timestamp: TS, nonce: NONCE });
    vi.unstubAllGlobals();
    expect(ctx.putImageData.mock.calls[0][0].fake).toBe(true);
  });
});

describe("verifyWatermark", () => {
  const record = (r) => ({
    digest: r.payload.d,
    timestamp: r.payload.ts,
    registrant: "GABC",
  });

  it("returns no-watermark for a plain image or one whose LSBs were rewritten", async () => {
    expect((await verifyWatermark(makePixels())).status).toBe("no-watermark");
    const { px } = await stamp();
    const stripped = {
      ...px,
      data: new Uint8ClampedArray(px.data).map((v, i) =>
        i % 4 === 3 ? v : v & 0xfe,
      ),
    };
    expect((await verifyWatermark(stripped)).status).toBe("no-watermark");
  });

  it("is ledger-unchecked when internally consistent and no lookup is given", async () => {
    const { px, result } = await stamp();
    const v = await verifyWatermark(px);
    expect(v).toMatchObject({ status: "ledger-unchecked", id: result.id });
    expect(v.payload).toEqual(result.payload);
  });

  it("is authentic when the ledger has a matching record", async () => {
    const { px, result } = await stamp();
    const lookup = vi.fn(async () => record(result));
    const v = await verifyWatermark(px, lookup);
    expect(v.status).toBe("authentic");
    expect(v.record.registrant).toBe("GABC");
    expect(lookup).toHaveBeenCalledWith(result.id);
  });

  it.each([[null], [undefined]])(
    "is unregistered when the ledger returns %s",
    async (missing) => {
      const { px } = await stamp();
      expect((await verifyWatermark(px, async () => missing)).status).toBe(
        "unregistered",
      );
    },
  );

  it("is ledger-mismatch when the record disagrees on digest or timestamp", async () => {
    const { px, result } = await stamp();
    expect(
      (
        await verifyWatermark(px, async () => ({
          ...record(result),
          digest: "b".repeat(64),
        }))
      ).status,
    ).toBe("ledger-mismatch");
    expect(
      (
        await verifyWatermark(px, async () => ({
          ...record(result),
          timestamp: TS + 5,
        }))
      ).status,
    ).toBe("ledger-mismatch");
  });

  it("detects pixel tampering above the LSB plane as tampered", async () => {
    const { px, result } = await stamp();
    const edited = { ...px, data: new Uint8ClampedArray(px.data) };
    edited.data[4000] ^= 0x10; // a visible edit
    const v = await verifyWatermark(edited, async () => record(result));
    expect(v.status).toBe("tampered");
    expect(v.payload.ts).toBe(TS);
  });

  it("detects noise in the LSB plane as corrupted", async () => {
    const { px } = await stamp();
    const noisy = { ...px, data: new Uint8ClampedArray(px.data) };
    for (let i = 60; i < 400; i += 3) noisy.data[i] ^= 1;
    expect((await verifyWatermark(noisy)).status).toBe("corrupted");
  });

  it("rejects a valid frame carrying malformed JSON or an invalid payload shape", async () => {
    const px = makePixels();
    const notJson = {
      ...px,
      data: embedWatermark(px, new TextEncoder().encode("not json")),
    };
    expect((await verifyWatermark(notJson)).status).toBe("corrupted");

    const wrongShape = {
      ...px,
      data: embedWatermark(px, new TextEncoder().encode('{"v":2}')),
    };
    expect((await verifyWatermark(wrongShape)).status).toBe("corrupted");

    for (const bad of [
      { loc: [1] },
      { loc: "x" },
      { rid: 5 },
      { d: "short" },
    ]) {
      const p = {
        ...(await buildPayload({
          timestamp: TS,
          nonce: NONCE,
          digest: "a".repeat(64),
        })),
        ...bad,
      };
      const img = {
        ...px,
        data: embedWatermark(px, new TextEncoder().encode(JSON.stringify(p))),
      };
      expect((await verifyWatermark(img)).status).toBe("corrupted");
    }
  });

  it("rejects a payload whose timestamp hash chain is broken", async () => {
    const px = makePixels();
    const digest = await maskedPixelDigest(px);
    const p = await buildPayload({ timestamp: TS, nonce: NONCE, digest });
    const forged = { ...p, ts: TS + 1 }; // h no longer matches ts:n
    const img = {
      ...px,
      data: embedWatermark(
        px,
        new TextEncoder().encode(JSON.stringify(forged)),
      ),
    };
    const v = await verifyWatermark(img);
    expect(v.status).toBe("corrupted");
    expect(v.payload.ts).toBe(TS + 1);
  });

  it("does not accept a self-made watermark as authentic without a ledger record", async () => {
    // An attacker can build a consistent payload, but the ledger will not know it.
    const { px } = await stamp({ nonce: "ffffffffffffffff" });
    expect((await verifyWatermark(px, async () => null)).status).toBe(
      "unregistered",
    );
  });
});

describe("processImage integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubBrowser({ blobType = "image/png" } = {}) {
    const ctx = makeCtx(makePixels(64, 64));
    Object.assign(ctx, {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "",
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    });
    const convertToBlob = vi.fn(
      async ({ type }) =>
        new Blob([new Uint8Array(10)], {
          type: blobType === "same" ? type : blobType,
        }),
    );
    class FakeOffscreen {
      constructor(w, h) {
        this.width = w;
        this.height = h;
        this.convertToBlob = convertToBlob;
      }
      getContext() {
        return ctx;
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    vi.stubGlobal("createImageBitmap", async () => ({
      width: 64,
      height: 64,
      close() {},
    }));
    return { ctx, convertToBlob };
  }

  it("watermarks on request: opaque background, lossless PNG, result carries the ledger id", async () => {
    const { ctx, convertToBlob } = stubBrowser();
    const res = await processImage(
      new Blob([new Uint8Array(20)], { type: "image/jpeg" }),
      {
        watermark: { timestamp: TS, nonce: NONCE },
      },
    );
    expect(res.outputType).toBe(WATERMARK_TYPE);
    expect(res.blob.type).toBe("image/png");
    expect(res.watermark.payload.ts).toBe(TS);
    expect(res.watermark.id).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.clearRect).not.toHaveBeenCalled();
    expect(convertToBlob).toHaveBeenCalledTimes(1);
    expect(convertToBlob.mock.calls[0][0].type).toBe("image/png");
    expect(extractWatermark(ctx.px).kind).toBe("ok");
  });

  it("never falls back to a lossy type when PNG isn't produced", async () => {
    stubBrowser({ blobType: "image/webp" });
    await expect(
      processImage(new Blob([new Uint8Array(20)]), { watermark: {} }),
    ).rejects.toThrow(/PNG encoding is required/);
  });

  it("leaves the default (lossy, non-watermarked) path untouched", async () => {
    const { ctx } = stubBrowser({ blobType: "same" });
    const res = await processImage(new Blob([new Uint8Array(20)]));
    expect(res.watermark).toBeUndefined();
    expect(res.outputType).toBe("image/webp");
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.clearRect).toHaveBeenCalled();
  });
});
