import { useEffect, useMemo, useState } from 'react';
import {
  translationMap,
  untranslated,
  type OwnerAnswer,
  type OwnerBatch,
  type OwnerTranslation,
} from '../shared/ownerBatch';
import {
  LANGUAGES,
  LEVELS,
  LEVEL_NAME,
  STATUSES,
  type Level,
  type Project,
  type Status,
} from '../shared/model';
import {
  COLUMNS,
  DEFAULT_COLUMNS,
  REPORT_PARTS,
  type ReportPart,
  REPORTS,
  reportTasks,
  thisWeek,
  type ReportFormat,
  type ReportKind,
  type ReportLanguage,
  type ReportOptions,
} from '../shared/reports';
import { useApp } from './appState';
import { Icon, type IconName } from './Icon';
import { Modal } from './parts';
import { tr, uiLanguage } from './i18n';

const ICONS: Record<ReportKind, IconName> = {
  progress: 'gauge',
  taskList: 'menu',
  schedule: 'timeline',
  briefs: 'note',
};
const FORMAT_NAME: Record<ReportFormat, string> = {
  docx: 'Word',
  xlsx: 'Excel',
};
const PREPARED_KEY = 'worksync.preparedBy';

const PARTS_KEY = 'worksync.reportParts';

/** The report parts chosen last time; every part the first time. */
const rememberedParts = (): ReportPart[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(PARTS_KEY) ?? 'null');
    if (Array.isArray(saved))
      return REPORT_PARTS.map((p) => p.key).filter((k) => saved.includes(k));
  } catch {
    // Not saved, or not readable: every part.
  }
  return REPORT_PARTS.map((p) => p.key);
};

const remembered = () => {
  try {
    return localStorage.getItem(PREPARED_KEY) ?? '';
  } catch {
    return '';
  }
};

/** Reports (spec 05): choose the report, its scope, period and language, then save it. */
export function ReportDialog({
  project,
  taskIds,
  onClose,
}: {
  project: Project;
  /** Tasks chosen in the Tasks table; the report covers only these. */
  taskIds?: string[];
  onClose: () => void;
}) {
  const { tasks, today, attempt, toast } = useApp();
  const week = thisWeek(today);
  const [o, setO] = useState<ReportOptions>({
    kind: 'progress',
    format: 'docx',
    projectId: project.id,
    statuses: [],
    levels: [],
    label: '',
    person: '',
    from: week.from,
    to: week.to,
    language: 'working',
    columns: DEFAULT_COLUMNS,
    parts: rememberedParts(),
    includeNotes: false,
    preparedBy: remembered(),
    taskIds: taskIds?.length ? taskIds : undefined,
  });
  const [done, setDone] = useState<OwnerTranslation[]>([]);
  const [translating, setTranslating] = useState(false);
  const loadDone = async () => {
    const r = await attempt(() =>
      window.worksync.listOwnerTranslations(project.id),
    );
    if (r) setDone(r);
  };
  useEffect(() => {
    void loadDone();
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<ReportOptions>) => setO({ ...o, ...p });
  const inReport = useMemo(() => reportTasks(tasks, o), [tasks, o]);
  const count = inReport.length;
  const fileLang = project.originalLanguages[0] ?? 'ja';
  // Your notes in this report that have no translation into the file's language yet.
  const needing = useMemo(
    () =>
      o.language === 'working'
        ? []
        : inReport.filter((t) => untranslated(t, done, fileLang).length),
    [inReport, done, fileLang, o.language],
  );
  const needingParts = needing.reduce(
    (n, t) => n + untranslated(t, done, fileLang).length,
    0,
  );
  const translatedNow = Object.keys(
    translationMap(inReport, done, fileLang),
  ).length;
  const labels = [
    ...new Set(
      tasks.filter((t) => t.projectId === project.id).flatMap((t) => t.labels),
    ),
  ].sort();
  const original = LANGUAGES[project.originalLanguages[0] ?? 'ja'];
  const toggle = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const pick = (kind: ReportKind) =>
    set({
      kind,
      format: REPORTS[kind].formats.includes(o.format)
        ? o.format
        : REPORTS[kind].formats[0],
    });

  const make = async () => {
    try {
      localStorage.setItem(PREPARED_KEY, o.preparedBy);
      if (o.kind === 'progress' || o.kind === 'briefs')
        localStorage.setItem(PARTS_KEY, JSON.stringify(o.parts ?? []));
    } catch {
      // Remembering the name is only a convenience.
    }
    setBusy(true);
    const r = await attempt(() => window.worksync.makeReport(o));
    setBusy(false);
    if (!r) return;
    const name = r.file.split(/[\\/]/).pop();
    toast(`Saved ${name} with ${r.tasks} task${r.tasks === 1 ? '' : 's'}.`, {
      label: 'Open',
      run: () => void attempt(() => window.worksync.openCopy(r.file, false)),
    });
    onClose();
  };

  return (
    <Modal
      title={tr('Make a report')}
      subtitle={tr(
        '{name} · built from each task’s summary, situation and dates',
        { name: project.name },
      )}
      onClose={onClose}
      footer={
        <>
          <span
            className="muted"
            style={{ marginRight: 'auto', fontSize: 12.5 }}
          >
            {tr(
              count === 1
                ? '{n} task in this report'
                : '{n} tasks in this report',
              { n: count },
            )}
          </span>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn primary"
            disabled={busy || (o.kind === 'taskList' && !o.columns.length)}
            onClick={() => void make()}
          >
            <Icon name="save" />
            {busy
              ? tr('Making…')
              : tr('Make the {format} report', {
                  format: FORMAT_NAME[o.format],
                })}
          </button>
        </>
      }
    >
      <div className="report-kinds" role="radiogroup" aria-label={tr('Report')}>
        {(Object.keys(REPORTS) as ReportKind[]).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={o.kind === k}
            className="report-kind"
            onClick={() => pick(k)}
          >
            <Icon name={ICONS[k]} />
            <b>{tr(REPORTS[k].name)}</b>
            <small>{tr(REPORTS[k].description)}</small>
            <span className="fmt">
              {REPORTS[k].formats.map((f) => FORMAT_NAME[f]).join(' · ')}
            </span>
          </button>
        ))}
      </div>
      {o.taskIds && (
        <p className="report-note">
          <Icon name="check" />
          <span>
            {tr(
              o.taskIds.length === 1
                ? 'Only the {n} task you selected in the Tasks table.'
                : 'Only the {n} tasks you selected in the Tasks table.',
              { n: o.taskIds.length },
            )}
          </span>
          <button
            className="btn sm"
            onClick={() => set({ taskIds: undefined })}
          >
            {tr('Use the whole project')}
          </button>
        </p>
      )}
      <div className="form">
        <div className="two">
          <label>
            {tr('Format')}
            <div
              className="seg-ctl"
              role="radiogroup"
              aria-label={tr('Format')}
            >
              {REPORTS[o.kind].formats.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={o.format === f}
                  onClick={() => set({ format: f })}
                >
                  {FORMAT_NAME[f]}
                </button>
              ))}
            </div>
          </label>
          <label>
            {tr('Language')}
            <select
              className="inp"
              value={o.language}
              onChange={(e) =>
                set({ language: e.target.value as ReportLanguage })
              }
            >
              <option value="working">
                {LANGUAGES[project.workingLanguage]}
              </option>
              <option value="original">
                {original}
                {tr(', the customer’s language')}
              </option>
              <option value="both">{tr('Both, side by side')}</option>
            </select>
          </label>
        </div>
        {o.language !== 'working' &&
          (translating ? (
            <OwnerTranslate
              project={project}
              taskIds={needing.map((t) => t.id)}
              onDone={async () => {
                setTranslating(false);
                await loadDone();
              }}
            />
          ) : (
            <p className="report-note">
              <Icon name={needingParts ? 'globe' : 'check'} />
              <span>
                {needingParts
                  ? `${needingParts} of your notes on ${needing.length} task${needing.length === 1 ? '' : 's'} are only in ${LANGUAGES[project.workingLanguage]}. ${o.language === 'original' ? 'They are marked as not translated.' : 'They show without a translation.'}${translatedNow ? ` ${translatedNow} are translated already.` : ''}`
                  : `Your notes in this report are all translated into ${original}.`}
              </span>
              {needingParts > 0 && (
                <button
                  className="btn sm accent-outline"
                  onClick={() => setTranslating(true)}
                >
                  <Icon name="spark" />
                  {tr('Translate with Gemini')}
                </button>
              )}
            </p>
          ))}
        {o.kind === 'progress' && (
          <div className="two">
            <label>
              {tr('Period from')}
              <input
                className="inp"
                type="date"
                value={o.from}
                onChange={(e) => set({ from: e.target.value })}
              />
            </label>
            <label>
              {tr('to')}
              <input
                className="inp"
                type="date"
                value={o.to}
                onChange={(e) => set({ to: e.target.value })}
              />
            </label>
          </div>
        )}
        <fieldset>
          <legend>{tr('Which tasks')}</legend>
          <div className="checks">
            {STATUSES.map((s) => (
              <label key={s} className="check">
                <input
                  type="checkbox"
                  checked={o.statuses.includes(s)}
                  onChange={() =>
                    set({ statuses: toggle<Status>(o.statuses, s) })
                  }
                />{' '}
                {tr(s)}
              </label>
            ))}
          </div>
          <div className="checks">
            {LEVELS.map((l) => (
              <label key={l} className="check">
                <input
                  type="checkbox"
                  checked={o.levels.includes(l)}
                  onChange={() => set({ levels: toggle<Level>(o.levels, l) })}
                />{' '}
                {tr(LEVEL_NAME[l])}
              </label>
            ))}
          </div>
          <div className="two">
            <label>
              {tr('Label')}
              <select
                className="inp"
                value={o.label}
                onChange={(e) => set({ label: e.target.value })}
              >
                <option value="">{tr('Any label')}</option>
                {labels.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <label>
              {tr('Assignee or handled by')}
              <input
                className="inp"
                value={o.person}
                onChange={(e) => set({ person: e.target.value })}
                placeholder={tr('Anyone')}
              />
            </label>
          </div>
          <span className="hint-text">
            {tr('Leave a group unticked to include all of it.')}
            {o.kind === 'progress'
              ? tr(
                  ' The progress report covers open tasks and tasks that changed in the period.',
                )
              : ''}
          </span>
        </fieldset>
        {(o.kind === 'progress' || o.kind === 'briefs') && (
          <fieldset>
            <legend>{tr('Contents')}</legend>
            <div className="checks">
              {REPORT_PARTS.filter((p) => p.kinds.includes(o.kind)).map((p) => (
                <label key={p.key} className="check">
                  <input
                    type="checkbox"
                    checked={(o.parts ?? []).includes(p.key)}
                    onChange={() =>
                      set({
                        parts: REPORT_PARTS.map((x) => x.key).filter((k) =>
                          k === p.key
                            ? !(o.parts ?? []).includes(k)
                            : (o.parts ?? []).includes(k),
                        ),
                      })
                    }
                  />{' '}
                  {uiLanguage() === 'ja' ? p.ja : p.label}
                </label>
              ))}
            </div>
            <span className="hint-text">
              {tr(
                'Untick what the report should leave out. Each task keeps its number, title and status.',
              )}
            </span>
          </fieldset>
        )}
        {o.kind === 'taskList' && (
          <fieldset>
            <legend>{tr('Columns')}</legend>
            <div className="checks">
              {COLUMNS.filter((c) => c.key !== 'notes').map((c) => (
                <label key={c.key} className="check">
                  <input
                    type="checkbox"
                    checked={o.columns.includes(c.key)}
                    onChange={() =>
                      set({
                        columns: toggle(o.columns, c.key).sort(
                          (a, b) =>
                            COLUMNS.findIndex((x) => x.key === a) -
                            COLUMNS.findIndex((x) => x.key === b),
                        ),
                      })
                    }
                  />{' '}
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="two">
          <label>
            {tr('Prepared by')}
            <input
              className="inp"
              value={o.preparedBy}
              onChange={(e) => set({ preparedBy: e.target.value })}
              placeholder={tr('Your name, shown at the top')}
            />
          </label>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input
              type="checkbox"
              checked={o.includeNotes}
              onChange={(e) =>
                set({
                  includeNotes: e.target.checked,
                  columns:
                    e.target.checked && o.kind === 'taskList'
                      ? [...o.columns, 'notes']
                      : o.columns.filter((c) => c !== 'notes'),
                })
              }
            />{' '}
            {tr('Include my notes')}
          </label>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Translates the owner's notes into the file's language with Gemini (spec 05):
 * copy each request, paste each answer, and save what came back.
 */
export function OwnerTranslate({
  project,
  taskIds,
  onDone,
  what = 'your notes',
  prepare = () => window.worksync.prepareOwnerBatches(project.id, taskIds),
  saveAll = (list) => window.worksync.saveOwnerTranslations(list),
}: {
  project: Project;
  taskIds: string[];
  onDone: () => Promise<void>;
  /** What is translated, in the heading and messages. */
  what?: string;
  prepare?: () => Promise<OwnerBatch[]>;
  saveAll?: (list: OwnerAnswer['translations']) => Promise<number>;
}) {
  const { attempt, toast } = useApp();
  const [batches, setBatches] = useState<OwnerBatch[] | null>(null);
  const [at, setAt] = useState(0);
  const [answer, setAnswer] = useState('');
  const [read, setRead] = useState<OwnerAnswer | null>(null);
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    void attempt(prepare).then((b) => {
      if (b && !b.length) void onDone();
      else if (b) setBatches(b);
    });
    // Once, for the tasks that needed it when it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!batches) return <p className="muted">{tr('Preparing the request…')}</p>;
  const batch = batches[at];
  if (!batch) return null;
  const copy = async () => {
    await attempt(() => window.worksync.copyText(batch.text));
    toast(
      `Request ${batch.number} of ${batch.of} copied. Paste it into Gemini, then paste the answer here.`,
    );
  };
  const check = async (text: string) => {
    setAnswer(text);
    setRead(
      text.trim()
        ? ((await attempt(() =>
            window.worksync.readOwnerAnswer(batch, text),
          )) ?? null)
        : null,
    );
  };
  const save = async () => {
    if (!read) return;
    const n = await attempt(() => saveAll(read.translations));
    if (n === undefined) return;
    setSaved(saved + n);
    setAnswer('');
    setRead(null);
    if (at + 1 >= batches.length) {
      toast(
        tr('Saved {n} translations of {what}.', {
          n: saved + n,
          what: tr(what),
        }),
      );
      await onDone();
    } else setAt(at + 1);
  };
  return (
    <div className="owner-tr">
      <div className="owner-tr-head">
        <b>
          {tr('Translate {what} · request {n} of {total}', {
            what: tr(what),
            n: batch.number,
            total: batch.of,
          })}
        </b>
        <button className="btn sm" onClick={() => void onDone()}>
          {tr('Cancel')}
        </button>
      </div>
      <ol className="owner-steps">
        <li>
          <button className="btn sm" onClick={() => void copy()}>
            <Icon name="copy" />
            {tr('Copy request')} {batch.number}
          </button>{' '}
          {tr('and paste it into Gemini.')} {Object.keys(batch.keys).length}{' '}
          tasks.
        </li>
        <li>
          {tr('Paste Gemini’s whole answer here:')}
          <textarea
            className="inp"
            rows={5}
            value={answer}
            aria-label={tr('Gemini’s answer')}
            onChange={(e) => void check(e.target.value)}
          />
        </li>
      </ol>
      {read && (
        <p
          className={
            read.missing.length || read.incomplete.length
              ? 'warn-text'
              : 'muted'
          }
        >
          {read.translations.length} {tr('translations found')}
          {read.missing.length
            ? ` · ${read.missing.length} tasks missing (${read.missing.join(', ')})`
            : ''}
          {read.incomplete.length
            ? ` · ${read.incomplete.length} lines empty`
            : ''}
          {read.unknown.length
            ? ` · ${read.unknown.length} not asked for, ignored`
            : ''}
        </p>
      )}
      <div className="owner-tr-foot">
        <button
          className="btn primary sm"
          disabled={!read?.translations.length}
          onClick={() => void save()}
        >
          <Icon name="check" />
          {tr('Save')} {read?.translations.length ?? 0} translations
        </button>
      </div>
    </div>
  );
}
