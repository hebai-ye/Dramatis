import { describe, expect, it } from 'vitest';
import { getBackgroundPreset } from './background-presets';

describe('built-in background lookup', () => {
  it('resolves a full background path to its picker metadata', () => {
    expect(getBackgroundPreset('/backgrounds/v1/tavern-hearth.webp')).toMatchObject({
      id: 'tavern-hearth',
      category: 'tavern',
      label: '炉火大厅',
      image: '/backgrounds/v1/tavern-hearth.webp',
      thumbnail: '/backgrounds/v1/thumbs/tavern-hearth.webp',
    });
  });

  it.each([
    '',
    'data:image/png;base64,dXBsb2Fk',
    '/backgrounds/v1/removed-scene.webp',
    '/backgrounds/v1/thumbs/tavern-hearth.webp',
    '/backgrounds/v1/tavern-hearth.webp?variant=unlisted',
    'https://example.com/backgrounds/v1/tavern-hearth.webp',
  ])('does not identify %s as a selectable built-in background', (background) => {
    expect(getBackgroundPreset(background)).toBeUndefined();
  });
});
