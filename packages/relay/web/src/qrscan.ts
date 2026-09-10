// QR scanning for the login screen.
//
// The agent prints a QR of the login URL (`https://host/?key=XXXX`). Scanning it
// with the phone's native camera app works, but inside an installed PWA there is
// no address bar to paste into — so the app scans it itself.
//
// Two decoders, in order of preference:
//   1. BarcodeDetector — native, zero cost, hardware-accelerated. Chrome/Edge on
//      Android and desktop.
//   2. jsQR — a pure-JS fallback, lazily imported only when (1) is missing, so
//      Safari/Firefox users pay the ~12KB and the canvas readback, nobody else.

/** Decode attempts per second. QR decoding on a full frame is not free on a
 *  mid-range phone; 6/s is well past the point where scanning feels instant. */
const SCAN_INTERVAL_MS = 160;

/** Longest edge we downscale frames to before a jsQR pass. A 1080p readback per
 *  frame is what makes naive JS scanners drop to single-digit FPS. */
const JSQR_MAX_EDGE = 640;

export interface QrScanner {
  /** Stop decoding and release the camera. Safe to call twice. */
  stop(): void;
}

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function';
}

type BarcodeDetectorLike = {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
};

/** Native detector, or null when unavailable / lacking QR support. */
async function nativeDetector(): Promise<BarcodeDetectorLike | null> {
  const Ctor = (globalThis as unknown as {
    BarcodeDetector?: {
      new(opts?: { formats?: string[] }): BarcodeDetectorLike;
      getSupportedFormats?(): Promise<string[]>;
    };
  }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    // Present but QR-less is a real combination (some Linux builds).
    const formats = await Ctor.getSupportedFormats?.();
    if (formats && !formats.includes('qr_code')) return null;
    return new Ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

/** jsQR wrapped to the same shape, reading frames through a scratch canvas. */
function jsqrDetector(
  decode: typeof import('jsqr').default,
): BarcodeDetectorLike {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    async detect(source: CanvasImageSource) {
      const video = source as HTMLVideoElement;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!ctx || !vw || !vh) return [];
      const scale = Math.min(1, JSQR_MAX_EDGE / Math.max(vw, vh));
      const w = Math.max(1, Math.round(vw * scale));
      const h = Math.max(1, Math.round(vh * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      const hit = decode(ctx.getImageData(0, 0, w, h).data, w, h, {
        inversionAttempts: 'dontInvert',   // printed QR on a terminal is dark-on-light
      });
      return hit?.data ? [{ rawValue: hit.data }] : [];
    },
  };
}

/**
 * Open the rear camera into `video` and decode QR frames until one is found
 * (→ `onResult`, scanner keeps running so the caller decides when to stop) or
 * the camera can't be opened (→ `onError`).
 */
export async function startQrScan(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  onError: (message: string) => void,
): Promise<QrScanner> {
  let stopped = false;
  let stream: MediaStream | null = null;
  let timer: number | undefined;

  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    video.srcObject = null;
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (e) {
    const name = (e as { name?: string }).name;
    onError(name === 'NotAllowedError'
      ? 'Camera permission denied — allow it, or type the key instead.'
      : 'No camera available on this device.');
    return { stop };
  }
  // Permission dialogs are slow enough that the user may have closed the
  // scanner while we were waiting — don't leave the camera light on.
  if (stopped) { for (const t of stream.getTracks()) t.stop(); return { stop }; }

  video.srcObject = stream;
  video.setAttribute('playsinline', '');   // iOS: don't hijack into fullscreen
  try { await video.play(); } catch { /* autoplay policies — decoding still works */ }

  let detector = await nativeDetector();
  if (!detector) {
    try {
      const { default: jsQR } = await import('jsqr');
      detector = jsqrDetector(jsQR);
    } catch {
      stop();
      onError('QR decoding is not supported in this browser.');
      return { stop };
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const hits = await detector.detect(video);
      const raw = hits[0]?.rawValue?.trim();
      if (raw) { onResult(raw); if (stopped) return; }
    } catch {
      // A dropped frame (video not ready, GPU hiccup) is normal — keep going.
    }
    if (!stopped) timer = window.setTimeout(() => void tick(), SCAN_INTERVAL_MS);
  };
  void tick();

  return { stop };
}

/**
 * Pull an ACCESS_KEY out of whatever the QR encoded.
 *
 * Accepts the agent's full login URL (`https://relay/?key=ABCD1234`) and a bare
 * key typed into any other QR generator. Returns the key plus the origin it came
 * from, so a QR pointing at a *different* relay can redirect instead of failing
 * against the wrong host.
 */
export function parseQrPayload(raw: string): { key: string; origin: string | null } | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const key = url.searchParams.get('key');
    if (key && isKeyShaped(key)) {
      return { key: key.toUpperCase(), origin: url.origin };
    }
    return null;   // a URL without a key isn't ours; don't guess
  } catch {
    return isKeyShaped(text) ? { key: text.toUpperCase(), origin: null } : null;
  }
}

// The relay mints keys from a Crockford-ish alphabet (see relay/src/crypto.ts):
// uppercase letters and digits, no I/O/0/1. Length is generous on purpose.
function isKeyShaped(s: string): boolean {
  return /^[A-Za-z0-9]{6,16}$/.test(s);
}
