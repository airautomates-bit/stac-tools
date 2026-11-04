import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

function origin(value: string | undefined, fallback: string) {
  try { return new URL(value || fallback).origin; } catch { return fallback; }
}

// The browser talks to these two workers directly (large files never pass through Vercel).
const workers = [
  origin(process.env.NEXT_PUBLIC_IMAGE_API_URL, 'https://airautomates-bit--stac-bg-remover-backgroundremover-web.modal.run'),
  origin(process.env.NEXT_PUBLIC_MEDIA_API_URL, 'https://airautomates-bit--stac-media-saver-mediasaver-web.modal.run'),
];

const csp = [
  "default-src 'self'",
  // Next.js injects small inline bootstrap scripts; eval is only needed by the dev server.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self' ${workers.join(' ')}${isDev ? ' ws: wss:' : ''}`,
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ['upgrade-insecure-requests']),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
