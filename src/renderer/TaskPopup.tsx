import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  LANGUAGES,
  LEVEL_NAME,
  STATUSES,
  brief,
  daysBetween,
  fileDate,
  flags,
  shortDate,
  shownPriority,
  isClosed,
  linkKind,
  type ActivityEntry,
  type Status,
  type TaskInput,
  type TaskLink,
  type Task,
  assigneeText,
} from '../shared/model';
import type { PendingChange } from '../shared/writes';
import { briefInFileLanguage } from '../shared/reports';
import { translationMap } from '../shared/ownerBatch';
import { useApp } from './appState';
import { Icon } from './Icon';
import {
  Modal,
  DeadlineChip,
  Glossed,
  StatusChip,
  TaskNumber,
  Titles,
  useTaskLabel,
  priorityClass,
} from './parts';
import { tr } from './i18n';

/** Splits text into paragraphs on blank lines, or on single lines when there are none. */
const paragraphs = (text: string): string[] => {
  const t = text.trim();
  if (!t) return [];
  const blocks = t.split(/\n\s*\n/);
  return (blocks.length > 1 ? blocks : t.split('\n'))
    .map((p) => p.trim())
    .filter(Boolean);
};

function Description({ task }: { task: Task }) {
  const { originalFirst } = useApp();
  const [mode, setMode] = useState<'both' | 'translation' | 'original'>('both');
  const [open, setOpen] = useState(false);
  const orig = paragraphs(task.descriptionOriginal);
  const trans = paragraphs(task.descriptionTranslation);
  // Nothing to show: the section is left out.
  if (!orig.length && !trans.length) return null;
  const langName = LANGUAGES[task.language];
  const same = task.translationState === 'Not needed' || !trans.length;
  const long =
    Math.max(orig.length, trans.length) > 2 ||
    (orig.join(' ') + trans.join(' ')).length > 700;
  let body;
  if (same || mode === 'original') {
    body = (
      <div className="single">
        {orig.map((p, i) => (
          <p key={i} lang={task.language}>
            <Glossed text={p} projectId={task.projectId} />
          </p>
        ))}
      </div>
    );
  } else if (mode === 'translation') {
    body = (
      <div className="single">
        {trans.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    );
  } else {
    const left = originalFirst ? orig : trans;
    const right = originalFirst ? trans : orig;
    const n = Math.max(left.length, right.length);
    body = (
      <div className="pairs">
        <div className="ph">
          <span>
            {originalFirst ? `Original · ${langName}` : tr('Translation')}
          </span>
          <span>
            {originalFirst ? tr('Translation') : `Original · ${langName}`}
          </span>
        </div>
        {Array.from({ length: n }, (_, i) => (
          <div className="pp" key={i}>
            <p lang={originalFirst ? task.language : undefined}>
              {originalFirst ? (
                <Glossed text={left[i] ?? ''} projectId={task.projectId} />
              ) : (
                (left[i] ?? '')
              )}
            </p>
            <p lang={originalFirst ? undefined : task.language}>
              {originalFirst ? (
                (right[i] ?? '')
              ) : (
                <Glossed text={right[i] ?? ''} projectId={task.projectId} />
              )}
            </p>
          </div>
        ))}
      </div>
    );
  }
  return (
    <section className="sec sec-desc">
      <div className="desc-h">
        <h3>
          {tr('Description')}
          {long && (
            <span className="fresh">
              · {Math.max(orig.length, trans.length)} paragraphs
            </span>
          )}
        </h3>
        {same ? (
          <span className="muted" style={{ fontSize: 12.5 }}>
            {task.translationState === 'Not needed'
              ? tr('Already in the working language')
              : tr('Not translated yet')}
          </span>
        ) : (
          <div
            className="seg-ctl"
            role="group"
            aria-label={tr('Description language')}
          >
            {(
              [
                ['both', 'Side by side'],
                ['translation', 'Translation'],
                ['original', 'Original'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                aria-pressed={mode === k}
                onClick={() => setMode(k)}
              >
                {tr(l)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className={`desc-body ${long && !open ? 'clipped' : ''}`}
        id="descBody"
      >
        {body}
      </div>
      {long && (
        <div className="desc-more">
          <button
            className="btn sm"
            aria-expanded={open}
            aria-controls="descBody"
            onClick={() => setOpen(!open)}
          >
            <Icon name="chev" />
            {open ? tr('Show less') : tr('Show the full description')}
          </button>
        </div>
      )}
    </section>
  );
}

function SituationForm({
  task,
  fix,
  onDone,
}: {
  task: Task;
  /** Fixing a mistake: changes the newest update in place, and As of stays. */
  fix?: boolean;
  onDone: () => void;
}) {
  const { putTask, toast, attempt } = useApp();
  const s = task.situation;
  const [v, setV] = useState({
    handledBy: s.handledBy,
    doingNow: s.doingNow,
    nextStep: s.nextStep,
    nextDate: s.nextDate ?? '',
    difficulty: '',
    resolver: '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parts = {
      handledBy: v.handledBy,
      doingNow: v.doingNow,
      nextStep: v.nextStep,
      nextDate: v.nextDate || null,
    };
    const u = await attempt(() =>
      fix
        ? window.worksync.correctSituation(task.id, parts)
        : window.worksync.addSituationUpdate(task.id, {
            ...parts,
            newDifficulty: v.difficulty.trim()
              ? { text: v.difficulty, resolver: v.resolver }
              : undefined,
          }),
    );
    if (u) {
      putTask(u);
      toast(
        fix
          ? 'Corrected. As of stays the same.'
          : 'Situation updated. The brief now shows it.',
      );
      onDone();
    }
  };
  return (
    <form
      className="update"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      {fix && (
        <p className="fix-note">
          <Icon name="edit" />
          {tr(
            'Fixing a mistake: this changes the situation as you last recorded it. As of stays',
          )}{' '}
          {task.situation.asOf ? fileDate(task.situation.asOf) : ''}
          {tr(
            ', and no new update is added. To record new progress, use Update situation.',
          )}
        </p>
      )}
      <label>
        {tr('Handled by')}
        <input
          className="inp"
          value={v.handledBy}
          onChange={set('handledBy')}
          placeholder={tr('Who is working on it now')}
          autoFocus
        />
      </label>
      <label>
        {tr('Doing now')}
        <textarea
          className="inp"
          rows={2}
          value={v.doingNow}
          onChange={set('doingNow')}
        />
      </label>
      <div className="two">
        <label>
          {tr('Next step')}
          <input
            className="inp"
            value={v.nextStep}
            onChange={set('nextStep')}
          />
        </label>
        <label>
          {tr('Expected date')}
          <input
            className="inp"
            type="date"
            value={v.nextDate}
            onChange={set('nextDate')}
          />
        </label>
      </div>
      {!fix && (
        <div className="two">
          <label>
            {tr('New difficulty (optional)')}
            <input
              className="inp"
              value={v.difficulty}
              onChange={set('difficulty')}
              placeholder={tr('What is slowing the work down?')}
            />
          </label>
          <label>
            {tr('Who can resolve it')}
            <input
              className="inp"
              value={v.resolver}
              onChange={set('resolver')}
            />
          </label>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onDone}>
          {tr('Cancel')}
        </button>
        <button className="btn primary" type="submit">
          <Icon name="check" />
          {fix ? tr('Save correction') : tr('Save update')}
        </button>
      </div>
    </form>
  );
}

/** One difficulty: resolve or reopen it, fix its wording, or delete it. */
function DifficultyRow({
  task,
  d,
}: {
  task: Task;
  d: Task['difficulties'][number];
}) {
  const { attempt, putTask, toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.text);
  const [resolver, setResolver] = useState(d.resolver);
  const run = async (fn: () => Promise<Task>, done?: string) => {
    const u = await attempt(fn);
    if (u) {
      putTask(u);
      if (done) toast(done);
    }
    return !!u;
  };
  if (editing)
    return (
      <li>
        <Icon name={d.open ? 'alert' : 'check'} />
        <form
          className="inline-edit"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await run(() =>
                window.worksync.editDifficulty(task.id, d.id, {
                  text,
                  resolver,
                }),
              )
            )
              setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        >
          <input
            className="inp"
            aria-label={tr('Difficulty')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <input
            className="inp"
            aria-label={tr('Who can resolve it')}
            placeholder={tr('Who can resolve it')}
            value={resolver}
            onChange={(e) => setResolver(e.target.value)}
          />
          <div className="ie-foot">
            <button
              type="button"
              className="btn sm"
              onClick={() => setEditing(false)}
            >
              {tr('Cancel')}
            </button>
            <button className="btn sm primary" type="submit">
              {tr('Save')}
            </button>
          </div>
        </form>
      </li>
    );
  return (
    <li>
      <Icon name={d.open ? 'alert' : 'check'} />
      <span>
        <span className={d.open ? '' : 'res'}>{d.text}</span>
        <br />
        <span className="by">
          {d.resolver ? `${d.resolver} · ` : ''}since {shortDate(d.raisedOn)}
          {d.open ? '' : tr(' · resolved')} ·{' '}
          <button
            className="linkbtn"
            onClick={() =>
              void run(() =>
                window.worksync.setDifficultyOpen(task.id, d.id, !d.open),
              )
            }
          >
            {d.open ? tr('Mark resolved') : tr('Reopen')}
          </button>{' '}
          ·{' '}
          <button
            className="linkbtn"
            onClick={() => {
              setText(d.text);
              setResolver(d.resolver);
              setEditing(true);
            }}
          >
            {tr('Edit')}
          </button>{' '}
          ·{' '}
          <button
            className="linkbtn"
            onClick={() => {
              if (
                window.confirm(
                  `Delete this difficulty?\n\n${d.text}\n\nUse this for one written by mistake. A difficulty that went away should be marked resolved instead, so the history keeps it.`,
                )
              )
                void run(
                  () => window.worksync.deleteDifficulty(task.id, d.id),
                  'Difficulty deleted.',
                );
            }}
          >
            {tr('Delete')}
          </button>
        </span>
      </span>
    </li>
  );
}

type Draft = Record<string, string>;

/**
 * Empty fields are hidden. The Add row under a section names them; picking
 * one opens it here, and it stays once it has a value.
 */
const AddCtx = createContext<{
  adding: string | null;
  setAdding: (name: string | null) => void;
}>({ adding: null, setAdding: () => {} });

/** The empty fields of a section, as small links that open them. */
function AddFields({ names }: { names: string[] }) {
  const { adding, setAdding } = useContext(AddCtx);
  const shown = names.filter((n) => n !== adding);
  if (!shown.length) return null;
  return (
    <div className="add-fields">
      <span className="muted">{tr('Add')}</span>
      {shown.map((n) => (
        <button key={n} className="add-chip" onClick={() => setAdding(n)}>
          <Icon name="plus" />
          {tr(n)}
        </button>
      ))}
    </div>
  );
}

/**
 * A field of the popup that can be changed where it is: the pencil, or a
 * double-click on the value, opens it. Saves through the same path as Edit
 * task, so file tasks still get their changes written to your copy.
 */
function EditField({
  task,
  k,
  name,
  v,
  pend,
  wide,
  empty,
  start,
  editor,
  patch,
}: {
  task: Task;
  k: ReactNode;
  /** What the field is called, when k is not plain text. */
  name?: string;
  v: ReactNode;
  pend?: string;
  /** Shown as a block, such as the summary, rather than a small field. */
  wide?: boolean;
  /** Nothing entered: hidden until it is added from the Add row. */
  empty?: boolean;
  start: () => Draft;
  editor: (
    d: Draft,
    set: (key: string) => (e: { target: { value: string } }) => void,
  ) => ReactNode;
  patch: (d: Draft) => Partial<TaskInput>;
}) {
  const { attempt, putTask } = useApp();
  const [draft, setDrafted] = useState<Draft | null>(null);
  const add = useContext(AddCtx);
  const label = name ?? (typeof k === 'string' ? k : undefined);
  const isAdding = !!label && add.adding === label;
  const setDraft = (d: Draft | null) => {
    setDrafted(d);
    if (!d && isAdding) add.setAdding(null);
  };
  // Before paint, so a key pressed right after picking it reaches the editor.
  useLayoutEffect(() => {
    if (isAdding) setDrafted(start());
    // Opens once when picked from the Add row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdding]);
  const set = (key: string) => (e: { target: { value: string } }) =>
    setDrafted((d) => ({ ...d, [key]: e.target.value }));
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft) return;
    const u = await attempt(() =>
      window.worksync.updateTask(task.id, patch(draft)),
    );
    if (u) {
      putTask(u);
      setDraft(null);
    }
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setDraft(null);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  };
  if (empty && !draft && !isAdding) return null;
  return (
    <div
      className={`field editable ${wide ? 'wide' : ''} ${pend ? 'pending' : ''} ${draft ? 'editing' : ''}`}
    >
      <div className="k">
        {typeof k === 'string' ? tr(k) : k}
        {!draft && (
          <button
            className="fix-btn"
            title={
              label ? tr('Edit {field}', { field: tr(label) }) : tr('Edit')
            }
            aria-label={label ? `Edit ${label.toLowerCase()}` : tr('Edit')}
            onClick={() => setDraft(start())}
          >
            <Icon name="edit" />
          </button>
        )}
      </div>
      {draft ? (
        <form className="inline-edit" onSubmit={save} onKeyDown={keys}>
          {editor(draft, set)}
          <div className="ie-foot">
            <span className="muted">
              {tr('Ctrl+Enter saves · Esc cancels')}
            </span>
            <button
              type="button"
              className="btn sm"
              onClick={() => setDraft(null)}
            >
              {tr('Cancel')}
            </button>
            <button className="btn sm primary" type="submit">
              {tr('Save')}
            </button>
          </div>
        </form>
      ) : (
        <div
          className="v"
          onDoubleClick={() => setDraft(start())}
          title={tr('Double-click to edit')}
        >
          {v}
        </div>
      )}
      {pend && !draft && (
        <div className="pend">
          <Icon name="save" /> {pend}
        </div>
      )}
    </div>
  );
}

/** Web addresses and file paths kept with the task (spec 02, Links). */
function Links({ task }: { task: Task }) {
  const { attempt, putTask, toast } = useApp();
  const fromRow = useContext(AddCtx);
  const [adding, setOpen] = useState(false);
  const setAdding = (open: boolean) => {
    setOpen(open);
    if (!open && fromRow.adding === 'Link') fromRow.setAdding(null);
  };
  useLayoutEffect(() => {
    if (fromRow.adding === 'Link') setOpen(true);
  }, [fromRow.adding]);
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const save = async (links: TaskLink[]) => {
    const t = await attempt(() => window.worksync.setTaskLinks(task.id, links));
    if (t) putTask(t);
    return !!t;
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!target.trim()) return;
    if (!linkKind(target)) {
      toast(
        tr(
          'Use a web address such as https://… or a file path such as \\\\server\\share\\spec.xlsx or D:\\Docs\\spec.pdf.',
        ),
      );
      return;
    }
    if (await save([...task.links, { name, target }])) {
      setTarget('');
      setName('');
      setAdding(false);
    }
  };
  if (!task.links.length && !adding) return null;
  return (
    <div className="field links-field">
      <div className="k">
        <Icon name="link" />
        {tr('Links')}
        <button
          className="linkbtn"
          style={{ marginLeft: 'auto' }}
          onClick={() => setAdding(!adding)}
        >
          {adding ? tr('Cancel') : tr('Add a link')}
        </button>
      </div>
      <div className="v">
        {task.links.length ? (
          <ul className="links">
            {task.links.map((l, i) => (
              <li key={`${l.target}-${i}`}>
                <button
                  className="linkbtn"
                  title={l.target}
                  onClick={() =>
                    void attempt(() => window.worksync.openLink(l.target))
                  }
                >
                  <Icon
                    name={linkKind(l.target) === 'web' ? 'globe' : 'folder'}
                  />
                  {l.name || l.target}
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Remove the link ${l.name || l.target}`}
                  onClick={() =>
                    void save(task.links.filter((_, j) => j !== i))
                  }
                >
                  <Icon name="x" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {adding && (
          <form className="link-add" onSubmit={add}>
            <input
              className="inp"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="https://… or \\server\share\spec.xlsx"
              aria-label={tr('Web address or file path')}
              autoFocus
            />
            <input
              className="inp"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tr('Name (optional), such as Spec v2')}
              aria-label={tr('Link name')}
            />
            <button className="btn sm primary" type="submit">
              {tr('Add')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** History entry kinds, grouped into the types the owner filters by (spec 03). */
const HISTORY_GROUPS: { name: string; kinds: string[] }[] = [
  { name: 'Situation', kinds: ['Situation update', 'Difficulty'] },
  { name: 'From the file', kinds: ['Import'] },
  { name: 'Edits', kinds: ['Edit', 'Priority override', 'Created'] },
  { name: 'Written to copy', kinds: ['Write-back'] },
  { name: 'AI', kinds: ['AI', 'AI batch'] },
  { name: 'Your entries', kinds: ['Note'] },
];
const groupOf = (kind: string) =>
  HISTORY_GROUPS.find((g) => g.kinds.includes(kind))?.name ?? 'Edits';

/** The type filter and the timeline, shared by the side list and the History window. */
function HistoryList({
  entries,
  show,
  setShow,
  full,
}: {
  entries: ActivityEntry[];
  show: string | null;
  setShow: (s: string | null) => void;
  /** In the History window: every entry in full. */
  full?: boolean;
}) {
  return (
    <>
      {(full || entries.length > 3) && (
        <div
          className="hist-filter"
          role="group"
          aria-label={tr('Show in history')}
        >
          <button
            className="fb-opt"
            aria-pressed={show === null}
            onClick={(e) => {
              e.stopPropagation();
              setShow(null);
            }}
          >
            {tr('All')} {entries.length}
          </button>
          {HISTORY_GROUPS.map((g) => {
            const n = entries.filter((h) => groupOf(h.kind) === g.name).length;
            return (
              n > 0 && (
                <button
                  key={g.name}
                  className="fb-opt"
                  aria-pressed={show === g.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShow(show === g.name ? null : g.name);
                  }}
                >
                  {tr(g.name)} {n}
                </button>
              )
            );
          })}
        </div>
      )}
      <ul className={`hist ${full ? 'full' : ''}`}>
        {entries
          .filter((h) => !show || groupOf(h.kind) === show)
          .map((h) => (
            <li
              key={h.id}
              className={h.kind === 'Situation update' ? 'situation' : ''}
            >
              <span className="when">
                {fileDate(h.at.slice(0, 10))}{' '}
                {new Date(h.at).toTimeString().slice(0, 5)}
              </span>
              <span className="kind">{tr(h.kind)}</span>
              <div className="hist-text">{h.text}</div>
            </li>
          ))}
      </ul>
    </>
  );
}

function History({ task }: { task: Task }) {
  const { attempt } = useApp();
  const label = useTaskLabel();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [show, setShow] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void window.worksync.listActivity(task.id).then(setEntries);
  }, [task.id, task.updatedAt]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    await attempt(() => window.worksync.addNote(task.id, note));
    setNote('');
    setAdding(false);
    setEntries(await window.worksync.listActivity(task.id));
  };
  return (
    <section className="sec">
      <h3>
        {tr('History')}
        <button
          className="linkbtn"
          style={{
            marginLeft: 'auto',
            textTransform: 'none',
            letterSpacing: 0,
          }}
          onClick={() => setAdding(!adding)}
        >
          {tr('Add an entry')}
        </button>
      </h3>
      {adding && (
        <form className="update" onSubmit={add} style={{ marginBottom: 12 }}>
          <label>
            {tr('What happened')}
            <textarea
              className="inp"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={tr(
                'For example, a decision made in a meeting with the customer',
              )}
              autoFocus
            />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn sm"
              onClick={() => setAdding(false)}
            >
              {tr('Cancel')}
            </button>
            <button className="btn sm primary" type="submit">
              {tr('Add')}
            </button>
          </div>
        </form>
      )}
      {entries.length > 0 && (
        <div
          className="hist-open"
          role="button"
          tabIndex={0}
          title={tr('Open the whole history in a larger window')}
          aria-label={tr('Open the whole history')}
          onClick={() => setWide(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setWide(true);
            }
          }}
        >
          <HistoryList entries={entries} show={show} setShow={setShow} />
          <span className="hist-more">
            <Icon name="clock" /> {tr('Open the whole history')}
          </span>
        </div>
      )}
      {wide && (
        <Modal
          title={tr('History')}
          subtitle={`${label(task)} · ${task.titleTranslation || task.titleOriginal}`}
          onClose={() => setWide(false)}
        >
          <div className="hist-wide">
            <HistoryList entries={entries} show={show} setShow={setShow} full />
          </div>
        </Modal>
      )}
    </section>
  );
}

export function TaskPopup({
  taskId,
  onClose,
  onEdit,
  onDelete,
  openMenu,
}: {
  taskId: string;
  onClose: () => void;
  onEdit: (t: Task) => void;
  onDelete: (t: Task) => void;
  openMenu: (task: Task, opener: HTMLElement) => void;
}) {
  const { tasks, project, today, putTask, toast, attempt, people } = useApp();
  const label = useTaskLabel();
  const task = tasks.find((t) => t.id === taskId);
  const [updating, setUpdating] = useState<false | 'update' | 'fix'>(false);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => setAdding(null), [taskId]);
  const [pending, setPending] = useState<PendingChange[]>([]);
  // Customer-field changes not yet written to the owner's copy, marked on their fields.
  useEffect(() => {
    void window.worksync
      .pendingForTask(taskId)
      .then(setPending, () => setPending([]));
  }, [taskId, task?.updatedAt]);
  const pend = (...fields: string[]) => {
    const list = pending.filter((c) => fields.includes(c.field));
    return list.length
      ? `${list.map((c) => `${list.length > 1 ? `${c.label} c` : 'C'}hanged from ${c.from || '(empty)'}`).join('; ')}, not yet written to your copy`
      : undefined;
  };
  const titleRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    setTimeout(
      () => document.getElementById('tmTitle')?.focus({ preventScroll: true }),
      30,
    );
    return () => opener?.focus?.();
  }, [taskId]);

  if (!task) return null;
  const p = project(task.projectId)!;
  const f = flags(task, today, p.dueSoonDays);
  const s = task.situation;
  const asOfDays = s.asOf ? daysBetween(s.asOf, today) : null;
  const fresh =
    asOfDays === null
      ? tr('never confirmed')
      : asOfDays === 0
        ? tr('confirmed today')
        : tr(
            asOfDays > 1 ? 'confirmed {n} days ago' : 'confirmed {n} day ago',
            {
              n: asOfDays,
            },
          );
  const level = shownPriority(task);
  const flagChips = [
    f.nextStepOverdue && 'Next step overdue',
    f.lateToStart && 'Late to start',
    f.briefIncomplete && 'Brief incomplete',
    task.fileState === 'removed' && 'Removed from file',
  ].filter(Boolean) as string[];

  // The brief in the file's language, from the translations of your notes.
  const fileLang = p?.originalLanguages[0];
  const canCopyInFile =
    !!p && task.language === fileLang && fileLang !== p.workingLanguage;
  const copyBriefInFile = async () => {
    if (!p) return;
    const done = await attempt(() =>
      window.worksync.listOwnerTranslations(p.id),
    );
    if (!done) return;
    const b = briefInFileLanguage(
      task,
      translationMap([task], done, task.language),
      today,
      p.dueSoonDays,
      p.dateFormat,
    );
    try {
      await navigator.clipboard.writeText(b.text);
      toast(
        b.missing
          ? `Brief copied in ${LANGUAGES[task.language]}. ${b.missing} of your notes are not translated yet and are marked. Translate them from Make a report.`
          : `Brief copied in ${LANGUAGES[task.language]}.`,
      );
    } catch {
      toast(tr('Copying was blocked. Try again with the window in front.'));
    }
  };
  const copyBrief = async () => {
    try {
      await navigator.clipboard.writeText(brief(task).text);
      toast(tr('Brief copied. Paste it into chat or email.'));
    } catch {
      toast(tr('Copying was blocked. Try again with the window in front.'));
    }
  };
  const pin = async () => {
    const u = await attempt(() =>
      window.worksync.setPinned(task.id, !task.pinned),
    );
    if (u) {
      putTask(u);
      toast(
        u.pinned
          ? `Pinned ${label(u)} to the focus list.`
          : `Unpinned ${label(u)}.`,
      );
    }
  };
  const names = people
    .filter((x) => x.projectId === task.projectId)
    .map((x) => x.name);

  return (
    <AddCtx.Provider value={{ adding, setAdding }}>
      <div
        className="tm-bg"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <div
          className={`tm ${priorityClass(task)}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tmTitle"
        >
          <header
            className="tm-head"
            onWheel={(e) => {
              // The header does not scroll; the wheel over it scrolls the main column.
              const main = mainRef.current;
              if (main && getComputedStyle(main).overflowY === 'auto')
                main.scrollBy({ top: e.deltaY });
            }}
          >
            <div className="tm-top">
              <TaskNumber task={task} />
              <button
                className={`pri-btn ${level} ${task.priorityOverride ? 'ovr' : ''}`}
                aria-haspopup="dialog"
                title={tr('Change priority')}
                onClick={(e) => openMenu(task, e.currentTarget)}
              >
                {task.priorityOverride && <Icon name="user" />}
                {tr(LEVEL_NAME[level])}
                {task.priorityOverride && (
                  <span className="sr">{tr(', your override')}</span>
                )}
                <Icon name="chev" />
              </button>
              <span className="pname">{p.name}</span>
              <span className="sp" />
              <button
                className="icon-btn"
                title={tr('Edit task')}
                aria-label={tr('Edit task')}
                onClick={() => onEdit(task)}
              >
                <Icon name="edit" />
              </button>
              <button
                className={`icon-btn pin-toggle ${task.pinned ? 'on' : ''}`}
                aria-pressed={task.pinned}
                title={
                  task.pinned
                    ? tr('Unpin from the focus list')
                    : tr('Pin to the focus list')
                }
                onClick={() => void pin()}
              >
                <Icon name="pin" />
              </button>
              <button
                className="icon-btn"
                title={tr('Delete task')}
                aria-label={tr('Delete task')}
                onClick={() => onDelete(task)}
              >
                <Icon name="trash" />
              </button>
              <button
                className="icon-btn"
                aria-label={tr('Close')}
                onClick={onClose}
              >
                <Icon name="x" />
              </button>
            </div>
            <div ref={titleRef}>
              <Titles task={task} big />
            </div>
            <div className="tm-meta">
              <StatusChip status={task.status} />
              <DeadlineChip task={task} dueSoonDays={p.dueSoonDays} />
              {flagChips.map((x) => (
                <span key={x} className="chip over">
                  {x}
                </span>
              ))}
              {task.labels.map((l) => (
                <span key={l} className="label">
                  {l}
                </span>
              ))}
              <span className="sp" />
              <button className="btn" onClick={() => void copyBrief()}>
                <Icon name="copy" />
                {tr('Copy brief')}
              </button>
              {canCopyInFile && (
                <button
                  className="btn"
                  onClick={() => void copyBriefInFile()}
                  title={tr('The brief in {lang}, for the customer side', {
                    lang: tr(LANGUAGES[task.language]),
                  })}
                >
                  <Icon name="globe" />
                  {task.language === 'ja'
                    ? '日本語で'
                    : LANGUAGES[task.language]}
                </button>
              )}
              <button
                className="btn primary"
                onClick={() => setUpdating('update')}
              >
                <Icon name="edit" />
                {tr('Update situation')}
              </button>
            </div>
          </header>
          <div className="tm-body">
            <div className="tm-main" ref={mainRef}>
              <section className="sec">
                <EditField
                  task={task}
                  wide
                  name="Summary"
                  k={<h3>{tr('Summary')}</h3>}
                  start={() => ({ summary: task.summary })}
                  editor={(d, set) => (
                    <textarea
                      className="inp"
                      rows={3}
                      aria-label={tr('Summary')}
                      value={d.summary}
                      onChange={set('summary')}
                      autoFocus
                    />
                  )}
                  patch={(d) => ({ summary: d.summary })}
                  v={
                    task.summary ? (
                      <div className="summary">{task.summary}</div>
                    ) : (
                      <div className="summary missing">
                        <span>
                          {tr(
                            'No summary yet, so this task’s brief is incomplete.',
                          )}
                        </span>
                      </div>
                    )
                  }
                />
              </section>
              <section className="sec">
                <h3>
                  {tr('Situation')} <span className="fresh">· {fresh}</span>
                  {s.asOf && !updating && (
                    <button
                      className="linkbtn"
                      title={tr(
                        'Change what you last recorded, without making a new update',
                      )}
                      onClick={() => setUpdating('fix')}
                    >
                      {tr('Fix a mistake')}
                    </button>
                  )}
                </h3>
                <div className="situ">
                  {updating ? (
                    <SituationForm
                      key={updating}
                      task={task}
                      fix={updating === 'fix'}
                      onDone={() => setUpdating(false)}
                    />
                  ) : // Only what was entered is shown.
                  s.asOf ||
                    s.handledBy ||
                    s.doingNow ||
                    s.nextStep ||
                    task.difficulties.length ? (
                    <dl className="kv">
                      {s.handledBy && (
                        <>
                          <dt>{tr('Handled by')}</dt>
                          <dd>{s.handledBy}</dd>
                        </>
                      )}
                      {s.doingNow && (
                        <>
                          <dt>{tr('Doing now')}</dt>
                          <dd>{s.doingNow}</dd>
                        </>
                      )}
                      {task.difficulties.length > 0 && (
                        <>
                          <dt>{tr('Difficulties')}</dt>
                          <dd>
                            <ul className="diffs">
                              {task.difficulties.map((d) => (
                                <DifficultyRow key={d.id} task={task} d={d} />
                              ))}
                            </ul>
                          </dd>
                        </>
                      )}
                      {s.nextStep && (
                        <>
                          <dt>{tr('Next step')}</dt>
                          <dd>
                            <b>{s.nextStep}</b>
                            {s.nextDate && (
                              <span className="muted">
                                {' '}
                                by {shortDate(s.nextDate)}
                              </span>
                            )}
                          </dd>
                        </>
                      )}
                      {s.asOf && (
                        <>
                          <dt>{tr('As of')}</dt>
                          <dd className="mono">{fileDate(s.asOf)}</dd>
                        </>
                      )}
                    </dl>
                  ) : (
                    <div className="muted">
                      {tr(
                        'No situation recorded yet. Use Update situation to add one.',
                      )}
                    </div>
                  )}
                </div>
              </section>
              <Description task={task} />
            </div>
            <aside className="tm-side">
              <section className="sec sec-fields">
                <h3>{tr('Task fields')}</h3>
                <div className="fields">
                  <EditField
                    task={task}
                    k="Assignee"
                    empty={!task.assignee}
                    pend={pend('assignee')}
                    start={() => ({ assignee: task.assignee })}
                    editor={(d, set) => (
                      <>
                        <input
                          className="inp"
                          aria-label={tr('Assignee')}
                          list="tmPeople"
                          value={d.assignee}
                          onChange={set('assignee')}
                          autoFocus
                        />
                        <datalist id="tmPeople">
                          {names.map((n) => (
                            <option key={n} value={n} />
                          ))}
                        </datalist>
                      </>
                    )}
                    patch={(d) => ({ assignee: d.assignee })}
                    v={
                      task.assignee ? (
                        assigneeText(people, task, 'both')
                      ) : (
                        <span className="muted">{tr('Not set')}</span>
                      )
                    }
                  />
                  <EditField
                    task={task}
                    k="Status"
                    pend={pend('status')}
                    start={() => ({ status: task.status })}
                    editor={(d, set) => (
                      <select
                        className="inp"
                        aria-label={tr('Status')}
                        value={d.status}
                        onChange={set('status')}
                        autoFocus
                      >
                        {STATUSES.map((x) => (
                          <option key={x} value={x}>
                            {tr(x)}
                          </option>
                        ))}
                      </select>
                    )}
                    patch={(d) => ({ status: d.status as Status })}
                    v={tr(task.status)}
                  />
                  <EditField
                    task={task}
                    k="Planned"
                    empty={!task.plannedStart && !task.plannedEnd}
                    pend={pend('plannedStart', 'plannedEnd')}
                    start={() => ({
                      plannedStart: task.plannedStart ?? '',
                      plannedEnd: task.plannedEnd ?? '',
                    })}
                    editor={(d, set) => (
                      <div className="two">
                        <label>
                          {tr('Start')}
                          <input
                            className="inp"
                            type="date"
                            value={d.plannedStart}
                            onChange={set('plannedStart')}
                          />
                        </label>
                        <label>
                          {tr('End')}
                          <input
                            className="inp"
                            type="date"
                            value={d.plannedEnd}
                            onChange={set('plannedEnd')}
                          />
                        </label>
                      </div>
                    )}
                    patch={(d) => ({
                      plannedStart: d.plannedStart || null,
                      plannedEnd: d.plannedEnd || null,
                    })}
                    v={
                      task.plannedStart || task.plannedEnd ? (
                        <span className="mono">
                          {fileDate(task.plannedStart) || '…'} →{' '}
                          {fileDate(task.plannedEnd) || '…'}
                        </span>
                      ) : (
                        <span className="muted">{tr('No dates')}</span>
                      )
                    }
                  />
                  <EditField
                    task={task}
                    k="Actual"
                    empty={!task.actualStart && !task.actualEnd}
                    pend={pend('actualStart', 'actualEnd')}
                    start={() => ({
                      actualStart: task.actualStart ?? '',
                      actualEnd: task.actualEnd ?? '',
                    })}
                    editor={(d, set) => (
                      <div className="two">
                        <label>
                          {tr('Start')}
                          <input
                            className="inp"
                            type="date"
                            value={d.actualStart}
                            onChange={set('actualStart')}
                          />
                        </label>
                        <label>
                          {tr('End')}
                          <input
                            className="inp"
                            type="date"
                            value={d.actualEnd}
                            onChange={set('actualEnd')}
                          />
                        </label>
                      </div>
                    )}
                    patch={(d) => ({
                      actualStart: d.actualStart || null,
                      actualEnd: d.actualEnd || null,
                    })}
                    v={
                      task.actualStart || task.actualEnd ? (
                        <span className="mono">
                          {task.actualStart ? fileDate(task.actualStart) : '…'}{' '}
                          →{' '}
                          {task.actualEnd
                            ? fileDate(task.actualEnd)
                            : isClosed(task)
                              ? tr('no end date')
                              : tr('ongoing')}
                        </span>
                      ) : (
                        <span className="muted">
                          {task.status === 'Not started'
                            ? tr('Not started')
                            : tr('No dates recorded')}
                        </span>
                      )
                    }
                  />
                  <Field
                    k="Priority"
                    pend={pend('priority')}
                    v={
                      <>
                        {tr(LEVEL_NAME[task.priority])}{' '}
                        <button
                          className="linkbtn"
                          onClick={(e) => openMenu(task, e.currentTarget)}
                        >
                          {tr('Change')}
                        </button>
                      </>
                    }
                  />
                  <EditField
                    task={task}
                    k="Category"
                    empty={!task.category}
                    pend={pend('category')}
                    start={() => ({ category: task.category })}
                    editor={(d, set) => (
                      <input
                        className="inp"
                        aria-label={tr('Category')}
                        value={d.category}
                        onChange={set('category')}
                        autoFocus
                      />
                    )}
                    patch={(d) => ({ category: d.category })}
                    v={
                      task.category || (
                        <span className="muted">{tr('Not set')}</span>
                      )
                    }
                  />
                  <EditField
                    task={task}
                    k="Remarks"
                    empty={!task.remarks}
                    pend={pend('remarks')}
                    start={() => ({ remarks: task.remarks })}
                    editor={(d, set) => (
                      <textarea
                        className="inp"
                        rows={3}
                        aria-label={tr('Remarks')}
                        lang={task.language}
                        value={d.remarks}
                        onChange={set('remarks')}
                        autoFocus
                      />
                    )}
                    patch={(d) => ({ remarks: d.remarks })}
                    v={
                      task.remarks ? (
                        <span lang={task.language}>{task.remarks}</span>
                      ) : (
                        <span className="muted">{tr('Empty')}</span>
                      )
                    }
                  />
                </div>
                <AddFields
                  names={[
                    !task.assignee && 'Assignee',
                    !task.plannedStart && !task.plannedEnd && 'Planned',
                    !task.actualStart && !task.actualEnd && 'Actual',
                    !task.category && 'Category',
                    !task.remarks && 'Remarks',
                  ].filter((x): x is string => !!x)}
                />
              </section>
              <section className="sec">
                <h3>{tr('Only for you')}</h3>
                <div className="fields">
                  <EditField
                    task={task}
                    k={
                      <>
                        <Icon name="check" />
                        {tr('Next action')}
                      </>
                    }
                    name="Next action"
                    empty={!task.nextAction && !task.nextActionDate}
                    start={() => ({
                      nextAction: task.nextAction,
                      nextActionDate: task.nextActionDate ?? '',
                    })}
                    editor={(d, set) => (
                      <>
                        <input
                          className="inp"
                          aria-label={tr('Next action')}
                          value={d.nextAction}
                          onChange={set('nextAction')}
                          autoFocus
                        />
                        <input
                          className="inp"
                          type="date"
                          aria-label={tr('Next action date')}
                          value={d.nextActionDate}
                          onChange={set('nextActionDate')}
                        />
                      </>
                    )}
                    patch={(d) => ({
                      nextAction: d.nextAction,
                      nextActionDate: d.nextActionDate || null,
                    })}
                    v={
                      task.nextAction ? (
                        <>
                          {task.nextAction}
                          {task.nextActionDate && (
                            <span className="muted">
                              {' '}
                              · {shortDate(task.nextActionDate)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="muted">{tr('None')}</span>
                      )
                    }
                  />
                  <EditField
                    task={task}
                    k="Notes"
                    empty={!task.notes}
                    start={() => ({ notes: task.notes })}
                    editor={(d, set) => (
                      <textarea
                        className="inp"
                        rows={4}
                        aria-label={tr('Notes')}
                        value={d.notes}
                        onChange={set('notes')}
                        autoFocus
                      />
                    )}
                    patch={(d) => ({ notes: d.notes })}
                    v={
                      task.notes ? (
                        <span style={{ whiteSpace: 'pre-wrap' }}>
                          {task.notes}
                        </span>
                      ) : (
                        <span className="muted">{tr('None')}</span>
                      )
                    }
                  />
                  <Links task={task} />
                </div>
                <AddFields
                  names={[
                    !task.nextAction && !task.nextActionDate && 'Next action',
                    !task.notes && 'Notes',
                    !task.links.length && 'Link',
                  ].filter((x): x is string => !!x)}
                />
              </section>
              <History task={task} />
              <SourceSection task={task} />
            </aside>
          </div>
        </div>
      </div>
    </AddCtx.Provider>
  );
}

const Field = ({
  k,
  v,
  pend,
}: {
  k: React.ReactNode;
  v: React.ReactNode;
  pend?: string;
}) => (
  <div className={`field ${pend ? 'pending' : ''}`}>
    <div className="k">{typeof k === 'string' ? tr(k) : k}</div>
    <div className="v">{v}</div>
    {pend && (
      <div className="pend">
        <Icon name="save" /> {pend}
      </div>
    )}
  </div>
);

/** Where a task came from: the file, sheet and row, and the columns that were not matched. */
function SourceSection({ task }: { task: Task }) {
  const { sources, attempt } = useApp();
  if (task.source !== 'file') {
    return (
      <section className="sec">
        <h3>{tr('Source')}</h3>
        <div className="field">
          <div className="v">
            {tr('Added by hand in WorkSync ·')} {LANGUAGES[task.language]}
          </div>
        </div>
      </section>
    );
  }
  const src = sources.find((s) => s.id === task.sourceFileId);
  const extra = Object.entries(task.extra);
  return (
    <section className="sec">
      <h3>{tr('From the file')}</h3>
      <div className="fields">
        {extra.map(([k, v]) => (
          <Field
            key={k}
            k={<span lang={task.language}>{k}</span>}
            v={<span lang={task.language}>{v}</span>}
          />
        ))}
        <div className="field">
          <div className="v">
            <Icon name="file" />{' '}
            {src
              ? (src.currentFile.split(/[\\/]/).pop() ?? src.currentFile)
              : tr('Unlinked file')}
            <br />
            <span className="muted">
              {src ? `sheet ${src.format.sheet} · ` : ''}row{' '}
              {task.sheetRow ?? '–'}
              {task.fileState === 'removed'
                ? tr(' · no longer in the file')
                : ''}
            </span>
          </div>
          {src && (
            <button
              className="btn sm"
              style={{ marginTop: 8 }}
              onClick={() =>
                void attempt(() => window.worksync.openSourceFile(src.id))
              }
            >
              {tr('Open in Excel')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
