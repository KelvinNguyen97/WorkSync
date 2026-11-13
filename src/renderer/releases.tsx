import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  byDate,
  EMPTY_MODULE,
  fieldKey,
  fileInfo,
  latestModules,
  moduleName,
  previousVersion,
  productsOf,
  sheetDate,
  versionMatrix,
  type Release,
  type ReleaseInput,
  type ReleaseLists,
  type ReleaseModule,
} from '../shared/releases';
import {
  colName,
  ReleaseExportDialog,
  ReleaseImportDialog,
} from './releaseDialogs';
import { useApp } from './appState';
import { Icon } from './Icon';
import { confirmDelete, Modal } from './parts';
import type { ViewProps } from './views';
import { tr } from './i18n';

type Tab = 'timeline' | 'versions' | 'modules';
type NameList = Exclude<keyof ReleaseLists, 'fields'>;

const LIST_NAMES: Record<NameList, string> = {
  products: 'Products',
  editions: 'Editions and types',
  destinations: 'Destinations',
  categories: 'Categories',
  environments: 'Environments',
};

/**
 * Releases: the software a project delivers, per product. The history of
 * each product's releases, the version of every module on each release date,
 * and the newest version of each module, as the release sheets show them.
 */
export function ReleasesView({
  projectId,
  props,
}: {
  projectId: string;
  props: ViewProps;
}) {
  const { project, attempt } = useApp();
  const p = project(projectId)!;
  const [list, setList] = useState<Release[] | null>(null);
  const [lists, setLists] = useState<ReleaseLists | null>(null);
  const [tab, setTab] = useState<Tab>('timeline');
  const [product, setProduct] = useState('');
  const [editing, setEditing] = useState<Release | 'new' | null>(null);
  const [listsOpen, setListsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const load = async () => {
    const [r, l] = await Promise.all([
      attempt(() => window.worksync.listReleases(projectId)),
      attempt(() => window.worksync.getReleaseLists(projectId)),
    ]);
    if (r) setList(r);
    if (l) setLists(l);
  };
  useEffect(() => {
    setList(null);
    setProduct('');
    void load();
    // A new project's releases.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const all = list ?? [];
  const products = lists ? productsOf(all, lists) : [];
  const q = props.query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      all.filter(
        (r) =>
          (!product || r.product === product) &&
          (!q ||
            [
              r.product,
              r.target,
              r.version,
              r.summary,
              r.purpose,
              r.changes,
              r.verification,
              ...r.modules.flatMap((m) => [
                m.module,
                m.fileName,
                m.version,
                m.changes,
                m.purpose,
                m.verification,
                ...Object.values(m.extra),
              ]),
            ]
              .join('\n')
              .toLowerCase()
              .includes(q)),
      ),
    [all, product, q],
  );
  const newestFirst = [...byDate(shown)].reverse();
  const matrix = lists ? versionMatrix(shown, lists) : null;
  const latest = lists ? latestModules(shown, lists) : [];

  return (
    <>
      {props.header(
        tr('Releases'),
        tr(
          '{name} · what was released, when, and which version of each module',
          {
            name: p.name,
          },
        ),
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setListsOpen(true)}>
            <Icon name="sliders" />
            <span className="lbl">{tr('Lists')}</span>
          </button>
          <button className="btn" onClick={() => setImportOpen(true)}>
            <Icon name="upload" />
            <span className="lbl">{tr('Import from Excel')}</span>
          </button>
          <button
            className="btn"
            disabled={!all.length}
            onClick={() => setExportOpen(true)}
          >
            <Icon name="download" />
            <span className="lbl">{tr('Export')}</span>
          </button>
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" />
            <span className="lbl">{tr('New release')}</span>
          </button>
        </div>,
      )}
      <div className="rl">
        <div className="rl-bar">
          <div className="seg-ctl" role="group" aria-label={tr('Releases')}>
            {(
              [
                ['timeline', 'Timeline'],
                ['versions', 'Versions'],
                ['modules', 'Modules'],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                aria-pressed={tab === k}
                onClick={() => setTab(k)}
              >
                {tr(label)}
              </button>
            ))}
          </div>
          {products.length > 1 && (
            <div className="rl-products" aria-label={tr('Product')}>
              <button
                className={`chip-btn ${product ? '' : 'on'}`}
                onClick={() => setProduct('')}
              >
                {tr('All products')} <b>{all.length}</b>
              </button>
              {products.map((x) => (
                <button
                  key={x}
                  className={`chip-btn ${product === x ? 'on' : ''}`}
                  onClick={() => setProduct(product === x ? '' : x)}
                >
                  {x} <b>{all.filter((r) => r.product === x).length}</b>
                </button>
              ))}
            </div>
          )}
        </div>

        {list === null ? (
          <p className="muted rl-empty">{tr('Loading…')}</p>
        ) : !all.length ? (
          <div className="rl-empty">
            <h2>{tr('No releases yet')}</h2>
            <p className="muted">
              {tr(
                'Add each release with its date, version and the files it delivers, or import them from an Excel sheet. The export then gives the module version list and the release history in the usual layout, or a page to send.',
              )}
            </p>
            <div className="rl-empty-btns">
              <button className="btn primary" onClick={() => setEditing('new')}>
                <Icon name="plus" />
                {tr('Add the first release')}
              </button>
              <button className="btn" onClick={() => setImportOpen(true)}>
                <Icon name="upload" />
                {tr('Import from Excel')}
              </button>
            </div>
          </div>
        ) : tab === 'timeline' ? (
          <Timeline
            list={newestFirst}
            all={all}
            lists={lists}
            onEdit={setEditing}
          />
        ) : tab === 'versions' ? (
          matrix && matrix.rows.length ? (
            <div className="rl-scroll">
              <table className="rl-table matrix">
                <thead>
                  <tr>
                    <th>{colName('destination')}</th>
                    <th>{colName('category')}</th>
                    <th>{tr('Module')}</th>
                    <th>{tr('Environment')}</th>
                    {matrix.dates.map((d) => (
                      <th key={d} className="mono">
                        {sheetDate(d)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((r, i) => {
                    // As in the sheet: a destination, and a category in it, once per group.
                    const prev = matrix.rows[i - 1];
                    const sameDest =
                      !!prev && prev.destination === r.destination;
                    const sameCat = sameDest && prev.category === r.category;
                    return (
                      <tr key={i} className={sameDest ? 'cont' : 'first'}>
                        <td>
                          <b>{sameDest ? '' : r.destination}</b>
                        </td>
                        <td>{sameCat ? '' : r.category}</td>
                        <td>
                          {r.module || <i className="muted">{tr('No info')}</i>}
                        </td>
                        <td>{r.environment}</td>
                        {r.versions.map((v, k) => (
                          <td
                            key={k}
                            className={`mono ${r.changed[k] ? 'new' : 'same'}`}
                            title={
                              r.changed[k]
                                ? tr('Released on this date')
                                : undefined
                            }
                          >
                            {v}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted rl-note">
                {tr(
                  'Each cell is the version in use on that date. Highlighted: released that day; the others carry on from before.',
                )}
              </p>
            </div>
          ) : (
            <p className="muted rl-empty">
              {tr(
                'No released modules yet: add modules to a release with a date.',
              )}
            </p>
          )
        ) : latest.length ? (
          <div className="rl-scroll">
            <table className="rl-table">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>{tr('Type')}</th>
                  <th>{tr('Module / file name')}</th>
                  <th>{tr('Release date')}</th>
                  <th>{tr('Version')}</th>
                  <th>{tr('Environment')}</th>
                  <th>{tr('Product')}</th>
                </tr>
              </thead>
              <tbody>
                {latest.map((m, i) => (
                  <tr key={i}>
                    <td className="mono">{i + 1}</td>
                    <td>{m.type}</td>
                    <td>
                      {m.module || <i className="muted">{tr('No info')}</i>}
                    </td>
                    <td className="mono">{sheetDate(m.releasedOn)}</td>
                    <td className="mono">
                      <b>{m.version}</b>
                    </td>
                    <td>{m.environment}</td>
                    <td className="muted">{m.product}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted rl-empty">
            {tr(
              'No released modules yet: add modules to a release with a date.',
            )}
          </p>
        )}
      </div>

      {editing && lists && (
        <ReleaseEditor
          projectId={projectId}
          release={editing === 'new' ? null : editing}
          all={all}
          lists={lists}
          defaultProduct={product}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {listsOpen && lists && (
        <ListsDialog
          projectId={projectId}
          lists={lists}
          onSaved={setLists}
          onClose={() => setListsOpen(false)}
        />
      )}
      {exportOpen && lists && (
        <ReleaseExportDialog
          projectId={projectId}
          projectName={p.name}
          customer={p.customer}
          lists={lists}
          japanese={(p.originalLanguages[0] ?? 'ja') === 'ja'}
          onClose={() => setExportOpen(false)}
        />
      )}
      {importOpen && lists && (
        <ReleaseImportDialog
          projectId={projectId}
          count={all.length}
          lists={lists}
          japanese={(p.originalLanguages[0] ?? 'ja') === 'ja'}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            void load();
          }}
        />
      )}
    </>
  );
}

/** The releases as milestones, newest first; a file opens to what changed. */
function Timeline({
  list,
  all,
  lists,
  onEdit,
}: {
  list: Release[];
  all: Release[];
  lists: ReleaseLists | null;
  onEdit: (r: Release) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { today } = useApp();
  const ago = (d: string) => {
    const days = Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
    if (days === 0) return tr('Today');
    if (days < 0) return tr('In {n} days', { n: -days });
    if (days < 14)
      return tr(days === 1 ? '1 day ago' : '{n} days ago', { n: days });
    if (days < 70) return tr('{n} weeks ago', { n: Math.round(days / 7) });
    if (days < 730) return tr('{n} months ago', { n: Math.round(days / 30.4) });
    return tr('{n} years ago', { n: Math.round(days / 365) });
  };
  const box = (label: string, text: string, fromRelease: boolean) => (
    <div className="rl-box">
      <span className="k">
        {tr(label)}
        {text && fromRelease && <i>{tr('(from the release)')}</i>}
      </span>
      <span className={text ? 'v' : 'v none'}>{text || tr('No info')}</span>
    </div>
  );
  if (!list.length)
    return <p className="muted rl-empty">{tr('No release matches.')}</p>;
  return (
    <ol className="rl-tl">
      {list.map((r) => {
        const planned = r.status === 'planned';
        const ownText = !!(r.purpose || r.changes || r.verification);
        return (
          <li key={r.id} className={`rl-ms ${planned ? 'planned' : ''}`}>
            <div className="rl-when">
              <b className={planned ? 'p' : 'mono'}>
                {planned ? tr('Planned') : sheetDate(r.releasedOn)}
              </b>
              {!planned && r.releasedOn && (
                <span className="muted">{ago(r.releasedOn)}</span>
              )}
            </div>
            <div className="rl-rail" aria-hidden="true">
              <span className="dot" />
            </div>
            <section className="rl-card">
              <div className="rl-card-head">
                <span className="rl-pill">{r.product}</span>
                <h2 className="mono">{r.version}</h2>
                {r.target && <span className="muted">{r.target}</span>}
                <span className="rl-date-sm mono muted">
                  {planned ? tr('Planned') : sheetDate(r.releasedOn)}
                </span>
                {planned && (
                  <span className="rl-pill planned">{tr('Planned')}</span>
                )}
                <span style={{ flex: 1 }} />
                {r.modules.length > 0 && (
                  <span className="muted">
                    {tr(r.modules.length === 1 ? '1 file' : '{n} files', {
                      n: r.modules.length,
                    })}
                  </span>
                )}
                <button
                  className="icon-btn"
                  aria-label={tr('Edit {name}', {
                    name: `${r.product} ${r.version}`,
                  })}
                  title={tr('Edit the release')}
                  onClick={() => onEdit(r)}
                >
                  <Icon name="edit" />
                </button>
              </div>
              {r.summary && <p className="rl-card-sum">{r.summary}</p>}
              {!r.modules.length &&
                (ownText ? (
                  <div className="rl-boxes pad">
                    {box('Change log', r.changes, false)}
                    {box('Purpose', r.purpose, false)}
                    {box('Verification', r.verification, false)}
                  </div>
                ) : (
                  <p className="muted rl-card-sum">
                    {tr('No files in this release.')}
                  </p>
                ))}
              {r.modules.length > 0 && (
                <ul className="rl-files">
                  {r.modules.map((m) => {
                    const isOpen = open === m.id;
                    const info = fileInfo(r, m);
                    const prev = previousVersion(all, r, m);
                    const none =
                      !info.changes && !info.purpose && !info.verification;
                    const extra = (lists?.fields ?? []).filter(
                      (f) => m.extra[f.key],
                    );
                    return (
                      <li key={m.id} className={isOpen ? 'open' : ''}>
                        <button
                          className="rl-file"
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : m.id)}
                        >
                          <Icon name="file" />
                          {m.fileName || moduleName(m) ? (
                            <span className="n mono">
                              {m.fileName || moduleName(m)}
                            </span>
                          ) : (
                            <span className="n none">{tr('No info')}</span>
                          )}
                          {m.fileName && m.module && (
                            <span className="muted">{m.module}</span>
                          )}
                          <span style={{ flex: 1 }} />
                          {m.environment && (
                            <span className="rl-env">{m.environment}</span>
                          )}
                          <span className="rl-v mono">{m.version}</span>
                          <Icon name="chev" />
                        </button>
                        {isOpen && (
                          <div className="rl-detail">
                            <div className="rl-meta">
                              {m.destination && (
                                <span>
                                  {colName('destination')}{' '}
                                  <b>{m.destination}</b>
                                </span>
                              )}
                              {m.category && (
                                <span>
                                  {colName('category')} <b>{m.category}</b>
                                </span>
                              )}
                              {m.type && (
                                <span>
                                  {tr('Type')} <b>{m.type}</b>
                                </span>
                              )}
                              <span>
                                {tr('Version')}{' '}
                                <b className="mono">
                                  {prev || tr('first')} → {m.version || '—'}
                                </b>
                              </span>
                              {extra.map((f) => (
                                <span key={f.key}>
                                  {f.name} <b>{m.extra[f.key]}</b>
                                </span>
                              ))}
                            </div>
                            {none ? (
                              <div className="rl-noinfo">{tr('No info')}</div>
                            ) : (
                              <div className="rl-boxes">
                                {box(
                                  'Change log',
                                  info.changes,
                                  info.fromRelease.changes,
                                )}
                                {box(
                                  'Purpose',
                                  info.purpose,
                                  info.fromRelease.purpose,
                                )}
                                {box(
                                  'Verification',
                                  info.verification,
                                  info.fromRelease.verification,
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </li>
        );
      })}
    </ol>
  );
}

type Draft = Omit<ReleaseInput, 'modules'> & {
  modules: (Omit<ReleaseModule, 'id'> & { id?: string; key: number })[];
};
type TextKey = Exclude<
  keyof ReleaseModule,
  'id' | 'extra' | 'changes' | 'purpose' | 'verification'
>;
let nextKey = 1;

/** A release: its fields, and the modules it delivers, in one form. */
function ReleaseEditor({
  projectId,
  release,
  all,
  lists,
  defaultProduct,
  onClose,
  onSaved,
}: {
  projectId: string;
  release: Release | null;
  all: Release[];
  lists: ReleaseLists;
  defaultProduct: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { attempt, toast, today } = useApp();
  const [d, setD] = useState<Draft>(() =>
    release
      ? {
          ...release,
          modules: release.modules.map((m) => ({ ...m, key: nextKey++ })),
        }
      : {
          product: defaultProduct || lists.products[0] || '',
          // The edition of the product's latest release, as a start.
          target:
            byDate(
              all.filter(
                (r) => r.product === (defaultProduct || lists.products[0]),
              ),
            ).pop()?.target ?? '',
          releasedOn: today,
          version: '',
          status: 'released',
          summary: '',
          purpose: '',
          changes: '',
          verification: '',
          modules: [],
        },
  );
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Set<number>>(new Set());
  const toggle = (key: number) =>
    setDetails((x) => {
      const n = new Set(x);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setD((x) => ({ ...x, [k]: v }));
  const setModule = (key: number, patch: Partial<ReleaseModule>) =>
    setD((x) => ({
      ...x,
      modules: x.modules.map((m) => (m.key === key ? { ...m, ...patch } : m)),
    }));
  // The release of the same product before this one, to start from its modules.
  const previous = byDate(
    all.filter(
      (r) =>
        r.product === d.product && r.id !== release?.id && r.modules.length > 0,
    ),
  ).pop();
  const moduleNames = [
    ...new Set(
      all.flatMap((r) => r.modules.map((m) => m.module)).filter(Boolean),
    ),
  ];
  const fileNames = [
    ...new Set(
      all.flatMap((r) => r.modules.map((m) => m.fileName)).filter(Boolean),
    ),
  ];

  const save = async () => {
    setBusy(true);
    const r = await attempt(() =>
      window.worksync.saveRelease(
        projectId,
        {
          ...d,
          releasedOn: d.releasedOn || null,
          modules: d.modules.map(({ key: _key, ...m }) => m),
        },
        release?.id,
      ),
    );
    setBusy(false);
    if (!r) return;
    toast(
      tr(release ? 'Saved {name}.' : 'Added {name}.', {
        name: `${r.product} ${r.version}`,
      }),
    );
    onSaved();
  };
  const remove = async () => {
    if (!release) return;
    if (
      !(await confirmDelete({
        title: tr('Delete the release {name}?', {
          name: `${release.product} ${release.version}`,
        }),
        text: tr('The release and its modules are deleted.'),
        yes: tr('Delete'),
      }))
    )
      return;
    if (await attempt(() => window.worksync.deleteRelease(release.id))) {
      toast(
        tr('Deleted {name}.', {
          name: `${release.product} ${release.version}`,
        }),
      );
      onSaved();
    }
  };
  const datalist = (id: string, values: string[]) => (
    <datalist id={id}>
      {values.map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );

  return (
    <Modal
      title={release ? tr('Edit the release') : tr('New release')}
      subtitle={tr(
        'Pick from the lists or type a new name; new names join the lists.',
      )}
      onClose={onClose}
      wide
      footer={
        <>
          {release && (
            <button className="btn danger" onClick={() => void remove()}>
              <Icon name="trash" />
              {tr('Delete')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? tr('Saving…') : tr('Save')}
          </button>
        </>
      }
    >
      <div className="form rl-form">
        {datalist('rl-products', lists.products)}
        {datalist('rl-editions', lists.editions)}
        {datalist('rl-destinations', lists.destinations)}
        {datalist('rl-categories', lists.categories)}
        {datalist('rl-environments', lists.environments)}
        {datalist('rl-modules', moduleNames)}
        {datalist('rl-files', fileNames)}
        <div className="rl-grid">
          <label className="field">
            <span className="k">{tr('Product')}</span>
            <input
              className="inp"
              list="rl-products"
              value={d.product}
              onChange={(e) => set('product', e.target.value)}
              placeholder="EMVCon"
            />
          </label>
          <label className="field">
            <span className="k">{tr('Edition')}</span>
            <input
              className="inp"
              list="rl-editions"
              value={d.target}
              onChange={(e) => set('target', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="k">{tr('Version')}</span>
            <input
              className="inp mono"
              value={d.version}
              onChange={(e) => set('version', e.target.value)}
              placeholder="1.2.0"
            />
          </label>
          <div className="field">
            <span className="k">{tr('Status')}</span>
            <div className="seg-ctl" role="group">
              {(['released', 'planned'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={d.status === s}
                  onClick={() => set('status', s)}
                >
                  {tr(s === 'released' ? 'Released' : 'Planned')}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span className="k">{tr('Release date')}</span>
            <input
              className="inp"
              type="date"
              value={d.releasedOn ?? ''}
              onChange={(e) => set('releasedOn', e.target.value || null)}
            />
          </label>
        </div>
        <label className="field">
          <span className="k">{colName('summary')}</span>
          <input
            className="inp"
            value={d.summary}
            onChange={(e) => set('summary', e.target.value)}
          />
        </label>
        <div className="rl-grid three">
          {(
            [
              ['purpose', 'Purpose'],
              ['changes', 'Changes (improvements, changes)'],
              ['verification', 'Verification'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="field">
              <span className="k">{tr(label)}</span>
              <textarea
                className="inp"
                rows={3}
                value={d[k]}
                onChange={(e) => set(k, e.target.value)}
              />
            </label>
          ))}
        </div>

        <div className="rl-mods-head">
          <b>{tr('Modules in this release')}</b>
          <span className="muted">
            {tr(
              'Only the files this release delivers; the others keep their version. Details: what changed in each file.',
            )}
          </span>
          <span style={{ flex: 1 }} />
          {previous && !d.modules.length && (
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                set(
                  'modules',
                  // The files, without what the earlier release said about them.
                  previous.modules.map(({ id: _id, ...m }) => ({
                    ...m,
                    changes: '',
                    purpose: '',
                    verification: '',
                    extra: {},
                    key: nextKey++,
                  })),
                )
              }
            >
              <Icon name="copy" />
              {tr('Copy the modules of {name}', {
                name: `${previous.product} ${previous.version}`,
              })}
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              set('modules', [
                ...d.modules,
                {
                  ...EMPTY_MODULE,
                  ...(d.modules.length
                    ? {
                        destination:
                          d.modules[d.modules.length - 1].destination,
                        category: d.modules[d.modules.length - 1].category,
                        type: d.modules[d.modules.length - 1].type,
                      }
                    : { type: d.target }),
                  key: nextKey++,
                },
              ])
            }
          >
            <Icon name="plus" />
            {tr('Add a module')}
          </button>
        </div>
        {d.modules.length > 0 && (
          <div className="rl-scroll">
            <table className="rl-table edit">
              <thead>
                <tr>
                  <th>{colName('destination')}</th>
                  <th>{colName('category')}</th>
                  <th>{tr('Type')}</th>
                  <th>{tr('Module')}</th>
                  <th>{tr('File name')}</th>
                  <th>{tr('Environment')}</th>
                  <th>{tr('Version')}</th>
                  <th aria-label={tr('Details')} />
                  <th aria-label={tr('Remove')} />
                </tr>
              </thead>
              <tbody>
                {d.modules.map((m) => {
                  const hasText = !!(
                    m.changes ||
                    m.purpose ||
                    m.verification ||
                    Object.values(m.extra).some(Boolean)
                  );
                  const isOpen = details.has(m.key);
                  return (
                    <Fragment key={m.key}>
                      <tr className={isOpen ? 'has-detail' : ''}>
                        {(
                          [
                            ['destination', 'rl-destinations'],
                            ['category', 'rl-categories'],
                            ['type', 'rl-editions'],
                            ['module', 'rl-modules'],
                            ['fileName', 'rl-files'],
                            ['environment', 'rl-environments'],
                            ['version', ''],
                          ] as [TextKey, string][]
                        ).map(([k, listId]) => (
                          <td key={k}>
                            <input
                              className={`inp sm ${k === 'version' ? 'mono' : ''}`}
                              list={listId || undefined}
                              aria-label={tr(LABEL_OF[k])}
                              value={m[k]}
                              onChange={(e) =>
                                setModule(m.key, { [k]: e.target.value })
                              }
                            />
                          </td>
                        ))}
                        <td>
                          <button
                            type="button"
                            className={`btn sm rl-det-btn ${hasText ? 'on' : ''}`}
                            aria-expanded={isOpen}
                            title={tr(
                              'What changed in this file, why, and how it was checked',
                            )}
                            onClick={() => toggle(m.key)}
                          >
                            {tr('Details')}
                            {hasText && <span className="rl-dot" />}
                          </button>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={tr('Remove')}
                            title={tr('Remove')}
                            onClick={() =>
                              set(
                                'modules',
                                d.modules.filter((x) => x.key !== m.key),
                              )
                            }
                          >
                            <Icon name="x" />
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="rl-det-row">
                          <td colSpan={9}>
                            <div className="rl-grid three">
                              {(
                                [
                                  ['changes', 'Change log'],
                                  ['purpose', 'Purpose'],
                                  ['verification', 'Verification'],
                                ] as const
                              ).map(([k, label]) => (
                                <label key={k} className="field">
                                  <span className="k">{tr(label)}</span>
                                  <textarea
                                    className="inp"
                                    rows={3}
                                    placeholder={tr(
                                      'Empty: the release’s text is shown',
                                    )}
                                    value={m[k]}
                                    onChange={(e) =>
                                      setModule(m.key, { [k]: e.target.value })
                                    }
                                  />
                                </label>
                              ))}
                            </div>
                            {lists.fields.length > 0 && (
                              <div className="rl-grid">
                                {lists.fields.map((f) => (
                                  <label key={f.key} className="field">
                                    <span className="k">{f.name}</span>
                                    <input
                                      className="inp sm"
                                      value={m.extra[f.key] ?? ''}
                                      onChange={(e) =>
                                        setModule(m.key, {
                                          extra: {
                                            ...m.extra,
                                            [f.key]: e.target.value,
                                          },
                                        })
                                      }
                                    />
                                  </label>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

// Shown with colName where the sheets have their own word.
const LABEL_OF: Record<TextKey, string> = {
  destination: 'Destination',
  category: 'Category',
  type: 'Type',
  module: 'Module',
  fileName: 'File name',
  environment: 'Environment',
  version: 'Version',
};

/** The project's lists to pick from, each in its order. */
function ListsDialog({
  projectId,
  lists,
  onSaved,
  onClose,
}: {
  projectId: string;
  lists: ReleaseLists;
  onSaved: (l: ReleaseLists) => void;
  onClose: () => void;
}) {
  const { attempt } = useApp();
  const [l, setL] = useState(lists);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const save = async (next: ReleaseLists) => {
    const r = await attempt(() =>
      window.worksync.saveReleaseLists(projectId, next),
    );
    if (r) {
      setL(r);
      onSaved(r);
    }
  };
  const addField = () => {
    const v = (adding.fields ?? '').trim();
    if (!v) return;
    setAdding((a) => ({ ...a, fields: '' }));
    void save({ ...l, fields: [...l.fields, { key: fieldKey(v), name: v }] });
  };
  const add = (k: NameList) => {
    const v = (adding[k] ?? '').trim();
    if (!v) return;
    setAdding((a) => ({ ...a, [k]: '' }));
    void save({ ...l, [k]: [...l[k], v] });
  };
  return (
    <Modal
      title={tr('Release lists')}
      subtitle={tr(
        'What you pick from in a release, in the order the views and the Excel sheets use. Removing a name does not change releases that use it.',
      )}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          {tr('Done')}
        </button>
      }
    >
      <div className="form rl-lists">
        {(Object.keys(LIST_NAMES) as NameList[]).map((k) => (
          <section key={k} className="field">
            <span className="k">{tr(LIST_NAMES[k])}</span>
            <div className="rl-chips">
              {l[k].map((v, i) => (
                <span key={v} className="note-tag">
                  {i > 0 && (
                    <button
                      className="note-tag-x"
                      aria-label={tr('Move {name} earlier', { name: v })}
                      title={tr('Earlier')}
                      onClick={() => {
                        const next = [...l[k]];
                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                        void save({ ...l, [k]: next });
                      }}
                    >
                      ‹
                    </button>
                  )}
                  {v}
                  <button
                    className="note-tag-x"
                    aria-label={tr('Remove {name}', { name: v })}
                    onClick={async () => {
                      if (
                        await confirmDelete({
                          title: tr('Remove {name} from the list?', {
                            name: v,
                          }),
                          text: tr('Releases that use it keep it.'),
                          yes: tr('Remove'),
                        })
                      )
                        void save({ ...l, [k]: l[k].filter((x) => x !== v) });
                    }}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              ))}
              <input
                className="inp sm rl-add"
                placeholder={tr('Add…')}
                aria-label={tr('Add to {list}', { list: tr(LIST_NAMES[k]) })}
                value={adding[k] ?? ''}
                onChange={(e) =>
                  setAdding((a) => ({ ...a, [k]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add(k);
                  }
                }}
                onBlur={() => add(k)}
              />
            </div>
          </section>
        ))}
        <section className="field">
          <span className="k">{tr('File fields')}</span>
          <span className="muted step-help">
            {tr(
              'Your own fields on each released file, such as a ticket number. Templates write them as {marker}.',
              { marker: '{{file.ticket_no}}' },
            )}
          </span>
          <div className="rl-chips">
            {l.fields.map((f, i) => (
              <span
                key={f.key}
                className="note-tag"
                title={`{{file.${f.key}}}`}
              >
                {i > 0 && (
                  <button
                    className="note-tag-x"
                    aria-label={tr('Move {name} earlier', { name: f.name })}
                    title={tr('Earlier')}
                    onClick={() => {
                      const next = [...l.fields];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      void save({ ...l, fields: next });
                    }}
                  >
                    ‹
                  </button>
                )}
                {f.name}
                <button
                  className="note-tag-x"
                  aria-label={tr('Remove {name}', { name: f.name })}
                  onClick={async () => {
                    if (
                      await confirmDelete({
                        title: tr('Remove the field {name}?', { name: f.name }),
                        text: tr(
                          'It is no longer shown or exported. What files have in it is kept, and comes back if you add the field again.',
                        ),
                        yes: tr('Remove'),
                      })
                    )
                      void save({
                        ...l,
                        fields: l.fields.filter((x) => x.key !== f.key),
                      });
                  }}
                >
                  <Icon name="x" />
                </button>
              </span>
            ))}
            <input
              className="inp sm rl-add"
              placeholder={tr('Add…')}
              aria-label={tr('Add to {list}', { list: tr('File fields') })}
              value={adding.fields ?? ''}
              onChange={(e) =>
                setAdding((a) => ({ ...a, fields: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addField();
                }
              }}
              onBlur={() => addField()}
            />
          </div>
        </section>
      </div>
    </Modal>
  );
}
