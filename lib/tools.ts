export type PlatformKey = 'youtube' | 'instagram' | 'pinterest' | 'facebook' | 'x';
export type ToolKey = 'home' | 'remove' | 'convert' | PlatformKey;

export type PlatformInfo = {
  key: PlatformKey;
  name: string;
  nav: string;
  title: string;
  blurb: string;
  chips: string[];
  placeholder: string;
  tint: string;
  ink: string;
  beta?: boolean;
};

export const PLATFORMS: PlatformInfo[] = [
  {
    key: 'youtube', name: 'YouTube', nav: 'YouTube', title: 'YouTube downloader',
    blurb: 'Save YouTube videos and Shorts as MP4 (up to 1080p), or grab just the audio as MP3.',
    chips: ['Videos', 'Shorts', 'Up to 1080p', 'MP3 audio'],
    placeholder: 'https://www.youtube.com/watch?v=…', tint: 'red', ink: '#e5322d',
  },
  {
    key: 'instagram', name: 'Instagram', nav: 'Instagram', title: 'Instagram downloader',
    blurb: 'Save reels, videos, photos and full carousels from public Instagram posts.',
    chips: ['Reels', 'Videos', 'Photos', 'Carousels', 'MP3 audio'],
    placeholder: 'https://www.instagram.com/reel/…', tint: 'rose', ink: '#d6336c',
  },
  {
    key: 'pinterest', name: 'Pinterest', nav: 'Pinterest', title: 'Pinterest video downloader',
    blurb: 'Download video pins in their original quality — short pin.it links work too.',
    chips: ['Video pins', 'Image pins', 'pin.it links', 'MP3 audio'],
    placeholder: 'https://www.pinterest.com/pin/…', tint: 'peach', ink: '#bd081c',
  },
  {
    key: 'facebook', name: 'Facebook', nav: 'Facebook', title: 'Facebook video downloader',
    blurb: 'Save public Facebook videos and reels with sound, ready to share or edit.',
    chips: ['Reels', 'Videos', 'Watch links', 'MP3 audio'],
    placeholder: 'https://www.facebook.com/reel/…', tint: 'sky', ink: '#1c6fe0',
  },
  {
    key: 'x', name: 'X', nav: 'X / Twitter', title: 'X / Twitter downloader',
    blurb: 'Grab videos, GIFs and full-resolution photos from public posts on X.',
    chips: ['Videos', 'Photos', 'GIFs', 'MP3 audio'],
    placeholder: 'https://x.com/user/status/…', tint: 'lilac', ink: '#131a2e',
  },
];

export const PLATFORM_BY_KEY = Object.fromEntries(PLATFORMS.map((p) => [p.key, p])) as Record<PlatformKey, PlatformInfo>;

export const TOOL_KEYS: ToolKey[] = ['home', 'remove', 'convert', ...PLATFORMS.map((p) => p.key)];

export function detectPlatform(raw: string): PlatformKey | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
    const is = (d: string) => host === d || host.endsWith(`.${d}`);
    if (is('youtube.com') || is('youtu.be') || is('youtube-nocookie.com')) return 'youtube';
    if (is('instagram.com') || is('instagr.am')) return 'instagram';
    if (is('pin.it') || /(^|\.)pinterest\.[a-z.]+$/.test(host)) return 'pinterest';
    if (is('facebook.com') || is('fb.watch') || is('fb.com')) return 'facebook';
    if (is('x.com') || is('twitter.com')) return 'x';
  } catch {}
  return null;
}
