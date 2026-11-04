import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const IconHome = (p: P) => <svg {...base} {...p}><path d="M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19z" /></svg>;
export const IconEraser = (p: P) => <svg {...base} {...p}><path d="m7 21-4.3-4.3a1.5 1.5 0 0 1 0-2.1l10-10a1.5 1.5 0 0 1 2.1 0l5.6 5.6a1.5 1.5 0 0 1 0 2.1L13 19.7" /><path d="M7 21h14M5.5 12.5l6 6" /></svg>;
export const IconConvert = (p: P) => <svg {...base} {...p}><path d="M4 7h13l-3.5-3.5M20 17H7l3.5 3.5" /></svg>;
export const IconUpload = (p: P) => <svg {...base} {...p}><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" /></svg>;
export const IconDownload = (p: P) => <svg {...base} {...p}><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19.5h14" /></svg>;
export const IconMusic = (p: P) => <svg {...base} {...p}><path d="M9 18V6l11-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></svg>;
export const IconPaste = (p: P) => <svg {...base} {...p}><rect x="6" y="4.5" width="12" height="16" rx="2" /><path d="M9.5 4.5V3.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v.7M9.5 10h5M9.5 14h5" /></svg>;
export const IconArrow = (p: P) => <svg {...base} {...p}><path d="M7 17 17 7M9 7h8v8" /></svg>;
export const IconRefresh = (p: P) => <svg {...base} {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg>;
export const IconShield = (p: P) => <svg {...base} {...p}><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></svg>;
export const IconPlay = (p: P) => <svg {...base} {...p}><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" /></svg>;
export const IconImage = (p: P) => <svg {...base} {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m20.5 16-5-5-8.5 8.5" /></svg>;
export const IconSpark = (p: P) => <svg {...base} {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></svg>;
export const IconClose = (p: P) => <svg {...base} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>;

export const IconInstagram = (p: P) => <svg {...base} {...p}><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" /></svg>;
export const IconPinterest = (p: P) => <svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M10.6 20.2 12.4 12.8M11 10.2c0-1.6 1.2-2.7 2.7-2.7 1.6 0 2.6 1.1 2.6 2.6 0 2-1.1 3.6-2.8 3.6-.9 0-1.6-.6-1.5-1.5" /></svg>;
export const IconFacebook = (p: P) => <svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M13.2 20.4V13h2.4l.4-2.8h-2.8V8.6c0-.8.3-1.4 1.4-1.4h1.5V4.8" /><path d="M10.2 10.2h3" /></svg>;
export const IconX = (p: P) => <svg {...base} {...p}><path d="M4.5 4.5h4.2l10.8 15h-4.2zM19.2 4.5l-5.9 6.6M10.7 12.9l-5.9 6.6" /></svg>;
export const IconThreads = (p: P) => <svg {...base} {...p}><path d="M16.6 11.2c-.4-2.7-2.1-4-4.6-4-2.6 0-4.3 1.9-4.3 4.8 0 3 1.7 4.9 4.4 4.9 2.3 0 3.6-1.3 3.6-3 0-1.8-1.4-2.7-3.3-2.7-1.7 0-2.6.8-2.6 1.8s.9 1.6 2 1.6c2.2 0 3-1.9 2.6-4.3" /><path d="M19.8 9c-.9-3.5-3.7-5.5-7.7-5.5-5 0-8.3 3.4-8.3 8.5s3.3 8.5 8.3 8.5c3.4 0 5.9-1.5 7-4" /></svg>;
export const IconYouTube = (p: P) => <svg {...base} {...p}><rect x="2.5" y="5.5" width="19" height="13" rx="4" /><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" stroke="none" /></svg>;
