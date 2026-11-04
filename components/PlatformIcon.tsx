import type { SVGProps } from 'react';
import type { PlatformKey } from '@/lib/tools';
import { IconFacebook, IconInstagram, IconPinterest, IconThreads, IconX, IconYouTube } from './icons';

const MAP = { youtube: IconYouTube, instagram: IconInstagram, pinterest: IconPinterest, facebook: IconFacebook, x: IconX, threads: IconThreads };

export function PlatformIcon({ platform, ...props }: { platform: PlatformKey } & SVGProps<SVGSVGElement>) {
  const Icon = MAP[platform];
  return <Icon {...props} />;
}
