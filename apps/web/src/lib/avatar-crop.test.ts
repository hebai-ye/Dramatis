import { describe, expect, it } from 'vitest';
import { cropLayout } from './avatar-crop';

describe('cropLayout', () => {
  it('fills the crop view with a tall portrait while allowing vertical panning', () => {
    const layout = cropLayout(1000, 1500, 1, 0, 1000);
    expect(layout.width).toBe(256);
    expect(layout.height).toBe(384);
    expect(layout.offsetX).toBe(0);
    expect(layout.offsetY).toBe(64);
    expect(layout.top).toBe(0);
  });

  it('clamps both axes after zoom so the circle never shows an empty edge', () => {
    const layout = cropLayout(1000, 1500, 2, -10000, 10000);
    expect(layout.offsetX).toBe(-128);
    expect(layout.offsetY).toBe(256);
    expect(layout.left).toBe(-256);
    expect(layout.top).toBe(0);
  });
});
