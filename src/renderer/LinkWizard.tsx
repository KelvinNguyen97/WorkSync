import { useEffect, useMemo, useState } from 'react';
import {
  FIELD_NAMES,
  IMPORT_FIELDS,
  columnFree,
  columnLetter,
  headerNames,
  proposeLevel,
  proposeStatus,
  suggestHeaderRows,
  suggestMapping,
  type ColumnMapping,
  type FileFormat,
  type ImportField,
} from '../shared/importRules';
import {
  LANGUAGES,
  LEVELS,
  LEVEL_NAME,
  STATUSES,
  detectLanguage,
  type LanguageCode,
  type Level,
  type Project,
  type Status,
} from '../shared/model';
import type { FileInspection, FormatPreview } from '../shared/sources';
import { useApp } from './appState';
import { Icon } from './Icon';
import { Modal } from './parts';
import { tr } from './i18n';

const STEPS = ['File', 'Header rows', 'Columns', 'Values', 'Preview'] as const;

const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file;

/** Suggests a name pattern from a dated file name, such as WBS_20261103.xlsx → WBS_*.xlsx. */
function suggestPattern(name: string): string | null {
  const m = name.match(/^(.*?)(\d{6,8}|\d{4}[-_.]\d{2}[-_.]\d{2}|v\d+)(.*)$/i);
  return m ? `${m[1]}*${m[3]}` : null;
}

/**
 * Setting up a file format and linking the file (spec 04). The app suggests
 * an answer at each step, so most steps only need a check.
 */
export function LinkWizard({
  project,
  onClose,
  onLinked,
}: {
  project: Project;
  onClose: () => void;
  onLinked: () => void;
}) {
  const { attempt, toast, reloadTasks, setSources } = useApp();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<string | null>(null);
  const [info, setInfo] = useState<FileInspection | null>(null);
  const [sheet, setSheet] = useState('');
  const [usePattern, setUsePattern] = useState(false);
  const [pattern, setPattern] = useState('');
  const [headerRows, setHeaderRows] = useState<number[]>([0]);
  const [columns, setColumns] = useState<ColumnMapping>({});
  const [statusWords, setStatusWords] = useState<Record<string, Status>>({});
  const [priorityWords, setPriorityWords] = useState<Record<string, Level>>({});
  const [dayFirst, setDayFirst] = useState(false);
  const [mainLanguage, setMainLanguage] = useState<LanguageCode>(
    project.originalLanguages[0] ?? 'ja',
  );
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<FormatPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const grid: string[][] = useMemo(
    () => info?.sheets.find((s) => s.name === sheet)?.rows ?? [],
    [info, sheet],
  );
  const headers = useMemo(
    () => headerNames(grid, headerRows),
    [grid, headerRows],
  );
  const format: FileFormat = {
    name: name || baseName(file ?? ''),
    sheet,
    headerRows,
    columns,
    statusWords,
    priorityWords,
    dayFirst,
  };

  const choose = async () => {
    const f = await attempt(() => window.worksync.chooseFile());
    if (!f) return;
    setBusy(true);
    const i = await attempt(() => window.worksync.inspectFile(f));
    setBusy(false);
    if (!i) return;
    setFile(f);
    setInfo(i);
    // The sheet with the most rows is usually the task list.
    const best = [...i.sheets].sort((a, b) => b.rowCount - a.rowCount)[0];
    pickSheet(i, best?.name ?? '');
    const p = suggestPattern(i.fileName);
    setPattern(p ?? '');
    setUsePattern(false);
    setName(i.fileName.replace(/\.[^.]+$/, ''));
  };

  const pickSheet = (i: FileInspection, s: string) => {
    setSheet(s);
    const rows = i.sheets.find((x) => x.name === s)?.rows ?? [];
    const hr = suggestHeaderRows(rows);
    setHeaderRows(hr);
    setColumns(suggestMapping(headerNames(rows, hr)));
  };

  const toggleHeaderRow = (r: number, add: boolean) => {
    const next = add
      ? headerRows.includes(r)
        ? headerRows.filter((x) => x !== r)
        : [...headerRows, r].sort((a, b) => a - b).slice(-2)
      : [r];
    if (!next.length) return;
    setHeaderRows(next);
    setColumns(suggestMapping(headerNames(grid, next)));
  };

  // Load the preview for the values and preview steps.
  useEffect(() => {
    if (!file || step < 3) return;
    let live = true;
    void window.worksync.previewFormat(file, format).then(
      (p) => {
        if (!live) return;
        setPreview(p);
        // Propose meanings for values the format does not have yet.
        setStatusWords((cur) => {
          const next = { ...cur };
          for (const v of p.statusValues)
            if (!next[v]) next[v] = proposeStatus(v) ?? ('' as Status);
          return next;
        });
        setPriorityWords((cur) => {
          const next = { ...cur };
          for (const v of p.priorityValues)
            if (!next[v]) next[v] = proposeLevel(v) ?? ('' as Level);
          return next;
        });
        const sample = p.rows
          .slice(0, 10)
          .map((r) => r.title)
          .join(' ');
        if (sample && step === 3)
          setMainLanguage((m) =>
            p.rows.length
              ? detectLanguage(sample, project.originalLanguages, m)
              : m,
          );
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // Re-read when the format's reading rules change, not on every keystroke in the name.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    file,
    step,
    sheet,
    JSON.stringify(headerRows),
    JSON.stringify(columns),
    JSON.stringify(statusWords),
    JSON.stringify(priorityWords),
    dayFirst,
  ]);

  const unmapped = preview
    ? [
        ...preview.statusValues.filter((v) => !statusWords[v]),
        ...preview.priorityValues.filter((v) => !priorityWords[v]),
      ]
    : [];

  const canNext =
    (step === 0 &&
      !!file &&
      !!sheet &&
      (!usePattern || /[*?]/.test(pattern))) ||
    (step === 1 && headerRows.length > 0) ||
    (step === 2 && columns.title !== undefined) ||
    (step === 3 && !!preview && unmapped.length === 0) ||
    step === 4;

  const link = async () => {
    if (!file) return;
    setBusy(true);
    const r = await attempt(() =>
      window.worksync.linkFile({
        projectId: project.id,
        file,
        pattern: usePattern ? pattern : null,
        format,
        mainLanguage,
      }),
    );
    setBusy(false);
    if (!r) return;
    await reloadTasks();
    setSources(await window.worksync.listSources());
    toast(
      `Linked ${baseName(file)}. Added ${r.added} task${r.added === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} row${r.skipped === 1 ? '' : 's'}` : ''}.`,
    );
    onLinked();
  };

  const sample = (col: number) => {
    const from = Math.max(...headerRows) + 1;
    return (
      grid
        .slice(from)
        .map((r) => r[col])
        .find(Boolean) ?? ''
    );
  };

  return (
    <Modal
      title={tr('Link a customer file')}
      subtitle={`${project.name} · the file is only ever read, never changed`}
      onClose={onClose}
      footer={
        <>
          <ol className="steps" aria-label={tr('Steps')}>
            {STEPS.map((s, i) => (
              <li
                key={s}
                aria-current={i === step ? 'step' : undefined}
                className={i < step ? 'done' : ''}
              >
                {s}
              </li>
            ))}
          </ol>
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              {tr('Back')}
            </button>
          )}
          {step < 4 ? (
            <button
              className="btn primary"
              disabled={!canNext || busy}
              onClick={() => setStep(step + 1)}
            >
              {tr('Next')}
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={busy || !preview?.rowCount}
              onClick={() => void link()}
            >
              <Icon name="link" />
              {tr('Link and import')} {preview?.rowCount ?? 0} task
              {preview?.rowCount === 1 ? '' : 's'}
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <div className="form">
          <div className="pick-file">
            <button
              className="btn"
              onClick={() => void choose()}
              disabled={busy}
            >
              <Icon name="folder" />
              {file ? tr('Choose another file') : tr('Choose the file')}
            </button>
            <span className="path">
              {file ??
                tr(
                  'An .xlsx, .xlsm, .xls or .csv file, for example in your Box Drive folder.',
                )}
            </span>
          </div>
          {!file && (
            <p className="muted step-help">
              {tr('No customer file yet?')}{' '}
              <button type="button" className="linkbtn" onClick={onClose}>
                {tr('Skip this and add tasks by hand')}
              </button>
              . You can link a file later under Files.
            </p>
          )}
          {info && (
            <>
              <label>
                {tr('Sheet with the tasks')}
                <select
                  className="inp"
                  value={sheet}
                  onChange={(e) => pickSheet(info, e.target.value)}
                >
                  {info.sheets.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name} · {s.rowCount} rows
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>{tr('When the customer saves new versions')}</legend>
                <label className="check">
                  <input
                    type="radio"
                    checked={!usePattern}
                    onChange={() => setUsePattern(false)}
                  />
                  {tr('The file keeps its name. Read this file.')}
                </label>
                <label className="check">
                  <input
                    type="radio"
                    checked={usePattern}
                    onChange={() => setUsePattern(true)}
                  />
                  {tr(
                    'Each version gets a new name. Read the newest file named like',
                  )}
                </label>
                {usePattern && (
                  <input
                    className="inp mono"
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                    placeholder={tr('WBS_*.xlsx')}
                    aria-label={tr('Name pattern')}
                  />
                )}
                {usePattern && (
                  <span className="hint-text">
                    {tr('* stands for any text, such as a date.')}
                  </span>
                )}
              </fieldset>
            </>
          )}
        </div>
      )}

      {step === 1 && (
        <>
          <p className="muted step-help">
            {tr(
              'Click the header row. If the headers span two rows, such as 予定 over 開始 and 終了, Ctrl-click the second row too.',
            )}
          </p>
          <div className="sheet-wrap">
            <table className="sheet">
              <tbody>
                {grid.slice(0, 30).map((r, i) => (
                  <tr
                    key={i}
                    className={
                      headerRows.includes(i)
                        ? 'is-head'
                        : i > Math.max(...headerRows)
                          ? ''
                          : 'above'
                    }
                    onClick={(e) =>
                      toggleHeaderRow(i, e.ctrlKey || e.metaKey || e.shiftKey)
                    }
                  >
                    <th>{i + 1}</th>
                    {r.slice(0, 14).map((c, k) => (
                      <td key={k}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="muted step-help">
            {tr(
              'These matches come from the header text. Change any that are wrong. Columns left unmatched are kept as extra fields.',
            )}
          </p>
          <ColumnMap
            columns={columns}
            setColumns={setColumns}
            headers={headers}
            sample={sample}
          />
          {columns.customerId === undefined && (
            <div className="keepnote">
              <Icon name="alert" />
              <span>
                {tr(
                  'Without an ID column, tasks are matched between versions by their exact title, which can make mistakes when a title changes.',
                )}
              </span>
            </div>
          )}
        </>
      )}

      {step === 3 && (
        <div className="form">
          {!preview && <p className="muted">{tr('Reading the file…')}</p>}
          {preview && preview.statusValues.length > 0 && (
            <fieldset>
              <legend>{tr('What each status word in the file means')}</legend>
              <div className="map-grid">
                {preview.statusValues.map((v) => (
                  <label key={v}>
                    <span lang={mainLanguage}>{v}</span>
                    <select
                      className="inp"
                      value={statusWords[v] ?? ''}
                      onChange={(e) =>
                        setStatusWords({
                          ...statusWords,
                          [v]: e.target.value as Status,
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
              </div>
            </fieldset>
          )}
          {preview && columns.status === undefined && (
            <p className="muted">
              {tr(
                'No status column, so the status comes from the actual dates.',
              )}
            </p>
          )}
          {preview && preview.priorityValues.length > 0 && (
            <fieldset>
              <legend>{tr('What each priority value means')}</legend>
              <div className="map-grid">
                {preview.priorityValues.map((v) => (
                  <label key={v}>
                    <span lang={mainLanguage}>{v}</span>
                    <select
                      className="inp"
                      value={priorityWords[v] ?? ''}
                      onChange={(e) =>
                        setPriorityWords({
                          ...priorityWords,
                          [v]: e.target.value as Level,
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
            </fieldset>
          )}
          {preview && preview.dates.length > 0 && (
            <fieldset>
              <legend>{tr('How the dates were read')}</legend>
              <label className="check" style={{ marginBottom: 8 }}>
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
              <table className="mini">
                <tbody>
                  {preview.dates.map((d) => (
                    <tr key={d.field}>
                      <th>{FIELD_NAMES[d.field as ImportField]}</th>
                      <td>
                        {d.samples.length ? (
                          d.samples.map((s, i) => (
                            <span
                              key={i}
                              className={`dsample ${s.date ? '' : 'bad'}`}
                            >
                              {s.text} →{' '}
                              {s.date
                                ? s.date.replaceAll('-', '/')
                                : tr('not a date')}
                            </span>
                          ))
                        ) : (
                          <span className="muted">{tr('Empty')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </fieldset>
          )}
          <label>
            {tr('Main language of the file')}
            <select
              className="inp"
              value={mainLanguage}
              onChange={(e) => setMainLanguage(e.target.value as LanguageCode)}
            >
              {project.originalLanguages.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGES[l]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {step === 4 && preview && (
        <>
          <label className="form-inline">
            {tr('Name of this file format')}
            <input
              className="inp"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p className="muted step-help">
            {preview.rowCount} task{preview.rowCount === 1 ? '' : 's'}{' '}
            {tr('will be added. The first')} {Math.min(20, preview.rowCount)}{' '}
            {tr('are shown as they will appear.')}
          </p>
          <div className="sheet-wrap">
            <table className="sheet preview">
              <thead>
                <tr>
                  <th>{tr('Row')}</th>
                  <th>{tr('ID')}</th>
                  <th>{tr('Title')}</th>
                  <th>{tr('Status')}</th>
                  <th>{tr('Priority')}</th>
                  <th>{tr('Planned')}</th>
                  <th>{tr('Assignee')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row}>
                    <th>{r.row}</th>
                    <td className="mono">{r.customerId}</td>
                    <td lang={mainLanguage}>{r.title}</td>
                    <td>
                      {r.status}
                      {r.statusWord && (
                        <span className="muted"> · {r.statusWord}</span>
                      )}
                    </td>
                    <td>{tr(LEVEL_NAME[r.priority])}</td>
                    <td className="mono">
                      {(r.plannedStart ?? '').replaceAll('-', '/')} →{' '}
                      {(r.plannedEnd ?? '').replaceAll('-', '/')}
                    </td>
                    <td>{r.assignee}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.skipped.length > 0 && (
            <details className="skipped">
              <summary>
                {preview.skipped.length} row
                {preview.skipped.length === 1 ? '' : 's'}{' '}
                {tr('skipped, such as blank rows, totals and section titles')}
              </summary>
              <ul>
                {preview.skipped.slice(0, 50).map((s) => (
                  <li key={s.row}>
                    <span className="mono">
                      {tr('Row')} {s.row}
                    </span>{' '}
                    · {s.reason} ·{' '}
                    <span lang={mainLanguage}>{s.text.slice(0, 80)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Which column holds each field. A column serves one field, except that the
 * title may be the ID column, for files where tasks are called by their ID.
 */
export function ColumnMap({
  columns,
  setColumns,
  headers,
  sample,
}: {
  columns: ColumnMapping;
  setColumns: (c: ColumnMapping) => void;
  headers: string[];
  sample: (col: number) => string;
}) {
  return (
    <>
      <div className="map-grid">
        {IMPORT_FIELDS.map((f: ImportField) => (
          <label key={f}>
            {FIELD_NAMES[f]}
            {f === 'title' && <span className="hint"> {tr('· required')}</span>}
            <select
              className="inp"
              value={columns[f] ?? ''}
              onChange={(e) =>
                setColumns({
                  ...columns,
                  [f]:
                    e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            >
              <option value="">{tr('Not in this file')}</option>
              {headers.map((h, i) => (
                <option key={i} value={i} disabled={!columnFree(columns, f, i)}>
                  {columnLetter(i)} · {h || tr('(no header)')}
                  {f === 'title' && columns.customerId === i
                    ? tr(' (the ID)')
                    : ''}
                  {sample(i) ? ` — ${String(sample(i)).slice(0, 24)}` : ''}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {columns.customerId !== undefined &&
        columns.title !== columns.customerId && (
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              setColumns({ ...columns, title: columns.customerId })
            }
            title={tr(
              'Tasks are shown and found by their ID, as you call them in meetings',
            )}
          >
            {tr('Use the ID as the title')}
          </button>
        )}
      {columns.customerId !== undefined &&
        columns.title === columns.customerId && (
          <p className="muted step-help">
            {tr(
              'The title is the ID. Tasks show and are found by their ID; the other columns are kept as fields from the file.',
            )}
          </p>
        )}
    </>
  );
}
