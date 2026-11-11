import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  LEVEL_NAME,
  glossSegments,
  deadline,
  flags,
  isClosed,
  shownPriority,
  type Status,
  type Task,
  type Project,
} from '../shared/model';
import { useApp } from './appState';
import { Icon } from './Icon';
import { tr, trDeadline } from './i18n';

const STATUS_CLASS: Record<Status, string> = {
  'Not started': 'st-ns',
  'In progress': 'st-ip',
  'In review': 'st-ir',
  'On hold': 'st-oh',
  Done: 'st-dn',
  Cancelled: 'st-cx',
};

export const StatusChip = ({ status }: { status: Status }) => (
  <span className={`st ${STATUS_CLASS[status]}`}>{tr(status)}</span>
);

/** The class that gives a card its priority color. Closed tasks lose it. */
export const priorityClass = (t: Task) =>
  `pri-${shownPriority(t)}${isClosed(t) ? ' is-done' : ''}`;

/** The priority name, shown for Urgent and High, and always for an override. */
export function PriorityTag({ task }: { task: Task }) {
  const level = shownPriority(task);
  if (task.priorityOverride) {
    return (
      <span
        className={`ptag ${level} ovr`}
        title={tr('Your priority. The task’s own level is {level}.', {
          level: tr(LEVEL_NAME[task.priority]),
        })}
      >
        <Icon name="user" />
        {tr(LEVEL_NAME[level])}
        <span className="sr">{tr(', your override')}</span>
      </span>
    );
  }
  if ((level !== 'U' && level !== 'H') || isClosed(task)) return null;
  return <span className={`ptag ${level}`}>{tr(LEVEL_NAME[level])}</span>;
}

/** The task's No., unless the project hides numbers in its views. */
export function TaskNumber({ task }: { task: Task }) {
  const { project } = useApp();
  if (project(task.projectId)?.showNumbers === false) return null;
  return (
    <span className="tc-id">
      <small>{tr('No.')}</small>
      {task.customerId}
    </span>
  );
}

/** How messages name a task: by its No., or by its title when the project hides numbers. */
export function taskLabel(task: Task, p: Project | undefined): string {
  if (p?.showNumbers !== false) return `No. ${task.customerId}`;
  const title = task.titleTranslation || task.titleOriginal;
  return `“${title.length > 40 ? `${title.slice(0, 39)}…` : title}”`;
}

/** taskLabel with the task's own project. */
export function useTaskLabel() {
  const { project } = useApp();
  return (task: Task) => taskLabel(task, project(task.projectId));
}

export function Labels({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  return (
    <div className="tc-labels">
      {labels.map((l) => (
        <span className="label" key={l}>
          {l}
        </span>
      ))}
    </div>
  );
}

/** Working-language title first and the original under it, or the other way round. */
/**
 * Text with the project's glossary terms underlined with dots; hovering one
 * shows its translation.
 */
export function Glossed({
  text,
  projectId,
}: {
  text: string;
  projectId: string;
}) {
  const { glossary } = useApp();
  const terms = useMemo(
    () => glossary.filter((g) => g.projectId === projectId),
    [glossary, projectId],
  );
  const parts = useMemo(() => glossSegments(text, terms), [text, terms]);
  return (
    <>
      {parts.map((p, i) =>
        p.term ? (
          <abbr
            key={i}
            className="gloss"
            title={`${p.term.translation}${p.term.note ? ` · ${p.term.note}` : ''}`}
          >
            {p.text}
          </abbr>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

export function Titles({ task, big }: { task: Task; big?: boolean }) {
  const { originalFirst } = useApp();
  const Main = big ? 'h2' : 'div';
  const mainClass = big ? 'tm-title' : 'title clamp2';
  const subClass = big ? 'tm-orig' : 'orig clamp1';
  const review =
    task.translationState === 'Needs review' ? (
      <span className="tag-review">{tr('Needs review')}</span>
    ) : null;
  const idProps = big ? { id: 'tmTitle', tabIndex: -1 } : {};
  if (task.translationState === 'Not needed' || !task.titleTranslation) {
    return (
      <>
        <Main className={mainClass} lang={task.language} {...idProps}>
          <Glossed text={task.titleOriginal} projectId={task.projectId} />
          {task.translationState === 'Not translated' && (
            <span className="tag-review">{tr('Not translated')}</span>
          )}
        </Main>
      </>
    );
  }
  const original = (
    <span lang={task.language}>
      <Glossed text={task.titleOriginal} projectId={task.projectId} />
    </span>
  );
  return originalFirst ? (
    <>
      <Main className={mainClass} lang={task.language} {...idProps}>
        <Glossed text={task.titleOriginal} projectId={task.projectId} />
      </Main>
      <div className={subClass}>
        {task.titleTranslation}
        {review}
      </div>
    </>
  ) : (
    <>
      <Main className={mainClass} {...idProps}>
        {task.titleTranslation}
        {review}
      </Main>
      <div className={subClass} lang={task.language}>
        {original}
      </div>
    </>
  );
}

export function DeadlineChip({
  task,
  dueSoonDays,
}: {
  task: Task;
  dueSoonDays: number;
}) {
  const { today } = useApp();
  const d = deadline(task, today, dueSoonDays);
  if (!d) return null;
  const text = trDeadline(d.text);
  return (
    <span className={`chip ${d.tone}`}>
      <Icon name="clock" />
      {text}
    </span>
  );
}

/** Status, deadline and open difficulties. */
export function MetaChips({
  task,
  dueSoonDays,
}: {
  task: Task;
  dueSoonDays: number;
}) {
  const { today } = useApp();
  const f = flags(task, today, dueSoonDays);
  return (
    <>
      <StatusChip status={task.status} />
      <DeadlineChip task={task} dueSoonDays={dueSoonDays} />
      {f.openDifficulties > 0 && (
        <span className="chip">
          <Icon name="alert" />
          {tr('{n} open', { n: f.openDifficulties })}
        </span>
      )}
    </>
  );
}

/** A dialog over a blurred background. Esc or a click outside closes it. */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  narrow,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  narrow?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current
      ?.querySelector<HTMLElement>(
        'input, textarea, select, button:not([data-close])',
      )
      ?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, []);
  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className={`modal ${narrow ? 'narrow' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mTitle"
      >
        <div className="m-head">
          <div>
            <h2 id="mTitle">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-btn"
            data-close
            aria-label={tr('Close')}
            title={tr('Close')}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="m-body">{children}</div>
        {footer && <div className="m-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Toast() {
  const { toastMessage: m, dismissToast } = useApp();
  return (
    <div
      className={`toast ${m ? 'on' : ''} ${m?.error ? 'error' : ''}`}
      role="status"
      aria-live="polite"
    >
      {m && (
        <>
          <Icon name={m.error ? 'alert' : 'check'} />
          <span>{m.text}</span>
          {m.action && (
            <button
              className="btn sm"
              onClick={() => {
                dismissToast();
                m.action!.run();
              }}
            >
              {m.action.label}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ confirming a deletion

interface ConfirmOptions {
  title: string;
  /** What happens, in a sentence. */
  text?: string;
  /** The thing being deleted, shown as it is (a difficulty's text…). */
  detail?: string;
  /** The button that deletes: Delete, Remove… */
  yes: string;
}
let ask: ((o: ConfirmOptions, done: (ok: boolean) => void) => void) | null =
  null;

/**
 * Asks before something is deleted, in the app's own dialog. Resolves true
 * only when the owner presses the delete button; Cancel, Esc and closing
 * keep it.
 */
export const confirmDelete = (o: ConfirmOptions): Promise<boolean> =>
  new Promise((done) => (ask ? ask(o, done) : done(false)));

/** Shows the questions confirmDelete asks; mounted once for the window. */
export function ConfirmHost() {
  const [req, setReq] = useState<{
    o: ConfirmOptions;
    done: (ok: boolean) => void;
  } | null>(null);
  useEffect(() => {
    ask = (o, done) => setReq({ o, done });
    return () => {
      ask = null;
    };
  }, []);
  if (!req) return null;
  const finish = (ok: boolean) => {
    req.done(ok);
    setReq(null);
  };
  return (
    <Modal
      title={req.o.title}
      subtitle={req.o.text}
      onClose={() => finish(false)}
      narrow
      footer={
        <>
          {/* Cancel first: it takes the focus, so Enter never deletes by accident. */}
          <button className="btn" onClick={() => finish(false)}>
            {tr('Cancel')}
          </button>
          <button className="btn danger" onClick={() => finish(true)}>
            <Icon name="trash" />
            {req.o.yes}
          </button>
        </>
      }
    >
      {req.o.detail ? (
        <div className="confirm-detail">{req.o.detail}</div>
      ) : (
        <></>
      )}
    </Modal>
  );
}
