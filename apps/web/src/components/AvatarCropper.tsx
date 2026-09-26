import { useEffect, useRef, useState } from 'react';
import { AVATAR_CROP_VIEW, cropLayout } from '../lib/avatar-crop';

interface Props {
  source: File | string;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: (portrait: string, avatar: string) => void;
}

const MAX_PORTRAIT_DATA_LENGTH = 900_000;

function portraitDataUrl(image: HTMLImageElement): string {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法处理这张图片。');
  for (const [maxWidth, maxHeight, quality] of [
    [960, 1440, 0.82],
    [720, 1080, 0.76],
    [560, 840, 0.7],
  ] as const) {
    const factor = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * factor));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * factor));
    context.fillStyle = '#eee9e3';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/webp', quality);
    if (result.length <= MAX_PORTRAIT_DATA_LENGTH) return result;
  }
  throw new Error('图片处理后仍然过大，请换一张图片。');
}

export function AvatarCropper({ source, disabled, onCancel, onConfirm }: Props) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    let active = true;
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const loaded = new Image();
    loaded.onload = () => {
      if (!active) return;
      setImage(loaded);
      setPreviewUrl(url);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setError(null);
    };
    loaded.onerror = () => {
      if (active) setError('无法读取这张图片，请选择 PNG、JPEG 或 WebP。');
    };
    loaded.src = url;
    return () => {
      active = false;
      if (typeof source !== 'string') URL.revokeObjectURL(url);
    };
  }, [source]);

  const layout = image ? cropLayout(image.naturalWidth, image.naturalHeight, zoom, offset.x, offset.y) : null;

  const confirm = (): void => {
    if (!image || !layout) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_CROP_VIEW;
      canvas.height = AVATAR_CROP_VIEW;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法裁切头像。');
      context.beginPath();
      context.arc(AVATAR_CROP_VIEW / 2, AVATAR_CROP_VIEW / 2, AVATAR_CROP_VIEW / 2, 0, Math.PI * 2);
      context.clip();
      context.drawImage(image, layout.left, layout.top, layout.width, layout.height);
      const avatar = canvas.toDataURL('image/webp', 0.9);
      const portrait = typeof source === 'string' && source.startsWith('data:image/') ? source : portraitDataUrl(image);
      onConfirm(portrait, avatar);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="avatar-crop-editor">
      <strong>选取圆形头像</strong>
      <p className="hint">拖动图片对准面部，再用滑块缩放。圆圈内就是对话头像。</p>
      <div
        className="avatar-crop-window"
        aria-label="拖动图片调整圆形头像区域"
        onPointerDown={(event) => {
          if (!layout) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, offsetX: layout.offsetX, offsetY: layout.offsetY };
        }}
        onPointerMove={(event) => {
          if (!drag.current || !image) return;
          const next = cropLayout(
            image.naturalWidth,
            image.naturalHeight,
            zoom,
            drag.current.offsetX + event.clientX - drag.current.x,
            drag.current.offsetY + event.clientY - drag.current.y,
          );
          setOffset({ x: next.offsetX, y: next.offsetY });
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        {layout && previewUrl ? (
          <img
            src={previewUrl}
            alt="待裁切的角色图片"
            draggable={false}
            style={{ width: layout.width, height: layout.height, left: layout.left, top: layout.top }}
          />
        ) : null}
        <div className="avatar-crop-circle" />
      </div>
      <label>
        缩放
        <input
          type="range"
          min="1"
          max="3"
          step="0.05"
          value={zoom}
          disabled={disabled || !image}
          onChange={(event) => {
            const nextZoom = Number(event.target.value);
            setZoom(nextZoom);
            if (image) {
              const next = cropLayout(image.naturalWidth, image.naturalHeight, nextZoom, offset.x, offset.y);
              setOffset({ x: next.offsetX, y: next.offsetY });
            }
          }}
        />
      </label>
      {error ? <p className="notice error">{error}</p> : null}
      <div className="inline">
        <button type="button" disabled={disabled || !image} onClick={confirm}>保存图片与头像</button>
        <button type="button" className="ghost" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}
