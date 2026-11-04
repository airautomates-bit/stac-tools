import { MAX_BYTES, MAX_PIXELS } from './config';

export type ImageMeta = { width: number; height: number };

export function prettyBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function fileFormat(file: File) {
  const ext = file.name.split('.').pop()?.toUpperCase() || file.type.split('/').pop()?.toUpperCase() || 'IMAGE';
  return ext === 'JPEG' ? 'JPG' : ext.slice(0, 5);
}

/** Strip anything that isn't safe in a download filename. */
export function safeFilename(name: string, fallback: string) {
  const cleaned = name.replace(/[^A-Za-z0-9._ -]+/g, '').replace(/^[.\s]+/, '').slice(0, 120);
  return cleaned || fallback;
}

export function baseName(file: File) {
  return safeFilename(file.name.replace(/\.[^.]+$/, ''), 'image');
}

async function getImageMeta(file: File): Promise<ImageMeta> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Your browser could not open this image. HEIC and TIFF files can still be converted — try the Image converter.'));
      img.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function validateImage(file: File) {
  if (!file.type.startsWith('image/') && !/\.(heic|heif|avif|tiff?)$/i.test(file.name)) throw new Error('Choose an image file.');
  if (file.size > MAX_BYTES) throw new Error('Images up to 100 MB are supported.');
  const meta = await getImageMeta(file);
  if (meta.width * meta.height > MAX_PIXELS) {
    throw new Error(`This image is ${(meta.width * meta.height / 1_000_000).toFixed(1)} MP. The limit is 100 MP.`);
  }
  return meta;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function filenameFromResponse(res: Response, fallback: string) {
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return safeFilename(match ? decodeURIComponent(match[1]) : '', fallback);
}

/** Read a worker error body without ever trusting it as HTML. */
export async function errorMessage(res: Response, fallback: string) {
  try {
    const data = await res.json();
    if (typeof data?.detail === 'string') return data.detail.slice(0, 300);
  } catch {}
  if (res.status === 429) return 'Too many requests. Please wait a few minutes and try again.';
  if (res.status === 413) return 'This file is too large.';
  return fallback;
}

export function networkError(e: unknown, fallback: string) {
  if (e instanceof TypeError) return 'Could not reach the STAC servers. Check your connection and try again.';
  return e instanceof Error ? e.message : fallback;
}

export function formatDuration(sec?: number | null) {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export async function drawFileToCanvas(file: File, maxSide?: number) {
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width;
  let height = bitmap.height;
  if (maxSide && Math.max(width, height) > maxSide) {
    const ratio = maxSide / Math.max(width, height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas;
}

export async function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number) {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new Error(`Your browser cannot export ${mime}.`);
  return blob;
}
