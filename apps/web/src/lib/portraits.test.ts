import { createBlankCard } from '@dramatis/core';
import { describe, expect, it } from 'vitest';
import { avatarOf, portraitOf } from './portraits';

describe('role artwork', () => {
  it('uses a dedicated face image for bundled character art', () => {
    const card = createBlankCard({ extensions: { dramatisPortrait: '/portraits/01.webp' } });
    expect(portraitOf(card)).toBe('/portraits/01.webp');
    expect(avatarOf(card)).toBe('/portraits/avatars/01.webp');
  });

  it('uses the uploaded crop while retaining the uploaded full image', () => {
    const card = createBlankCard({
      extensions: {
        dramatisPortrait: '/portraits/01.webp',
        dramatisCustomPortrait: 'data:image/webp;base64,AAAA',
        dramatisCustomAvatar: 'data:image/png;base64,BBBB',
      },
    });
    expect(portraitOf(card)).toBe('data:image/webp;base64,AAAA');
    expect(avatarOf(card)).toBe('data:image/png;base64,BBBB');
  });
});
