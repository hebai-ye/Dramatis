import type { Card } from '@dramatis/core';
import catalog from './portrait-catalog.json';

/** Bundled character art. Paths are stable so a saved card only stores a short string. */
export const PORTRAITS = catalog.map(({ number, name, namingStyle }) => {
  const stem = String(number).padStart(2, '0');
  return {
    number,
    name,
    namingStyle,
    src: `/portraits/${stem}.webp`,
    thumbnail: `/portraits/thumbs/${stem}.webp`,
    avatar: `/portraits/avatars/${stem}.webp`,
  };
});

export function portraitOf(card: Card | null | undefined): string | null {
  const custom = card?.extensions?.dramatisCustomPortrait;
  if (typeof custom === 'string' && /^data:image\/(?:webp|jpeg|png);base64,/.test(custom)) return custom;
  const value = card?.extensions?.dramatisPortrait;
  return typeof value === 'string' && PORTRAITS.some((portrait) => portrait.src === value) ? value : null;
}

export function avatarOf(card: Card | null | undefined): string | null {
  const custom = card?.extensions?.dramatisCustomAvatar;
  if (typeof custom === 'string' && /^data:image\/(?:webp|jpeg|png);base64,/.test(custom)) return custom;
  const portrait = PORTRAITS.find((item) => item.src === card?.extensions?.dramatisPortrait);
  return portrait?.avatar ?? null;
}
