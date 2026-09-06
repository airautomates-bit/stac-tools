import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'STAC Tools — Background Remover, Converter & Media Saver',
  description: 'Full-resolution image tools by STAC: remove backgrounds, convert image formats, vectorize artwork and save permitted media from links.',
  icons: {
    icon: '/favicon.png',
    shortcut: '/favicon.png',
    apple: '/favicon.png',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
