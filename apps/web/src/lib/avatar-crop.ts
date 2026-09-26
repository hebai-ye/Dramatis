export const AVATAR_CROP_VIEW = 256;

export interface CropLayout {
  width: number;
  height: number;
  left: number;
  top: number;
  offsetX: number;
  offsetY: number;
}

/** Fit an image behind a square crop view and keep panning inside its edges. */
export function cropLayout(
  imageWidth: number,
  imageHeight: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
  viewSize = AVATAR_CROP_VIEW,
): CropLayout {
  const safeWidth = Math.max(1, imageWidth);
  const safeHeight = Math.max(1, imageHeight);
  const scale = Math.max(viewSize / safeWidth, viewSize / safeHeight) * Math.max(1, zoom);
  const width = safeWidth * scale;
  const height = safeHeight * scale;
  const maxX = (width - viewSize) / 2;
  const maxY = (height - viewSize) / 2;
  const x = Math.max(-maxX, Math.min(maxX, offsetX));
  const y = Math.max(-maxY, Math.min(maxY, offsetY));
  return {
    width,
    height,
    left: (viewSize - width) / 2 + x,
    top: (viewSize - height) / 2 + y,
    offsetX: x,
    offsetY: y,
  };
}
