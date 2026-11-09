import { useEffect, useRef, useState } from 'react';

/**
 * Text cut short with "…" shows in full when the pointer rests on it, as in
 * the old app. It works for every screen at once: any element whose text is
 * cut by `text-overflow: ellipsis` or a line clamp gets the hint. Text that
 * fits shows nothing, and an element with its own tooltip (title) keeps it.
 */
const DELAY_MS = 400;
const GAP = 6;

/** True when the element's text is cut off. */
function isCut(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1)
    return true;
  const clamp = cs.getPropertyValue('-webkit-line-clamp');
  return !!clamp && clamp !== 'none' && el.scrollHeight > el.clientHeight + 1;
}

/** The cut-off element at or just above the pointer, if any. */
function cutTarget(start: EventTarget | null): HTMLElement | null {
  let el = start instanceof HTMLElement ? start : null;
  for (let i = 0; el && i < 4; i++, el = el.parentElement) {
    if (el.matches('input, textarea, select, [contenteditable="true"]'))
      return null;
    if (el.title) return null;
    if (isCut(el)) return hasOwnTooltip(el) ? null : el;
  }
  return null;
}

/** True when a tooltip just above already gives the element's full text. */
function hasOwnTooltip(el: HTMLElement): boolean {
  const text = el.innerText.trim().toLowerCase();
  let a = el.parentElement;
  for (let i = 0; a && i < 3; i++, a = a.parentElement)
    if (a.title && a.title.toLowerCase().includes(text)) return true;
  return false;
}

interface Hint {
  text: string;
  x: number;
  y: number;
  above: boolean;
}

export function OverflowHint() {
  const [hint, setHint] = useState<Hint | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer = 0;
    let current: HTMLElement | null = null;
    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setHint(null);
    };
    const show = (el: HTMLElement) => {
      const text = el.innerText.trim();
      if (!text) return;
      const r = el.getBoundingClientRect();
      const above = r.bottom + 80 > window.innerHeight;
      setHint({
        text,
        x: r.left,
        y: above ? r.top - GAP : r.bottom + GAP,
        above,
      });
    };
    const consider = (target: EventTarget | null) => {
      const el = cutTarget(target);
      if (el === current) return;
      hide();
      if (!el) return;
      current = el;
      timer = window.setTimeout(() => show(el), DELAY_MS);
    };
    const onOver = (e: MouseEvent) => consider(e.target);
    const onFocus = (e: FocusEvent) =>
      (e.target as HTMLElement)?.matches?.(':focus-visible') &&
      consider(e.target);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('mouseleave', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('mousedown', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('mouseleave', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('wheel', hide);
      window.removeEventListener('mousedown', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Keep the hint inside the window once its size is known.
  useEffect(() => {
    const el = box.current;
    if (!el || !hint) return;
    const w = el.offsetWidth;
    const left = Math.max(8, Math.min(hint.x, window.innerWidth - w - 8));
    el.style.left = `${left}px`;
    el.style.visibility = 'visible';
  }, [hint]);

  if (!hint) return null;
  return (
    <div
      ref={box}
      className="tip overflow-hint"
      role="tooltip"
      style={{
        left: hint.x,
        visibility: 'hidden',
        ...(hint.above
          ? { bottom: window.innerHeight - hint.y }
          : { top: hint.y }),
      }}
    >
      {hint.text}
    </div>
  );
}
