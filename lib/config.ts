// Public worker endpoints. These are not secrets (the browser has to call them),
// so defaults point at the live Modal deployments; override per environment in
// Vercel with NEXT_PUBLIC_IMAGE_API_URL / NEXT_PUBLIC_MEDIA_API_URL.
const DEFAULT_IMAGE_API = 'https://airautomates-bit--stac-bg-remover-backgroundremover-web.modal.run';
const DEFAULT_MEDIA_API = 'https://airautomates-bit--stac-media-saver-mediasaver-web.modal.run';

function cleanUrl(value: string | undefined, fallback: string) {
  const raw = (value || fallback).trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

export const IMAGE_API = cleanUrl(process.env.NEXT_PUBLIC_IMAGE_API_URL, DEFAULT_IMAGE_API);
export const MEDIA_API = cleanUrl(process.env.NEXT_PUBLIC_MEDIA_API_URL, DEFAULT_MEDIA_API);

export const MAX_PIXELS = 100_000_000;
export const MAX_BYTES = 100 * 1024 * 1024;
