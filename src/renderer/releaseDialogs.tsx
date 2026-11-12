import { useEffect, useState } from 'react';
import type { ReleaseExportOptions, ReleaseTemplateInfo } from '../shared/ipc';
import { aiInstructions, IMPORT_COLUMNS } from '../shared/releaseFormat';
import type {
  ReleaseImportPlan,
  ReleaseImportRelease,
} from '../shared/releaseImportTypes';
import { sheetDate, type ReleaseLists } from '../shared/releases';
import { useApp } from './appState';
import { tr, uiLanguage } from './i18n';
import { Icon } from './Icon';
import { confirmDelete, Modal } from './parts';

type Mode = 'skip' | 'update' | 'replace';

const PROBLEM: Record<string, string> = {
  date: 'Row {row}: “{value}” is not a date.',
  noProduct: 'Row {row}: no product.',
  noVersion: 'Row {row}: no release version.',
  noDate: 'Row {row}: a released version needs its release date.',
  noFile: 'Row {row}: no file name or module.',
  tooMany: 'Only the first {value} rows are read.',
};

const fileName = (s: string) => s.split(/[\\/]/).pop() ?? s;

/** A release column's name as the release sheets write it, in the app's language. */
export const colName = (key: string) => {
  const c = IMPORT_COLUMNS.find((x) => x.key === key);
  return c ? (uiLanguage() === 'ja' ? c.ja : c.en) : key;
};
/** “New” as an import result: a release added, not a new feature. */
const newWord = () => (uiLanguage() === 'ja' ? '追加' : 'New');

/**
 * Releases from an Excel sheet in the import format (or the app's own
 * export): the file, the columns found, and a preview of what is added and
 * changed, before anything is saved.
 */
export function ReleaseImportDialog({
  projectId,
  count,
  lists,
  japanese,
  onClose,
  onImported,
}: {
  projectId: string;
  /** How many releases the project has now. */
  count: number;
  lists: ReleaseLists;
  japanese: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { attempt, toast } = useApp();
  const [plan, setPlan] = useState<ReleaseImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<Mode>('update');
  const [fields, setFields] = useState<Record<string, boolean>>({});

  const choose = async () => {
    setBusy(true);
    const p = await attempt(() =>
      window.worksync.previewReleaseImport(projectId),
    );
    setBusy(false);
    if (!p) return;
    setPlan(p);
    setFields(Object.fromEntries(p.unknown.map((u) => [u.key, true])));
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(aiInstructions());
      setCopied(true);
    } catch {
      toast(tr('The instructions could not be copied.'));
    }
  };
  const emptySheet = async () => {
    const r = await attempt(() =>
      window.worksync.saveReleaseImportSheet(japanese ? 'ja' : 'en'),
    );
    if (r) toast(tr('Saved {file}.', { file: fileName(r.file) }));
  };

  const matched = plan?.releases.filter((r) => r.match) ?? [];
  const outcome = (r: ReleaseImportRelease): 'new' | 'update' | 'skip' =>
    mode === 'replace' || !r.match
      ? 'new'
      : mode === 'update'
        ? 'update'
        : 'skip';
  const shown = plan?.releases ?? [];
  const adding = shown.filter((r) => outcome(r) === 'new');
  const updating = shown.filter((r) => outcome(r) === 'update');
  const files = (list: ReleaseImportRelease[]) =>
    list.reduce((n, r) => n + r.files.length, 0);
  const total = adding.length + updating.length;

  const go = async () => {
    if (!plan) return;
    if (
      mode === 'replace' &&
      count > 0 &&
      !(await confirmDelete({
        title: tr('Replace all {n} releases?', { n: count }),
        text: tr(
          'The releases now in this project are removed, then the file is imported. A backup is made first.',
        ),
        yes: tr('Replace all'),
      }))
    )
      return;
    setBusy(true);
    const r = await attempt(() =>
      window.worksync.applyReleaseImport(projectId, {
        mode,
        fields: plan.unknown
          .filter((u) => !u.known && fields[u.key])
          .map((u) => u.key),
      }),
    );
    setBusy(false);
    if (!r) return;
    toast(
      tr('Imported the releases: {a} added, {u} updated, {s} skipped.', {
        a: r.added,
        u: r.updated,
        s: r.skipped,
      }),
    );
    onImported();
  };

  const firstText = (r: ReleaseImportRelease) =>
    [
      r.changes,
      r.purpose,
      r.verification,
      ...r.files.flatMap((f) => [f.changes, f.purpose, f.verification]),
    ].find(Boolean) ?? '';

  return (
    <Modal
      title={tr('Import releases from Excel')}
      subtitle={tr(
        'One row per released file. Nothing is saved until you import.',
      )}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted rl-foot-note">
            {tr(
              'New products, destinations and environments join the project lists. A backup is made before importing.',
            )}
          </span>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!plan || busy || (!total && mode !== 'replace')}
            onClick={() => void go()}
          >
            <Icon name="upload" />
            {busy
              ? tr('Importing…')
              : tr(total === 1 ? 'Import 1 release' : 'Import {n} releases', {
                  n: total,
                })}
          </button>
        </>
      }
    >
      <div className="form rl-imp">
        <section className="rl-step">
          <h3>{tr('1 · The file')}</h3>
          <div className="rl-filebox">
            <Icon name="file" />
            <div className="t">
              {plan ? (
                <>
                  <b>{plan.fileName}</b>
                  <span className="muted">
                    {tr(
                      plan.ownExport
                        ? 'Sheet “{sheet}” · {n} rows · WorkSync’s own export'
                        : 'Sheet “{sheet}” · {n} rows · import format found',
                      { sheet: plan.sheet, n: plan.rows },
                    )}
                  </span>
                </>
              ) : (
                <span className="muted">
                  {tr(
                    'An .xlsx file with the headings of the import format, or a release workbook WorkSync exported.',
                  )}
                </span>
              )}
            </div>
            <button
              className={`btn ${plan ? '' : 'primary'}`}
              disabled={busy}
              onClick={() => void choose()}
            >
              {plan ? tr('Choose another file…') : tr('Choose a file…')}
            </button>
          </div>
          <div className="rl-helprow">
            <span className="muted">{tr('Converting a customer sheet?')}</span>
            <button
              className={`btn sm ${copied ? 'on' : ''}`}
              onClick={() => void copy()}
            >
              <Icon name={copied ? 'check' : 'copy'} />
              {copied
                ? tr('Copied: paste it into the AI with the sheet')
                : tr('Copy instructions for AI')}
            </button>
            <button className="btn sm" onClick={() => void emptySheet()}>
              <Icon name="download" />
              {tr('Save an empty import sheet')}
            </button>
          </div>
        </section>

        {plan && (
          <>
            <section className="rl-step">
              <h3>{tr('2 · Columns found')}</h3>
              <div className="rl-cols">
                {plan.columns.map((c) => (
                  <span key={c} className="rl-col">
                    <Icon name="check" />
                    {colName(c)}
                  </span>
                ))}
              </div>
              {plan.unknown.map((u) => (
                <div key={u.key} className="rl-unknown">
                  {u.known ? (
                    <span>
                      {tr('Column {name} fills the file field {field}.', {
                        name: u.name,
                        field:
                          lists.fields.find((f) => f.key === u.key)?.name ??
                          u.name,
                      })}
                    </span>
                  ) : (
                    <>
                      <span>
                        {tr('Unknown column')} <b className="mono">{u.name}</b>
                      </span>
                      <span style={{ flex: 1 }} />
                      <div className="seg-ctl" role="group" aria-label={u.name}>
                        <button
                          aria-pressed={!!fields[u.key]}
                          onClick={() =>
                            setFields((f) => ({ ...f, [u.key]: true }))
                          }
                        >
                          {tr('Add as a file field')}
                        </button>
                        <button
                          aria-pressed={!fields[u.key]}
                          onClick={() =>
                            setFields((f) => ({ ...f, [u.key]: false }))
                          }
                        >
                          {tr('Ignore')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </section>

            <section className="rl-step">
              <h3>{tr('3 · Preview: nothing is saved yet')}</h3>
              <div className="rl-tiles">
                <div className="rl-tile">
                  <span className="muted">{newWord()}</span>
                  <b className="ok">
                    {tr(adding.length === 1 ? '1 release' : '{n} releases', {
                      n: adding.length,
                    })}
                  </b>
                  <span className="muted">
                    {tr(files(adding) === 1 ? '1 file' : '{n} files', {
                      n: files(adding),
                    })}
                  </span>
                </div>
                <div className="rl-tile">
                  <span className="muted">{tr('Already in the project')}</span>
                  <b className="info">
                    {tr(matched.length === 1 ? '1 release' : '{n} releases', {
                      n: matched.length,
                    })}
                  </b>
                  <span className="muted">
                    {matched
                      .slice(0, 2)
                      .map((r) => `${r.product} ${r.version}`)
                      .join(', ')}
                    {matched.length > 2 ? '…' : ''}
                  </span>
                </div>
                <div className="rl-tile">
                  <span className="muted">{tr('Skipped rows')}</span>
                  <b className={plan.problems.length ? 'bad' : ''}>
                    {tr(plan.problems.length === 1 ? '1 row' : '{n} rows', {
                      n: plan.problems.length,
                    })}
                  </b>
                  <span className="muted">
                    {plan.problems.length
                      ? tr('See the problems below')
                      : tr('Every row can be read')}
                  </span>
                </div>
              </div>

              {plan.merged > 0 && (
                <div className="rl-merged">
                  <Icon name="swap" />
                  <span>
                    {tr(
                      plan.merged === 1
                        ? '1 row repeated a file already in the same release (as when two sheets are put together). It is merged into one file; where the texts differ, both are kept.'
                        : '{n} rows repeated a file already in the same release (as when two sheets are put together). Each is merged into one file; where the texts differ, both are kept.',
                      { n: plan.merged },
                    )}
                  </span>
                </div>
              )}
              {(matched.length > 0 || count > 0) && (
                <div className="rl-helprow">
                  <span>{tr('Releases already in the project:')}</span>
                  <div className="seg-ctl" role="group">
                    {(
                      [
                        ['skip', 'Skip'],
                        ['update', 'Update'],
                        ['replace', 'Replace all'],
                      ] as [Mode, string][]
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        aria-pressed={mode === k}
                        onClick={() => setMode(k)}
                      >
                        {tr(label)}
                      </button>
                    ))}
                  </div>
                  <span className="muted">
                    {tr(
                      mode === 'skip'
                        ? 'Keep what the project has; the file’s rows for them are left out.'
                        : mode === 'update'
                          ? 'Same product, version and date: filled in and changed from the file.'
                          : 'Start again from the file.',
                    )}
                  </span>
                </div>
              )}
              {mode === 'replace' && count > 0 && (
                <div className="rl-warn" role="alert">
                  {tr(
                    'All {n} releases now in this project are removed first, then the file is imported. A backup is made before importing.',
                    { n: count },
                  )}
                </div>
              )}

              {shown.length > 0 ? (
                <div className="rl-scroll">
                  <table className="rl-table">
                    <thead>
                      <tr>
                        <th>{tr('Result')}</th>
                        <th>{tr('Release date')}</th>
                        <th>{tr('Release')}</th>
                        <th>{tr('Files')}</th>
                        <th>{tr('Change log · Purpose · Verification')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...shown].reverse().map((r) => {
                        const o = outcome(r);
                        const t = firstText(r);
                        return (
                          <tr key={r.key}>
                            <td>
                              <span className={`rl-badge ${o}`}>
                                {o === 'new'
                                  ? newWord()
                                  : tr(o === 'update' ? 'Update' : 'Skip')}
                              </span>
                            </td>
                            <td className="mono">
                              {r.releasedOn
                                ? sheetDate(r.releasedOn)
                                : tr('Planned')}
                            </td>
                            <td>
                              <b>
                                {r.product} {r.version}
                              </b>
                              {r.target && (
                                <div className="muted">{r.target}</div>
                              )}
                            </td>
                            <td className="mono rl-pre">
                              {r.files.length
                                ? r.files
                                    .slice(0, 4)
                                    .map(
                                      (f) =>
                                        `${f.fileName || f.module}  ${f.version}`,
                                    )
                                    .join('\n') +
                                  (r.files.length > 4
                                    ? `\n${tr('and {n} more', { n: r.files.length - 4 })}`
                                    : '')
                                : '—'}
                            </td>
                            <td className={t ? 'rl-text' : 'muted'}>
                              {t ? (
                                <div className="rl-clip">{t}</div>
                              ) : (
                                tr('No info')
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">
                  {tr('The file has no release to import.')}
                </p>
              )}

              {plan.problems.length > 0 && (
                <div className="rl-problems">
                  <b>{tr('Problems: these rows are left out')}</b>
                  {plan.problems.slice(0, 20).map((p) => (
                    <span key={`${p.row}-${p.code}`}>
                      {tr(PROBLEM[p.code] ?? p.code, {
                        row: p.row,
                        value: p.value,
                      })}
                    </span>
                  ))}
                  {plan.problems.length > 20 && (
                    <span className="muted">
                      {tr('and {n} more', { n: plan.problems.length - 20 })}
                    </span>
                  )}
                  <span className="muted">
                    {tr(
                      'Fix them in the file and choose it again, or import now without them.',
                    )}
                  </span>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

const MARKERS: [string, string][] = [
  [
    '{{project.customer}}  {{project.name}}  {{today}}',
    'The customer, the project, today',
  ],
  [
    '{{#releases}} … {{/releases}}',
    'Repeats the row once per release, oldest first, keeping its style',
  ],
  [
    '{{#files}} … {{/files}}',
    'Repeats the row once per file; inside a release block, that release’s files',
  ],
  ['{{#latest}} … {{/latest}}', 'Each module’s newest version'],
  [
    '{{release.date}}  {{release.version}}  {{release.summary}}',
    'Release fields (also product, edition, purpose, changes, verification, no)',
  ],
  [
    '{{file.name}}  {{file.version}}  {{file.previous}}  {{file.changes}}',
    'File fields (also module, environment, destination, category, purpose, verification)',
  ],
  ['{{matrix}}', 'The whole version table, with one column per release date'],
  ['{{product}}', 'In a sheet name: one sheet per product'],
];

/** Exporting the releases: Excel (built-in layout or the project's template) and or an HTML page. */
export function ReleaseExportDialog({
  projectId,
  projectName,
  customer,
  lists,
  japanese,
  onClose,
}: {
  projectId: string;
  projectName: string;
  customer: string;
  lists: ReleaseLists;
  japanese: boolean;
  onClose: () => void;
}) {
  const { attempt, toast, today } = useApp();
  const [o, setO] = useState<ReleaseExportOptions>({
    excel: true,
    html: false,
    language: japanese ? 'ja' : 'en',
    template: 'builtin',
    includePlanned: false,
    onlyChanged: false,
    theme: 'light',
  });
  const [template, setTemplate] = useState<ReleaseTemplateInfo | null>(null);
  const [markers, setMarkers] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ReleaseExportOptions>(
    k: K,
    v: ReleaseExportOptions[K],
  ) => setO((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    void attempt(() => window.worksync.getReleaseTemplate(projectId)).then(
      (t) => {
        if (t) {
          setTemplate(t);
          set('template', 'project');
        }
      },
    );
    // Once, for this project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const choose = async () => {
    const t = await attempt(() =>
      window.worksync.chooseReleaseTemplate(projectId),
    );
    if (!t) return;
    setTemplate(t);
    set('template', 'project');
    const missing = t.fields.filter(
      (k) => !lists.fields.some((f) => f.key === k),
    );
    toast(
      missing.length
        ? tr(
            'Template kept. It uses fields the project does not have: {list}.',
            {
              list: missing.join(', '),
            },
          )
        : tr('Template kept with the project: {name}.', { name: t.name }),
    );
  };
  const removeTemplate = async () => {
    if (
      !template ||
      !(await confirmDelete({
        title: tr('Remove the template {name}?', { name: template.name }),
        text: tr(
          'The export goes back to the built-in layout. The file you chose is not touched.',
        ),
        yes: tr('Remove'),
      }))
    )
      return;
    if (
      (await attempt(() => window.worksync.clearReleaseTemplate(projectId))) !==
      null
    ) {
      setTemplate(null);
      set('template', 'builtin');
    }
  };
  const saveDefault = async () => {
    const r = await attempt(() =>
      window.worksync.saveDefaultReleaseTemplate(projectId, o.language),
    );
    if (r)
      toast(
        tr('Saved {file}. Edit it in Excel, then choose it here.', {
          file: fileName(r.file),
        }),
      );
  };
  const go = async () => {
    setBusy(true);
    const r = await attempt(() => window.worksync.exportReleases(projectId, o));
    setBusy(false);
    if (!r) return;
    toast(tr('Saved {file}.', { file: r.files.map(fileName).join(', ') }));
    if (r.unknown.length)
      toast(
        tr(
          'The template has markers WorkSync does not know, left empty: {list}.',
          {
            list: r.unknown.map((u) => `{{${u}}}`).join(', '),
          },
        ),
      );
    onClose();
  };

  const base = `${
    projectName
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Project'
  } ${o.language === 'ja' ? 'リリース一覧' : 'releases'} ${today}`;
  const names = [o.excel && `${base}.xlsx`, o.html && `${base}.html`].filter(
    Boolean,
  );
  const check = (
    on: boolean,
    toggle: () => void,
    label: string,
    desc?: string,
  ) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      className={`rl-check ${on ? 'on' : ''} ${desc ? 'card' : ''}`}
      onClick={toggle}
    >
      <span className="box" aria-hidden="true">
        {on && <Icon name="check" />}
      </span>
      <span className="t">
        <b>{label}</b>
        {desc && <span className="muted">{desc}</span>}
      </span>
    </button>
  );
  const dark = o.theme === 'dark';

  return (
    <Modal
      title={tr('Export the releases')}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted mono rl-foot-note">
            {names.join('   ·   ')}
          </span>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn primary"
            disabled={busy || !names.length}
            onClick={() => void go()}
          >
            <Icon name="download" />
            {busy
              ? tr('Saving…')
              : names.length === 2
                ? tr('Export both')
                : tr('Export…')}
          </button>
        </>
      }
    >
      <div className="rl-exp">
        <div className="rl-exp-side">
          <section className="rl-step">
            <h3>{tr('Files to make')}</h3>
            {check(
              o.excel,
              () => set('excel', !o.excel),
              tr('Excel workbook'),
              tr(
                'For the customer: version table, module list, history per product',
              ),
            )}
            {check(
              o.html,
              () => set('html', !o.html),
              tr('HTML page'),
              tr('The timeline in one file you can send or open anywhere'),
            )}
          </section>
          <section className="rl-step">
            <h3>{tr('Headings')}</h3>
            <div className="seg-ctl" role="group" aria-label={tr('Headings')}>
              <button
                aria-pressed={o.language === 'ja'}
                onClick={() => set('language', 'ja')}
              >
                日本語
              </button>
              <button
                aria-pressed={o.language === 'en'}
                onClick={() => set('language', 'en')}
              >
                English
              </button>
            </div>
            <span className="muted step-help">
              {tr(
                'Your text is written as you typed it; only headings change.',
              )}
            </span>
          </section>
          <section className="rl-step">
            <h3>{tr('What to include')}</h3>
            {check(
              o.includePlanned,
              () => set('includePlanned', !o.includePlanned),
              tr('Include planned releases'),
            )}
            {check(
              o.onlyChanged,
              () => set('onlyChanged', !o.onlyChanged),
              tr('In the version table, only versions released that day'),
            )}
          </section>
        </div>

        <div className="rl-exp-main">
          {o.excel && (
            <section className="rl-step rl-panel">
              <h3>{tr('Excel layout')}</h3>
              {(
                [
                  [
                    'builtin',
                    tr('Built-in layout'),
                    tr(
                      'Module versions · Release modules · Release history per product',
                    ),
                  ],
                  [
                    'project',
                    template
                      ? tr('This project’s template: {name}', {
                          name: template.name,
                        })
                      : tr('This project’s template'),
                    template
                      ? tr('Chosen {date} · {n} sheets', {
                          date: sheetDate(template.chosenAt.slice(0, 10)),
                          n: template.sheets,
                        })
                      : tr(
                          'None yet: save the default template, edit it in Excel, then choose it.',
                        ),
                  ],
                ] as ['builtin' | 'project', string, string][]
              ).map(([k, label, desc]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={o.template === k}
                  disabled={k === 'project' && !template}
                  className={`rl-check card radio ${o.template === k ? 'on' : ''}`}
                  onClick={() => set('template', k)}
                >
                  <span className="box" aria-hidden="true" />
                  <span className="t">
                    <b>{label}</b>
                    <span className="muted">{desc}</span>
                  </span>
                </button>
              ))}
              <div className="rl-helprow">
                <button className="btn sm" onClick={() => void saveDefault()}>
                  <Icon name="download" />
                  {tr('Save the default template…')}
                </button>
                <button className="btn sm" onClick={() => void choose()}>
                  <Icon name="upload" />
                  {template
                    ? tr('Choose another template…')
                    : tr('Choose a template…')}
                </button>
                {template && (
                  <button
                    className="btn sm"
                    onClick={() => void removeTemplate()}
                  >
                    <Icon name="trash" />
                    {tr('Remove the template')}
                  </button>
                )}
                <button
                  className="btn sm ghost"
                  aria-expanded={markers}
                  onClick={() => setMarkers(!markers)}
                >
                  {markers ? tr('Hide the markers') : tr('Show the markers')}
                </button>
              </div>
              {markers && (
                <div className="rl-scroll">
                  <table className="rl-table">
                    <thead>
                      <tr>
                        <th>{tr('Write in a cell')}</th>
                        <th>{tr('The export puts there')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {MARKERS.map(([k, v]) => (
                        <tr key={k}>
                          <td className="mono rl-mark">{k}</td>
                          <td>{tr(v)}</td>
                        </tr>
                      ))}
                      {lists.fields.map((f) => (
                        <tr key={f.key}>
                          <td className="mono rl-mark">{`{{file.${f.key}}}`}</td>
                          <td>
                            {tr('The file field {name}', { name: f.name })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {o.html && (
            <section className="rl-step rl-panel">
              <h3>{tr('HTML page')}</h3>
              <div className="rl-helprow">
                <span>{tr('Look')}</span>
                <div className="seg-ctl" role="group" aria-label={tr('Look')}>
                  {(
                    [
                      ['light', 'Light'],
                      ['dark', 'Dark'],
                      ['auto', 'Follows the viewer'],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      aria-pressed={o.theme === k}
                      onClick={() => set('theme', k)}
                    >
                      {tr(label)}
                    </button>
                  ))}
                </div>
              </div>
              <div
                className={`rl-hprev ${dark ? 'dark' : ''}`}
                aria-hidden="true"
              >
                <div className="top">
                  <b>
                    {projectName} —{' '}
                    {o.language === 'ja' ? 'リリース' : 'Releases'}
                  </b>
                  <span>
                    {customer &&
                      `${o.language === 'ja' ? '顧客' : 'Customer'}: ${customer} · `}
                    {sheetDate(today)}
                  </span>
                </div>
                <div className="ms">
                  <span className="d mono">2026/08/21</span>
                  <span className="dot" />
                  <div className="c">
                    <b>EMVCon 5.5.0 · 3 files</b>
                    <span className="mono">
                      FakeFile_21.dll · 7300_100200 ▾
                    </span>
                    <span>
                      {o.language === 'ja' ? '内容' : 'Change log'}: Added the
                      new payment terminal.
                    </span>
                  </div>
                </div>
              </div>
              <span className="muted step-help">
                {tr(
                  'One file that opens in Edge or Chrome, offline and read-only. It has Expand all and Collapse all; printing shows every file opened, on white.',
                )}
              </span>
            </section>
          )}

          {!o.excel && !o.html && (
            <div className="rl-noinfo">{tr('Choose Excel, HTML or both.')}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
