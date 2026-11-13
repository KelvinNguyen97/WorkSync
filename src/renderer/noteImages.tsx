import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { tr } from './i18n';
import { MAX_IMAGE_BYTES } from '../shared/notes';

/** Images are loaded once and kept while the app runs. */
const cache = new Map<string, Promise<string>>();

export function imageUrl(id: string): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    p = window.worksync
      .getNoteImage(id)
      .then(({ mime, data }) =>
        URL.createObjectURL(new Blob([data as BlobPart], { type: mime })),
      );
    // A failed load can be tried again next time.
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

function useImageUrl(id: string): string | null | 'missing' {
  const [url, setUrl] = useState<string | null | 'missing'>(null);
  useEffect(() => {
    let live = true;
    imageUrl(id).then(
      (u) => live && setUrl(u),
      () => live && setUrl('missing'),
    );
    return () => {
      live = false;
    };
  }, [id]);
  return url;
}

/** The image a paste or drop carries, if it is an image only (copied text wins). */
export function imageFrom(data: DataTransfer | null): File | null {
  if (!data) return null;
  if (data.getData('text/plain').trim()) return null;
  for (const item of data.items)
    if (item.kind === 'file' && item.type.startsWith('image/'))
      return item.getAsFile();
  return null;
}

/** Keeps a pasted or dropped image and returns its id. */
export async function keepImage(file: File): Promise<string> {
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error('This image is too large (20 MB at most).');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = await window.worksync.addNoteImage(bytes);
  // Shown at once, from the bytes just read (the pasted file itself is
  // only readable while the paste lasts).
  const url = URL.createObjectURL(new Blob([bytes], { type: file.type }));
  cache.set(id, Promise.resolve(url));
  return id;
}

/** An image in the note editor: opens the viewer, and can be removed. */
export function NoteImage({
  id,
  onRemove,
}: {
  id: string;
  onRemove: () => void;
}) {
  const url = useImageUrl(id);
  const [open, setOpen] = useState(false);
  if (url === 'missing')
    return (
      <div className="note-img missing">
        <Icon name="alert" /> {tr('This image is no longer there.')}
        <button
          className="icon-btn"
          aria-label={tr('Remove image')}
          title={tr('Remove image')}
          onClick={onRemove}
        >
          <Icon name="x" />
        </button>
      </div>
    );
  return (
    <div className="note-img">
      <button
        className="note-img-open"
        aria-label={tr('Open the image')}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            onRemove();
          }
        }}
      >
        {url ? (
          <img src={url} alt="" draggable={false} />
        ) : (
          <span className="note-img-wait" />
        )}
      </button>
      <button
        className="icon-btn note-img-x"
        aria-label={tr('Remove image')}
        title={tr('Remove image')}
        onClick={onRemove}
      >
        <Icon name="trash" />
      </button>
      {open && url && (
        <ImageViewer id={id} url={url} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

const MIN = 0.05;
const MAX = 16;
const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z));

/**
 * An image at its actual size, over the app. The wheel zooms where the pointer
 * is, dragging moves it, and the buttons zoom, fit it to the window or go back
 * to actual size. Keys: + and - zoom, 0 actual size, F fit, Esc closes.
 */
export function ImageViewer({
  id,
  url,
  onClose,
}: {
  id: string;
  url: string;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(
    null,
  );

  const box = () => stage.current?.getBoundingClientRect();
  /** Centers the image at zoom z. */
  const center = useCallback(
    (z: number) => {
      const b = box();
      if (!b || !size) return;
      setView({
        z,
        x: (b.width - size.w * z) / 2,
        y: (b.height - size.h * z) / 2,
      });
    },
    [size],
  );
  const fitZoom = useCallback(() => {
    const b = box();
    if (!b || !size) return 1;
    return clamp(
      Math.min((b.width - 48) / size.w, (b.height - 48) / size.h, 1),
    );
  }, [size]);
  /** Zooms by a factor, keeping the point (px, py) of the stage still. */
  const zoomAt = (factor: number, px?: number, py?: number) =>
    setView((v) => {
      const b = box();
      const cx = px ?? (b ? b.width / 2 : 0);
      const cy = py ?? (b ? b.height / 2 : 0);
      const z = clamp(v.z * factor);
      const k = z / v.z;
      return { z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

  // Actual size first, centered.
  useEffect(() => {
    if (size) center(1);
  }, [size, center]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys: Record<string, () => void> = {
        Escape: onClose,
        '+': () => zoomAt(1.25),
        '=': () => zoomAt(1.25),
        '-': () => zoomAt(0.8),
        '0': () => center(1),
        f: () => center(fitZoom()),
      };
      const run = keys[e.key];
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // The wheel zooms (a trackpad pinch arrives as a wheel with Ctrl).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = el.getBoundingClientRect();
      const step = e.ctrlKey ? 0.01 : 0.0015;
      zoomAt(Math.exp(-e.deltaY * step), e.clientX - b.left, e.clientY - b.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const copy = async () => {
    try {
      // The clipboard takes PNG, so the image is drawn once as PNG.
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      const png = await new Promise<Blob>((ok, no) =>
        c.toBlob((b) => (b ? ok(b) : no(new Error('no image'))), 'image/png'),
      );
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': png }),
      ]);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
    window.setTimeout(() => setCopied(''), 1800);
  };

  const pct = Math.round(view.z * 100);
  return createPortal(
    <div
      className="iv"
      role="dialog"
      aria-modal="true"
      aria-label={tr('Image')}
    >
      <div
        ref={stage}
        className={`iv-stage ${drag.current ? 'dragging' : ''}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setView((v) => ({
            ...v,
            x: d.vx + e.clientX - d.x,
            y: d.vy + e.clientY - d.y,
          }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() =>
          Math.abs(view.z - 1) < 0.01 ? center(fitZoom()) : center(1)
        }
      >
        <img
          src={url}
          alt=""
          draggable={false}
          className={view.z >= 3 ? 'pixels' : ''}
          onLoad={(e) =>
            setSize({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          style={{
            width: size ? size.w : undefined,
            height: size ? size.h : undefined,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
            visibility: size ? 'visible' : 'hidden',
          }}
        />
      </div>
      <div className="iv-bar" role="toolbar" aria-label={tr('Image')}>
        <button
          className="icon-btn"
          aria-label={tr('Zoom out')}
          title={`${tr('Zoom out')} (-)`}
          onClick={() => zoomAt(0.8)}
        >
          <Icon name="minus" />
        </button>
        <button
          className="iv-pct mono"
          title={`${tr('Actual size')} (0)`}
          onClick={() => center(1)}
        >
          {pct}%
        </button>
        <button
          className="icon-btn"
          aria-label={tr('Zoom in')}
          title={`${tr('Zoom in')} (+)`}
          onClick={() => zoomAt(1.25)}
        >
          <Icon name="plus" />
        </button>
        <span className="iv-sep" />
        <button
          className="btn sm"
          title={`${tr('Fit to the window')} (F)`}
          onClick={() => center(fitZoom())}
        >
          {tr('Fit')}
        </button>
        <button
          className="btn sm"
          title={`${tr('Actual size')} (0)`}
          onClick={() => center(1)}
        >
          100%
        </button>
        <span className="iv-sep" />
        <button className="btn sm" onClick={() => void copy()}>
          <Icon name={copied === 'ok' ? 'check' : 'copy'} />
          {copied === 'ok'
            ? tr('Copied')
            : copied === 'fail'
              ? tr('Could not copy')
              : tr('Copy')}
        </button>
        <button
          className="btn sm"
          onClick={() => void window.worksync.saveNoteImage(id).catch(() => {})}
        >
          <Icon name="download" />
          {tr('Save…')}
        </button>
        {size && (
          <span className="iv-dim muted mono">
            {size.w} × {size.h}
          </span>
        )}
        <span className="iv-sep" />
        <button
          className="icon-btn"
          aria-label={tr('Close')}
          title={`${tr('Close')} (Esc)`}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
