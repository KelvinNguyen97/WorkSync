import { useEffect, useMemo, useState } from 'react';
import {
  byDate,
  EMPTY_MODULE,
  latestModules,
  productsOf,
  sheetDate,
  versionMatrix,
  type Release,
  type ReleaseInput,
  type ReleaseLists,
  type ReleaseModule,
} from '../shared/releases';
import { useApp } from './appState';
import { Icon } from './Icon';
import { confirmDelete, Modal } from './parts';
import type { ViewProps } from './views';
import { tr } from './i18n';

type Tab = 'history' | 'versions' | 'modules';

const LIST_NAMES: Record<keyof ReleaseLists, string> = {
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
  const [tab, setTab] = useState<Tab>('history');
  const [product, setProduct] = useState('');
  const [editing, setEditing] = useState<Release | 'new' | null>(null);
  const [listsOpen, setListsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

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
              ...r.modules.flatMap((m) => [m.module, m.fileName, m.version]),
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
          <button
            className="btn"
            disabled={!all.length}
            onClick={() => setExportOpen(true)}
          >
            <Icon name="download" />
            <span className="lbl">{tr('Export to Excel')}</span>
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
                ['history', 'History'],
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
                'Add each release with its date, version and what changed, and the modules it delivers. The Excel export then gives the module version list and the release history in the usual layout.',
              )}
            </p>
            <button className="btn primary" onClick={() => setEditing('new')}>
              <Icon name="plus" />
              {tr('Add the first release')}
            </button>
          </div>
        ) : tab === 'history' ? (
          <div className="rl-list" role="list">
            {newestFirst.map((r) => (
              <button
                key={r.id}
                role="listitem"
                className={`rl-item ${r.status}`}
                onClick={() => setEditing(r)}
              >
                <span className="rl-ver">
                  <b className="mono">{r.version}</b>
                  {r.status === 'planned' ? (
                    <span className="rl-pill planned">{tr('Planned')}</span>
                  ) : (
                    <span className="muted mono">
                      {sheetDate(r.releasedOn)}
                    </span>
                  )}
                </span>
                <span className="rl-main">
                  <span className="rl-tags">
                    <span className="rl-pill">{r.product}</span>
                    {r.target && (
                      <span className="rl-pill soft">{r.target}</span>
                    )}
                    {r.modules.length > 0 && (
                      <span className="muted">
                        {tr(
                          r.modules.length === 1 ? '1 module' : '{n} modules',
                          { n: r.modules.length },
                        )}
                      </span>
                    )}
                  </span>
                  {r.summary && <b className="rl-summary">{r.summary}</b>}
                  {(
                    [
                      ['Purpose', r.purpose],
                      ['Changes', r.changes],
                      ['Verification', r.verification],
                    ] as [string, string][]
                  )
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <span key={k} className="rl-line">
                        <span className="k">{tr(k)}</span>
                        <span className="v">{v}</span>
                      </span>
                    ))}
                </span>
              </button>
            ))}
          </div>
        ) : tab === 'versions' ? (
          matrix && matrix.rows.length ? (
            <div className="rl-scroll">
              <table className="rl-table matrix">
                <thead>
                  <tr>
                    <th>{tr('Destination')}</th>
                    <th>{tr('Category')}</th>
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
                        <td>{r.module}</td>
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
                    <td>{m.module}</td>
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
      {exportOpen && (
        <ExportDialog
          projectId={projectId}
          japanese={(p.originalLanguages[0] ?? 'ja') === 'ja'}
          onClose={() => setExportOpen(false)}
        />
      )}
    </>
  );
}

type Draft = Omit<ReleaseInput, 'modules'> & {
  modules: (Omit<ReleaseModule, 'id'> & { key: number })[];
};
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
          <span className="k">{tr('Summary')}</span>
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
                rows={4}
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
              'Only the modules this release delivers; the others keep their version.',
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
                  previous.modules.map(({ id: _id, ...m }) => ({
                    ...m,
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
                  <th>{tr('Destination')}</th>
                  <th>{tr('Category')}</th>
                  <th>{tr('Type')}</th>
                  <th>{tr('Module')}</th>
                  <th>{tr('File name')}</th>
                  <th>{tr('Environment')}</th>
                  <th>{tr('Version')}</th>
                  <th aria-label={tr('Remove')} />
                </tr>
              </thead>
              <tbody>
                {d.modules.map((m) => (
                  <tr key={m.key}>
                    {(
                      [
                        ['destination', 'rl-destinations'],
                        ['category', 'rl-categories'],
                        ['type', 'rl-editions'],
                        ['module', 'rl-modules'],
                        ['fileName', 'rl-files'],
                        ['environment', 'rl-environments'],
                        ['version', ''],
                      ] as [Exclude<keyof ReleaseModule, 'id'>, string][]
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

const LABEL_OF: Record<keyof ReleaseModule, string> = {
  id: 'ID',
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
  const add = (k: keyof ReleaseLists) => {
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
        {(Object.keys(LIST_NAMES) as (keyof ReleaseLists)[]).map((k) => (
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
      </div>
    </Modal>
  );
}

/** Saving the releases as an Excel workbook, in Japanese or English. */
function ExportDialog({
  projectId,
  japanese,
  onClose,
}: {
  projectId: string;
  japanese: boolean;
  onClose: () => void;
}) {
  const { attempt, toast } = useApp();
  const [lang, setLang] = useState<'ja' | 'en'>(japanese ? 'ja' : 'en');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await attempt(() =>
      window.worksync.exportReleases(projectId, lang),
    );
    setBusy(false);
    if (r) {
      toast(
        tr('Saved {file}.', { file: r.file.split(/[\\/]/).pop() ?? r.file }),
      );
      onClose();
    }
  };
  return (
    <Modal
      title={tr('Export the releases to Excel')}
      subtitle={tr(
        'One workbook: the module version list (a column per release date), the newest version of each module, and a release history per product, oldest first.',
      )}
      onClose={onClose}
      narrow
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void go()}
          >
            <Icon name="download" />
            {busy ? tr('Saving…') : tr('Save…')}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <span className="k">{tr('Headings in')}</span>
          <div className="seg-ctl" role="group">
            <button aria-pressed={lang === 'ja'} onClick={() => setLang('ja')}>
              日本語
            </button>
            <button aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
              English
            </button>
          </div>
        </div>
        <p className="muted step-help">
          {tr(
            'Your text is written as you typed it; only the sheet names and headings change.',
          )}
        </p>
      </div>
    </Modal>
  );
}
