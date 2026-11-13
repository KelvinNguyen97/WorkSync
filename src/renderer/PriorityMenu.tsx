import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  LEVELS,
  LEVEL_NAME,
  shownPriority,
  type Level,
  type Task,
} from '../shared/model';
import { useApp } from './appState';
import { Icon } from './Icon';
import { useTaskLabel } from './parts';
import { tr } from './i18n';

export interface MenuAnchor {
  task: Task;
  /** The element that opened the menu, focused again when it closes. */
  opener: HTMLElement;
  /** Where to open it: under the opener, or at the pointer for a right-click. */
  at?: { x: number; y: number };
}

/**
 * Changes a task's priority (spec 03, Changing priority). A task from a file
 * offers Only for me (an override) or Change in the file. A task added by hand
 * has no file, so its level is simply set.
 */
export function PriorityMenu({
  anchor,
  onClose,
}: {
  anchor: MenuAnchor;
  onClose: () => void;
}) {
  const { putTask, toast, attempt } = useApp();
  const label = useTaskLabel();
  const t = anchor.task;
  const fromFile = t.source === 'file';
  const [mode, setMode] = useState<'me' | 'file'>('me');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  const current = !fromFile
    ? t.priority
    : mode === 'me'
      ? shownPriority(t)
      : t.priority;

  useLayoutEffect(() => {
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const r = anchor.opener.getBoundingClientRect();
    let x = anchor.at ? anchor.at.x : r.left;
    let y = anchor.at ? anchor.at.y : r.bottom + 6;
    if (y + h > innerHeight - 8) y = anchor.at ? y - h : r.top - h - 6;
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    y = Math.max(8, Math.min(innerHeight - h - 8, y));
    setPos({ left: x, top: y });
  }, [anchor, mode]);

  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>('.pm-item[aria-checked="true"]')
      ?.focus();
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor.opener.focus();
      }
    };
    document.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  const done = (task: Task, text: string, undo: () => Promise<Task>) => {
    putTask(task);
    onClose();
    toast(text, {
      label: 'Undo',
      run: () => void attempt(async () => putTask(await undo())),
    });
  };

  const pick = async (level: Level) => {
    if (level === current) return onClose();
    if (!fromFile || mode === 'file') {
      const before = t.priority;
      const beforeOverride = t.priorityOverride;
      const u = await attempt(() =>
        window.worksync.updateTask(t.id, { priority: level }),
      );
      if (!u) return;
      let after = u;
      if (fromFile && beforeOverride) {
        after =
          (await attempt(() =>
            window.worksync.setPriorityOverride(t.id, null),
          )) ?? u;
      }
      done(after, `${label(t)} is now ${tr(LEVEL_NAME[level])}.`, async () => {
        const r = await window.worksync.updateTask(t.id, {
          priority: before,
        });
        return beforeOverride
          ? window.worksync.setPriorityOverride(t.id, beforeOverride)
          : r;
      });
    } else {
      const before = t.priorityOverride;
      const u = await attempt(() =>
        window.worksync.setPriorityOverride(t.id, level),
      );
      if (u)
        done(
          u,
          u.priorityOverride
            ? `${label(t)} is ${tr(LEVEL_NAME[level])} for you. The file still says ${tr(LEVEL_NAME[t.priority])}.`
            : `Override removed. ${label(t)} is ${tr(LEVEL_NAME[t.priority])}, as in the file.`,
          () => window.worksync.setPriorityOverride(t.id, before),
        );
    }
  };

  const removeOverride = async () => {
    const before = t.priorityOverride;
    const u = await attempt(() =>
      window.worksync.setPriorityOverride(t.id, null),
    );
    if (u)
      done(
        u,
        `Override removed. ${label(t)} is ${tr(LEVEL_NAME[t.priority])} again.`,
        () => window.worksync.setPriorityOverride(t.id, before),
      );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...ref.current!.querySelectorAll<HTMLElement>('.pm-item')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[
        i < 0
          ? 0
          : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      ].focus();
    } else if (e.key === 'Tab') {
      const all = [...ref.current!.querySelectorAll<HTMLElement>('button')];
      if (e.shiftKey && document.activeElement === all[0]) {
        e.preventDefault();
        all[all.length - 1].focus();
      } else if (
        !e.shiftKey &&
        document.activeElement === all[all.length - 1]
      ) {
        e.preventDefault();
        all[0].focus();
      }
    }
  };

  return (
    <div
      ref={ref}
      className="pmenu"
      role="dialog"
      aria-labelledby="pmTitle"
      style={pos}
      onKeyDown={onKeyDown}
    >
      <div className="pm-head">
        <b id="pmTitle">{tr('Priority')}</b>
        <span className="tid">{label(t)}</span>
      </div>
      {fromFile ? (
        <>
          <div
            className="seg-ctl pm-mode"
            role="radiogroup"
            aria-label={tr('Where to change it')}
          >
            <button
              role="radio"
              aria-checked={mode === 'me'}
              onClick={() => setMode('me')}
            >
              {tr('Only for me')}
            </button>
            <button
              role="radio"
              aria-checked={mode === 'file'}
              onClick={() => setMode('file')}
            >
              {tr('Change in the file')}
            </button>
          </div>
          <p className="pm-note">
            {mode === 'me'
              ? tr(
                  'Shown instead of the file’s value in every view. Never written to the customer’s file.',
                )
              : tr(
                  'Changes the file’s value. Write to copy writes the file’s own word for it into your copy.',
                )}
          </p>
        </>
      ) : (
        <p className="pm-note">
          {tr('Added by hand, so there is no customer file to write to.')}
        </p>
      )}
      <div
        className="pm-list"
        role="radiogroup"
        aria-label={tr('Priority level')}
      >
        {LEVELS.map((k) => (
          <button
            key={k}
            className={`pm-item ${k}`}
            role="radio"
            aria-checked={k === current}
            onClick={() => void pick(k)}
          >
            <i className="sw" />
            <span>{tr(LEVEL_NAME[k])}</span>
            <span className="fw">
              {fromFile && mode === 'me' && k === t.priority ? (
                <small>{tr('File')}</small>
              ) : null}
            </span>
            <span className="ck">
              {k === current ? <Icon name="check" /> : null}
            </span>
          </button>
        ))}
      </div>
      {fromFile && t.priorityOverride && (
        <button
          className="pm-item pm-remove"
          onClick={() => void removeOverride()}
        >
          <Icon name="x" />
          <span>
            {tr('Remove override, back to')} {tr(LEVEL_NAME[t.priority])}{' '}
            {tr('from the file')}
          </span>
        </button>
      )}
    </div>
  );
}
