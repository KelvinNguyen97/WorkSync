import { useEffect, useState } from 'react';
import {
  columnLetter,
  headerNames,
  type ColumnMapping,
  type FileFormat,
} from '../shared/importRules';
import { ColumnMap } from './LinkWizard';
import {
  LANGUAGES,
  LEVELS,
  LEVEL_NAME,
  STATUSES,
  type Level,
  type Status,
} from '../shared/model';
import {
  SOURCE_STATE_NAME,
  type Review,
  type SourceFile,
} from '../shared/sources';
import { useApp } from './appState';
import { Icon } from './Icon';
import { Modal } from './parts';
import type { ViewProps } from './views';
import { tr } from './i18n';

const STATE_CLASS = {
  ok: 'ok',
  changed: 'chg',
  missing: 'miss',
  unavailable: 'na',
  unreadable: 'miss',
} as const;
const name = (p: string) => p.split(/[\\/]/).pop() ?? p;
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Each project's linked source files and their state (spec 03, Files). */
export function FilesView({
  projectId,
  props,
  onLink,
  onReview,
}: {
  projectId: string;
  props: ViewProps;
  onLink: () => void;
  onReview: (s: SourceFile) => void;
}) {
  const { sources, project, attempt, toast, setSources, reloadTasks } =
    useApp();
  const [columnsOf, setColumnsOf] = useState<SourceFile | null>(null);
  const p = project(projectId)!;
  const list = sources.filter((s) => s.projectId === projectId);
  const [confirm, setConfirm] = useState<SourceFile | null>(null);
  const check = async () => {
    const s = await attempt(() => window.worksync.checkSources());
    if (s) {
      setSources(s);
      toast(tr('Checked the linked files.'));
    }
  };
  return (
    <>
      {props.header(
        tr('Files'),
        tr('{name} · files are linked by their path and only ever read', {
          name: p.name,
        }),
        <div style={{ display: 'flex', gap: 8 }}>
          {list.length > 0 && (
            <button className="btn" onClick={() => void check()}>
              <Icon name="refresh" />
              <span className="lbl">{tr('Check now')}</span>
            </button>
          )}
          <button className="btn primary" onClick={onLink}>
            <Icon name="link" />
            <span className="lbl">{tr('Link a file')}</span>
          </button>
        </div>,
      )}
      {list.length ? (
        <div className="panel">
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr('File')}</th>
                  <th>{tr('State')}</th>
                  <th>{tr('Last read')}</th>
                  <th>{tr('Main language')}</th>
                  <th>{tr('Tasks')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {s.pattern
                          ? `${s.pattern} (newest: ${name(s.currentFile)})`
                          : name(s.path)}
                      </div>
                      <div className="path">{s.pattern ? s.path : s.path}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {tr('Format')} {s.format.name} {tr('· sheet')}{' '}
                        {s.format.sheet}
                      </div>
                    </td>
                    <td>
                      <span className={`state ${STATE_CLASS[s.state]}`}>
                        {SOURCE_STATE_NAME[s.state]}
                      </span>
                      {s.stateDetail && (
                        <div className="muted state-detail">
                          {s.stateDetail}
                        </div>
                      )}
                    </td>
                    <td>{when(s.lastReadAt)}</td>
                    <td>{LANGUAGES[s.mainLanguage]}</td>
                    <td className="mono">{s.taskCount}</td>
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          gap: 6,
                          justifyContent: 'flex-end',
                          flexWrap: 'wrap',
                        }}
                      >
                        {s.state === 'changed' && (
                          <button
                            className="btn sm accent-outline"
                            onClick={() => onReview(s)}
                          >
                            {tr('Review changes')}
                          </button>
                        )}
                        {s.state === 'missing' && (
                          <button
                            className="btn sm accent-outline"
                            title={tr(
                              'The file is not at its old place. Choose where it is now.',
                            )}
                            onClick={async () => {
                              const u = await attempt(() =>
                                window.worksync.relinkSource(s.id),
                              );
                              if (!u) return;
                              setSources(await window.worksync.listSources());
                              toast(
                                u.state === 'changed'
                                  ? 'Found. The file has changes: review them.'
                                  : 'Found. The link follows the file at its new place.',
                              );
                            }}
                          >
                            {tr('Find the file')}
                          </button>
                        )}
                        <button
                          className="btn sm"
                          title={tr('Open in Excel')}
                          onClick={() =>
                            void attempt(() =>
                              window.worksync.openSourceFile(s.id),
                            )
                          }
                        >
                          {tr('Open')}
                        </button>
                        <button
                          className="btn sm"
                          title={tr(
                            'Change which column holds the ID, the title and the other fields',
                          )}
                          onClick={() => setColumnsOf(s)}
                        >
                          {tr('Columns')}
                        </button>
                        <button
                          className="btn sm"
                          title={tr('Stop following this file')}
                          onClick={() => setConfirm(s)}
                        >
                          {tr('Unlink')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="empty">
          <p style={{ margin: '0 0 12px' }}>
            {tr(
              'No files linked yet. Link the customer’s Excel file, for example the WBS or the issue list in your Box Drive folder.',
            )}
          </p>
          <button className="btn primary" onClick={onLink}>
            <Icon name="link" />
            {tr('Link a file')}
          </button>
        </div>
      )}
      <div className="legend">
        <span>
          <Icon name="shield" />
          {tr(
            'WorkSync copies each version into its own data folder and reads the copy, so the customer’s file is never changed or kept open.',
          )}
        </span>
      </div>
      {columnsOf && (
        <ColumnsDialog
          source={columnsOf}
          onClose={() => setColumnsOf(null)}
          onSaved={(updated) => {
            setColumnsOf(null);
            onReview(updated);
          }}
        />
      )}
      {confirm && (
        <Modal
          title={tr('Unlink {file}?', { file: name(confirm.currentFile) })}
          subtitle={tr(
            'Its tasks stay, with their history, and are marked Removed from file. The file itself is not touched.',
          )}
          onClose={() => setConfirm(null)}
          narrow
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>
                {tr('Keep it')}
              </button>
              <button
                className="btn danger"
                onClick={() =>
                  void attempt(async () => {
                    await window.worksync.unlinkSource(confirm.id);
                    setSources(await window.worksync.listSources());
                    await reloadTasks();
                    setConfirm(null);
                    toast(tr('Unlinked. The tasks are kept.'));
                  })
                }
              >
                {tr('Unlink')}
              </button>
            </>
          }
        >
          <div className="path">{confirm.currentFile}</div>
        </Modal>
      )}
    </>
  );
}

const FIELD_LABEL: Record<string, string> = {
  customerId: 'ID',
  title: 'Title',
  description: 'Description',
  assignee: 'Assignee',
  plannedStart: 'Planned start',
  plannedEnd: 'Planned end',
  actualStart: 'Actual start',
  actualEnd: 'Actual end',
  statusWord: 'Status',
  priorityWord: 'Priority',
  category: 'Category',
  remarks: 'Remarks',
};
const label = (f: string) =>
  f.startsWith('extra:') ? f.slice(6) : (FIELD_LABEL[f] ?? f);

/** Reviewing a new version (spec 03): nothing changes until the owner applies it. */
export function ReviewDialog({
  source,
  onClose,
}: {
  source: SourceFile;
  onClose: () => void;
}) {
  const { attempt, toast, reloadTasks, setSources } = useApp();
  const [review, setReview] = useState<Review | null>(null);
  const [byTitle, setByTitle] = useState(false);
  const [tab, setTab] = useState<'added' | 'changed' | 'removed'>('changed');
  const [add, setAdd] = useState<Set<number>>(new Set());
  const [change, setChange] = useState<Set<string>>(new Set());
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [keepMine, setKeepMine] = useState<Record<string, Set<string>>>({});
  const [format, setFormat] = useState<FileFormat>(source.format);
  // New rows joined by hand to a task that is no longer in the file: row → task.
  const [joins, setJoins] = useState<Record<number, string>>({});
  const { tasks } = useApp();
  const [busy, setBusy] = useState(false);

  const load = async (bt: boolean, f?: FileFormat) => {
    if (f) {
      const s = await attempt(() =>
        window.worksync.updateSourceFormat(source.id, f),
      );
      if (!s) return;
    }
    const r = await attempt(() => window.worksync.reviewSource(source.id, bt));
    if (!r) return onClose();
    setReview(r);
    setAdd(
      new Set(
        r.added.filter((x) => !r.deletedRows.includes(x.row)).map((x) => x.row),
      ),
    );
    setChange(new Set(r.changed.map((x) => x.taskId)));
    setRemove(new Set(r.removed.map((x) => x.taskId)));
    // Where the owner also changed a field, keep the owner's value until they choose otherwise.
    setKeepMine(
      Object.fromEntries(
        r.changed.map((c) => [
          c.taskId,
          new Set(c.changes.filter((x) => x.conflict).map((x) => x.field)),
        ]),
      ),
    );
    setTab(r.changed.length ? 'changed' : r.added.length ? 'added' : 'removed');
  };
  useEffect(() => {
    void load(false);
    // Load once when the dialog opens.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!review) {
    return (
      <Modal
        title={tr('Review the new version')}
        subtitle={name(source.currentFile)}
        onClose={onClose}
        narrow
      >
        <p className="muted">{tr('Reading the file…')}</p>
      </Modal>
    );
  }

  const unmapped =
    review.unmappedStatus.length + review.unmappedPriority.length > 0;
  const toggle = <T,>(set: Set<T>, v: T, put: (s: Set<T>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    put(n);
  };
  const joinCount = Object.keys(joins).length;
  const count = add.size + change.size + remove.size + joinCount;
  // Tasks a new row can be joined to: those leaving the file now, and those already removed.
  const joinable = review
    ? [
        ...review.removed.map((x) => ({ ...x, already: false })),
        ...tasks
          .filter(
            (t) => t.sourceFileId === source.id && t.fileState === 'removed',
          )
          .map((t) => ({
            taskId: t.id,
            customerId: t.customerId,
            title: t.titleTranslation || t.titleOriginal,
            already: true,
          })),
      ]
    : [];
  const join = (row: number, taskId: string) => {
    const next = { ...joins };
    for (const [r, id] of Object.entries(next))
      if (id === taskId) delete next[Number(r)];
    if (taskId) next[row] = taskId;
    else delete next[row];
    setJoins(next);
    const a = new Set(add);
    if (taskId) a.delete(row);
    else a.add(row);
    setAdd(a);
    const rm = new Set(remove);
    for (const id of Object.values(next)) rm.delete(id);
    setRemove(rm);
  };

  const apply = async () => {
    setBusy(true);
    const r = await attempt(() =>
      window.worksync.applySource(source.id, {
        byTitle,
        addRows: [...add],
        change: [...change].map((taskId) => ({
          taskId,
          keepMine: [...(keepMine[taskId] ?? [])],
        })),
        removeTaskIds: [...remove].filter(
          (id) => !Object.values(joins).includes(id),
        ),
        join: Object.entries(joins).map(([row, taskId]) => ({
          row: Number(row),
          taskId,
        })),
      }),
    );
    setBusy(false);
    if (!r) return;
    await reloadTasks();
    setSources(await window.worksync.listSources());
    toast(
      `Applied: ${r.added} new, ${r.changed} changed, ${r.removed} removed. Each task’s history records it.`,
    );
    onClose();
  };

  return (
    <Modal
      title={tr('Review the new version')}
      subtitle={`${review.fileName} changed ${when(review.modifiedAt)}. Nothing changes until you apply it.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Later')}
          </button>
          <button
            className="btn primary"
            disabled={busy || unmapped}
            onClick={() => void apply()}
          >
            <Icon name="check" />
            {count
              ? `Apply ${count} change${count === 1 ? '' : 's'}`
              : tr('Mark as reviewed')}
          </button>
        </>
      }
    >
      {unmapped && (
        <div className="panel" style={{ padding: 12 }}>
          <b>{tr('New values in the file')}</b>
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            {tr('Say what they mean once. The file format remembers them.')}
          </p>
          <div className="map-grid">
            {review.unmappedStatus.map((v) => (
              <label key={`s${v}`}>
                {tr('Status “')}
                {v}”
                <select
                  className="inp"
                  defaultValue=""
                  onChange={(e) =>
                    setFormat({
                      ...format,
                      statusWords: {
                        ...format.statusWords,
                        [v]: e.target.value as Status,
                      },
                    })
                  }
                >
                  <option value="">{tr('Choose…')}</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {tr(s)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {review.unmappedPriority.map((v) => (
              <label key={`p${v}`}>
                {tr('Priority “')}
                {v}”
                <select
                  className="inp"
                  defaultValue=""
                  onChange={(e) =>
                    setFormat({
                      ...format,
                      priorityWords: {
                        ...format.priorityWords,
                        [v]: e.target.value as Level,
                      },
                    })
                  }
                >
                  <option value="">{tr('Choose…')}</option>
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {tr(LEVEL_NAME[l])}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button
            className="btn sm primary"
            style={{ marginTop: 10 }}
            disabled={
              [...review.unmappedStatus].some((v) => !format.statusWords[v]) ||
              [...review.unmappedPriority].some((v) => !format.priorityWords[v])
            }
            onClick={() => void load(byTitle, format)}
          >
            {tr('Save and continue')}
          </button>
        </div>
      )}
      {review.looksRenumbered && !byTitle && (
        <div className="keepnote">
          <Icon name="alert" />
          <span>
            {tr(
              'Many IDs changed while the titles stayed the same, so the file seems to be renumbered.',
            )}{' '}
            <button
              className="linkbtn"
              onClick={() => {
                setByTitle(true);
                void load(true);
              }}
            >
              {tr('Match by title instead')}
            </button>
          </span>
        </div>
      )}
      <div className="tabs" role="tablist">
        {(
          [
            ['added', 'New tasks', review.added.length],
            ['changed', 'Changed', review.changed.length],
            ['removed', 'Removed', review.removed.length],
          ] as const
        ).map(([k, l, n]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {l} · {n}
          </button>
        ))}
      </div>
      <div className="review-list">
        {tab === 'added' &&
          (review.added.length ? (
            review.added.map((r) => (
              <div className="diff-row" key={r.row}>
                <input
                  type="checkbox"
                  checked={add.has(r.row)}
                  disabled={!!joins[r.row]}
                  onChange={() => toggle(add, r.row, setAdd)}
                  aria-label={tr('Add row {n} as a new task', { n: r.row })}
                />
                <div>
                  <span className="tid">
                    {tr('No.')} {r.customerId || '–'} {tr('· row')} {r.row}
                  </span>
                  <div
                    className="title"
                    style={{ fontSize: 14 }}
                    lang={source.mainLanguage}
                  >
                    {r.title}
                  </div>
                  <div className="chg">
                    {joins[r.row]
                      ? tr(
                          'Joined to the task chosen below; it keeps its summary, situation and history',
                        )
                      : review.deletedRows.includes(r.row)
                        ? tr(
                            'You deleted this task, but it is still in the file. Tick it to bring it back.',
                          )
                        : `New row · added as Not translated · ${r.status}`}
                  </div>
                  {joinable.length > 0 && (
                    <label className="join-row">
                      {tr('Same task as')}
                      <select
                        className="inp sm"
                        value={joins[r.row] ?? ''}
                        onChange={(e) => join(r.row, e.target.value)}
                      >
                        <option value="">{tr('None, it is a new task')}</option>
                        {joinable.map((x) => (
                          <option key={x.taskId} value={x.taskId}>
                            {tr('No.')} {x.customerId || '–'} ·{' '}
                            {x.title.slice(0, 40)}
                            {x.already
                              ? tr(' (removed earlier)')
                              : tr(' (leaving the file)')}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="muted">{tr('No new rows.')}</p>
          ))}
        {tab === 'changed' &&
          (review.changed.length ? (
            review.changed.map((c) => (
              <div className="diff-row" key={c.taskId}>
                <input
                  type="checkbox"
                  checked={change.has(c.taskId)}
                  onChange={() => toggle(change, c.taskId, setChange)}
                  aria-label={tr('Apply changes to No. {no}', {
                    no: c.customerId,
                  })}
                />
                <div>
                  <span className="tid">
                    {tr('No.')} {c.customerId}
                  </span>
                  <div className="title" style={{ fontSize: 14 }}>
                    {c.title}
                  </div>
                  {c.changes.map((x) => (
                    <div key={x.field} className="chg">
                      <span>{label(x.field)}</span>:{' '}
                      <span className="old">{x.from || tr('(empty)')}</span>
                      <span className="arrow">→</span>
                      <span className="new">{x.to || tr('(empty)')}</span>
                      {x.conflict && (
                        <div className="conflict">
                          <b>{tr('You changed this too')}</b>
                          <label>
                            <input
                              type="radio"
                              name={`${c.taskId}:${x.field}`}
                              checked={
                                keepMine[c.taskId]?.has(x.field) ?? false
                              }
                              onChange={() =>
                                setKeepMine({
                                  ...keepMine,
                                  [c.taskId]: new Set([
                                    ...(keepMine[c.taskId] ?? []),
                                    x.field,
                                  ]),
                                })
                              }
                            />{' '}
                            {tr('Keep yours:')} {x.appValue || tr('(empty)')}
                          </label>
                          <label>
                            <input
                              type="radio"
                              name={`${c.taskId}:${x.field}`}
                              checked={!keepMine[c.taskId]?.has(x.field)}
                              onChange={() =>
                                setKeepMine({
                                  ...keepMine,
                                  [c.taskId]: new Set(
                                    [...(keepMine[c.taskId] ?? [])].filter(
                                      (f) => f !== x.field,
                                    ),
                                  ),
                                })
                              }
                            />{' '}
                            {tr('Use the file:')} {x.to || tr('(empty)')}
                          </label>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="muted">{tr('No changed tasks.')}</p>
          ))}
        {tab === 'removed' &&
          (review.removed.length ? (
            review.removed.map((r) => (
              <label className="diff-row" key={r.taskId}>
                <input
                  type="checkbox"
                  checked={remove.has(r.taskId)}
                  onChange={() => toggle(remove, r.taskId, setRemove)}
                />
                <div>
                  <span className="tid">
                    {tr('No.')} {r.customerId}
                  </span>
                  <div className="title" style={{ fontSize: 14 }}>
                    {r.title}
                  </div>
                  <div className="chg">
                    {tr(
                      'No longer in the file. The task is kept with its history and marked Removed from file.',
                    )}
                  </div>
                </div>
              </label>
            ))
          ) : (
            <p className="muted">{tr('No removed rows.')}</p>
          ))}
      </div>
      {review.skipped.length > 0 && (
        <details className="skipped">
          <summary>
            {review.skipped.length}{' '}
            {tr(
              'rows were skipped, such as blank rows, totals and section titles',
            )}
          </summary>
          <ul>
            {review.skipped.slice(0, 50).map((s) => (
              <li key={s.row}>
                <span className="mono">
                  {tr('Row')} {s.row}
                </span>{' '}
                · {s.text.slice(0, 80)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        {tr('Columns:')}{' '}
        {Object.entries(source.format.columns)
          .map(
            ([f, c]) =>
              `${label(f === 'status' ? 'statusWord' : f === 'priority' ? 'priorityWord' : f)} ${columnLetter(c!)}`,
          )
          .join(' · ')}
      </p>
    </Modal>
  );
}

/**
 * Changes which column holds each field of a linked file, such as using the
 * ID as the title. Saving opens the review, where the new titles and fields
 * are applied like any other change from the file.
 */
function ColumnsDialog({
  source,
  onClose,
  onSaved,
}: {
  source: SourceFile;
  onClose: () => void;
  onSaved: (s: SourceFile) => void;
}) {
  const { attempt, setSources } = useApp();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [columns, setColumns] = useState<ColumnMapping>(source.format.columns);
  const [dayFirst, setDayFirst] = useState(!!source.format.dayFirst);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void attempt(() => window.worksync.sourceSheet(source.id)).then((r) =>
      r ? setRows(r.rows) : onClose(),
    );
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const headers = rows ? headerNames(rows, source.format.headerRows) : [];
  const sample = (col: number) =>
    (rows ?? [])
      .slice(Math.max(...source.format.headerRows) + 1)
      .map((r) => r[col])
      .find(Boolean) ?? '';
  const changed =
    JSON.stringify(columns) !== JSON.stringify(source.format.columns) ||
    dayFirst !== !!source.format.dayFirst;
  const save = async () => {
    setBusy(true);
    const s = await attempt(() =>
      window.worksync.updateSourceFormat(source.id, {
        ...source.format,
        columns,
        dayFirst,
      }),
    );
    setBusy(false);
    if (!s) return;
    setSources(await window.worksync.listSources());
    onSaved(s);
  };
  return (
    <Modal
      title={tr('Columns')}
      subtitle={`${source.format.name} · sheet ${source.format.sheet}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!changed || columns.title === undefined || busy}
            onClick={() => void save()}
          >
            <Icon name="check" />
            {tr('Save and review the changes')}
          </button>
        </>
      }
    >
      {rows ? (
        <>
          <p className="muted step-help">
            {tr(
              'After saving, the review shows what changes in your tasks, such as new titles. Nothing changes until you apply it. Your summaries, situations and notes stay.',
            )}
          </p>
          <ColumnMap
            columns={columns}
            setColumns={setColumns}
            headers={headers}
            sample={sample}
          />
          <label className="check" style={{ marginTop: 12 }}>
            {tr('Dates such as 3/11 mean')}
            <select
              className="inp sm"
              style={{ marginLeft: 8 }}
              value={dayFirst ? 'day' : 'month'}
              onChange={(e) => setDayFirst(e.target.value === 'day')}
              aria-label={tr('Order of month and day')}
            >
              <option value="month">
                {tr('11 March, month first (Japan, US)')}
              </option>
              <option value="day">
                {tr('3 November, day first (Vietnam, UK)')}
              </option>
            </select>
          </label>
        </>
      ) : (
        <p className="muted">{tr('Reading the file…')}</p>
      )}
    </Modal>
  );
}
