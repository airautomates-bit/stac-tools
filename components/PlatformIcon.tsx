import type { SVGProps } from 'react';
import type { PlatformKey } from '@/lib/tools';
import { IconFacebook, IconInstagram, IconPinterest, IconX, IconYouTube } from './icons';

const MAP = { youtube: IconYouTube, instagram: IconInstagram, pinterest: IconPinterest, facebook: IconFacebook, x: IconX };

export function PlatformIcon({ platform, ...props }: { platform: PlatformKey } & SVGProps<SVGSVGElement>) {
  const Icon = MAP[platform];
  return <Icon {...props} />;
}
