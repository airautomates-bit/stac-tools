import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'STAC Tools — Background Remover, Image Converter & Media Downloader',
  description: 'Free tools by STAC: remove backgrounds at full resolution, convert between 11 image formats, and download from YouTube, Instagram, Pinterest, Facebook, X and Threads.',
  icons: { icon: '/favicon.png', shortcut: '/favicon.png', apple: '/favicon.png' },
};

export const viewport: Viewport = { themeColor: '#020306', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
