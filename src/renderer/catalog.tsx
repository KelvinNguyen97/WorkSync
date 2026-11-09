import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  isApp,
  matchesEntry,
  passesFilter,
  shortcutLabel,
  sortEntries,
  type CatalogEntry,
  type CatalogFilter,
  type CatalogSort,
  type EverythingAnswer,
  type EverythingResult,
  type SearchSource,
} from '../shared/catalog';
import { parseTags } from '../shared/notes';
import { useApp } from './appState';
import { Icon } from './Icon';
import { FileIcon } from './fileIcon';
import type { HeaderSlot } from './mine';
import { Modal } from './parts';
import { tr } from './i18n';

const SORT_KEY = 'worksync.catalog.sort';
const SOURCE_KEY = 'worksync.catalog.source';
const windows = navigator.userAgent.includes('Windows');

const remember = <T extends string>(key: string, fallback: T): T => {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
};
const keep = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {
    // A remembered choice is only a convenience.
  }
};

const ago = (iso: string | null) => {
  if (!iso) return tr('Never opened');
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return tr('Opened just now');
  if (mins < 60) return tr('Opened {n} min ago', { n: mins });
  if (mins < 24 * 60)
    return tr('Opened {n} h ago', { n: Math.round(mins / 60) });
  const p = (n: number) => String(n).padStart(2, '0');
  return tr('Opened {date}', {
    date: `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`,
  });
};

/**
 * The Catalog: apps, files and folders you open often. On Windows, files on
 * this PC are found with Everything too.
 */
export function CatalogView({
  entries,
  setEntries,
  query,
  head,
}: {
  entries: CatalogEntry[];
  setEntries: (f: (list: CatalogEntry[]) => CatalogEntry[]) => void;
  query: string;
  head: HeaderSlot;
}) {
  const { attempt, toast, settings } = useApp();
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [sort, setSortState] = useState<CatalogSort>(() =>
    remember(SORT_KEY, 'lastOpened'),
  );
  const [source, setSourceState] = useState<SearchSource>(() =>
    windows ? remember(SOURCE_KEY, 'both') : 'catalog',
  );
  const [found, setFound] = useState<EverythingAnswer | null>(null);
  const [editing, setEditing] = useState<CatalogEntry | null>(null);
  const setSort = (s: CatalogSort) => {
    setSortState(s);
    keep(SORT_KEY, s);
  };
  const setSource = (s: SearchSource) => {
    setSourceState(s);
    keep(SOURCE_KEY, s);
  };
  const useEverything = windows && settings.everything && source !== 'catalog';

  const reload = () =>
    void attempt(() => window.worksync.listCatalog()).then(
      (list) => list && setEntries(() => list),
    );
  // Paths are checked again each time the page opens.
  useEffect(() => {
    reload();
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!useEverything || !q) {
      setFound(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      void window.worksync.searchEverything(q).then(
        (r) => live && setFound(r),
        () => live && setFound(null),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query, useEverything]);

  const counts = useMemo(() => {
    const c = {} as Record<CatalogFilter, number>;
    for (const f of [
      'all',
      'apps',
      'files',
      'folders',
      'favorites',
      'missing',
    ] as const)
      c[f] = entries.filter((e) => passesFilter(e, f)).length;
    return c;
  }, [entries]);
  const shown = sortEntries(
    entries.filter((e) => passesFilter(e, filter) && matchesEntry(e, query)),
    sort,
  );

  const put = (e: CatalogEntry) =>
    setEntries((list) =>
      list.some((x) => x.id === e.id)
        ? list.map((x) => (x.id === e.id ? e : x))
        : [...list, e],
    );

  const add = async (kind: 'file' | 'folder') => {
    const r = await attempt(() => window.worksync.addToCatalog(kind));
    if (!r) return;
    r.added.forEach(put);
    toast(
      (r.added.length === 1
        ? tr('Added {name}.', { name: r.added[0].name })
        : r.added.length
          ? tr('Added {n} entries.', { n: r.added.length })
          : tr('Nothing added.')) +
        (r.skipped
          ? tr(
              r.skipped === 1
                ? ' {n} was already in the Catalog.'
                : ' {n} were already in the Catalog.',
              { n: r.skipped },
            )
          : ''),
    );
  };
  const open = async (e: CatalogEntry) => {
    const u = await attempt(() => window.worksync.openCatalogEntry(e.id));
    if (u) put(u);
  };
  const copy = async (p: string) => {
    if (await attempt(() => window.worksync.copyText(p).then(() => true)))
      toast(tr('Path copied.'));
  };
  const remove = async (e: CatalogEntry) => {
    const gone = await attempt(() => window.worksync.removeCatalogEntry(e.id));
    if (!gone) return;
    setEntries((list) => list.filter((x) => x.id !== e.id));
    toast(
      `Removed ${e.name} from the Catalog. The ${e.kind} itself is untouched.`,
      {
        label: 'Undo',
        run: () =>
          void attempt(() => window.worksync.restoreCatalogEntry(gone)).then(
            (b) => b && put(b),
          ),
      },
    );
  };
  const favorite = async (e: CatalogEntry) => {
    const u = await attempt(() =>
      window.worksync.saveCatalogEntry({ favorite: !e.favorite }, e.id),
    );
    if (u) put(u);
  };
  const addFound = async (r: EverythingResult) => {
    const u = await attempt(() => window.worksync.addFoundToCatalog(r.path));
    if (!u) return;
    put(u);
    setFound(
      (f) =>
        f && {
          ...f,
          results: f.results.map((x) =>
            x.path === r.path ? { ...x, saved: true } : x,
          ),
        },
    );
    toast(`Added ${u.name} to the Catalog.`);
  };

  const filters: [CatalogFilter, string][] = [
    ['all', 'All'],
    ['apps', 'Apps'],
    ['files', 'Files'],
    ['folders', 'Folders'],
    ['favorites', 'Favorites'],
    ['missing', 'Not found'],
  ];
  const showCatalog = source !== 'everything';
  const showFound = useEverything;

  return (
    <div
      className={`mine-page cat-page ${showCatalog && showFound ? 'both' : ''}`}
    >
      {head &&
        createPortal(
          <div className="vh">
            <div>
              <h1>{tr('Catalog')}</h1>
              <div className="sub">
                {tr('Apps, files and folders you open often.')}
                {settings.quickSearchKey && (
                  <>
                    {' '}
                    {tr('Press')}{' '}
                    <span className="cat-kbd">
                      {shortcutLabel(settings.quickSearchKey)}
                    </span>{' '}
                    {tr('anywhere to search them.')}
                  </>
                )}
              </div>
            </div>
            <div className="vh-actions">
              <button className="btn" onClick={() => void add('folder')}>
                <Icon name="folder" />
                {tr('Add a folder')}
              </button>
              <button className="btn primary" onClick={() => void add('file')}>
                <Icon name="plus" />
                {tr('Add an app or file')}
              </button>
            </div>
          </div>,
          head,
        )}
      <div className="cat-tools">
        {windows && settings.everything && (
          <div className="seg-ctl" role="group" aria-label={tr('Search in')}>
            {(
              [
                ['both', 'Both'],
                ['catalog', 'Catalog'],
                ['everything', 'This PC'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                aria-pressed={source === k}
                onClick={() => setSource(k)}
              >
                {tr(l)}
              </button>
            ))}
          </div>
        )}
        {showCatalog && (
          <>
            <div className="mt-chips" role="group" aria-label={tr('Show')}>
              {filters.map(([k, l]) => (
                <button
                  key={k}
                  className="qchip"
                  aria-pressed={filter === k}
                  onClick={() => setFilter(k)}
                >
                  {tr(l)} <b>{counts[k]}</b>
                </button>
              ))}
            </div>
            <span className="grow" />
            <label className="cat-sort">
              {tr('Sort')}
              <select
                className="inp"
                value={sort}
                onChange={(e) => setSort(e.target.value as CatalogSort)}
              >
                <option value="lastOpened">{tr('Last opened')}</option>
                <option value="name">{tr('Name')}</option>
                <option value="kind">{tr('Type')}</option>
                <option value="added">{tr('Recently added')}</option>
              </select>
            </label>
            <button
              className="icon-btn"
              aria-label={tr('Check the paths again')}
              title={tr('Check the paths again')}
              onClick={reload}
            >
              <Icon name="refresh" />
            </button>
          </>
        )}
      </div>

      <div className="cat-body">
        {showCatalog && (
          <div className="cat-list" role="list" aria-label={tr('Catalog')}>
            {shown.map((e) => (
              <div
                key={e.id}
                role="listitem"
                className={`cat-row ${e.missing ? 'missing' : ''}`}
                onDoubleClick={() => void open(e)}
              >
                <FileIcon
                  path={e.path}
                  kind={
                    e.kind === 'folder' ? 'folder' : isApp(e) ? 'app' : 'file'
                  }
                  fallback={
                    e.kind === 'folder' ? 'folder' : isApp(e) ? 'app' : 'file'
                  }
                />
                <span className="cat-main">
                  <span className="cat-name">
                    <b>{e.name}</b>
                    {e.favorite && <Icon name="star" className="fav" />}
                    {e.missing && (
                      <span className="cat-miss">{tr('Not found')}</span>
                    )}
                  </span>
                  <small className="cat-path">{e.path}</small>
                </span>
                <span className="cat-meta">
                  <span className="cat-tags">
                    {e.tags.map((t) => (
                      <span key={t} className="note-tag">
                        {t}
                      </span>
                    ))}
                  </span>
                  {e.note && <small>{e.note}</small>}
                </span>
                <span className="cat-when muted">{ago(e.lastOpened)}</span>
                <span className="cat-acts">
                  <button
                    className="btn sm"
                    disabled={e.missing}
                    onClick={() => void open(e)}
                  >
                    {tr('Open')}
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Show ${e.name} in its folder`}
                    title={tr('Show in folder')}
                    disabled={e.missing}
                    onClick={() =>
                      void attempt(() =>
                        window.worksync.revealCatalogEntry(e.id),
                      )
                    }
                  >
                    <Icon name="folder" />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Copy the path of ${e.name}`}
                    title={tr('Copy path')}
                    onClick={() => void copy(e.path)}
                  >
                    <Icon name="copy" />
                  </button>
                  <button
                    className={`icon-btn ${e.favorite ? 'on-fav' : ''}`}
                    aria-pressed={e.favorite}
                    aria-label={`Favorite: ${e.name}`}
                    title={
                      e.favorite
                        ? tr('Remove from favorites')
                        : tr('Add to favorites')
                    }
                    onClick={() => void favorite(e)}
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Edit ${e.name}`}
                    title={tr('Edit')}
                    onClick={() => setEditing(e)}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Remove ${e.name} from the Catalog`}
                    title={tr('Remove from the Catalog (the file stays)')}
                    onClick={() => void remove(e)}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              </div>
            ))}
            {!shown.length && (
              <div className="empty">
                {entries.length
                  ? tr('No entry matches. Try another filter or search.')
                  : tr(
                      'Your Catalog is empty. Add the apps, files and folders you open often.',
                    )}
              </div>
            )}
          </div>
        )}
        {showFound && (
          <section className="cat-found" aria-label={tr('Files on this PC')}>
            <div className="cat-found-head">
              <span className="k">{tr('Files on this PC')}</span>
              <FoundState answer={found} query={query} />
            </div>
            <div className="cat-found-list">
              {found?.results.map((r) => (
                <div key={r.path} className="cat-found-row">
                  <FileIcon
                    path={r.path}
                    kind={r.isFolder ? 'folder' : 'found'}
                    fallback={r.isFolder ? 'folder' : 'file'}
                  />
                  <span className="cat-main">
                    <b>{r.name}</b>
                    <small className="cat-path">{r.folder}</small>
                  </span>
                  <span className="cat-acts">
                    <button
                      className="btn sm"
                      onClick={() =>
                        void attempt(() =>
                          window.worksync.openFound(r.path, false),
                        )
                      }
                    >
                      {tr('Open')}
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`Show ${r.name} in its folder`}
                      title={tr('Show in folder')}
                      onClick={() =>
                        void attempt(() =>
                          window.worksync.openFound(r.path, true),
                        )
                      }
                    >
                      <Icon name="folder" />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`Copy the path of ${r.name}`}
                      title={tr('Copy path')}
                      onClick={() => void copy(r.path)}
                    >
                      <Icon name="copy" />
                    </button>
                    <button
                      className="btn sm"
                      disabled={r.saved}
                      onClick={() => void addFound(r)}
                    >
                      {r.saved ? tr('In the Catalog') : tr('Add')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      {editing && (
        <EntryEditor
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={(e) => {
            put(e);
            setEditing(null);
            toast(tr('Saved.'));
          }}
        />
      )}
    </div>
  );
}

function FoundState({
  answer,
  query,
}: {
  answer: EverythingAnswer | null;
  query: string;
}) {
  const text = !query.trim()
    ? 'Type in the search box above to look for files and folders.'
    : !answer
      ? 'Searching…'
      : answer.state === 'starting'
        ? 'Everything is starting or building its index. Results appear in a moment.'
        : answer.state === 'unavailable'
          ? 'Everything isn’t available on this PC.'
          : `${answer.results.length} found for “${query.trim()}”`;
  return (
    <span className={`cat-found-state ${answer?.state ?? ''}`} role="status">
      {answer?.state === 'ok' && <span className="dot" />}
      {text}
    </span>
  );
}

function EntryEditor({
  entry,
  onClose,
  onSaved,
}: {
  entry: CatalogEntry;
  onClose: () => void;
  onSaved: (e: CatalogEntry) => void;
}) {
  const { attempt } = useApp();
  const [v, setV] = useState({
    name: entry.name,
    path: entry.path,
    tags: entry.tags.join(', '),
    note: entry.note,
  });
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const u = await attempt(() =>
      window.worksync.saveCatalogEntry(
        { name: v.name, path: v.path, tags: parseTags(v.tags), note: v.note },
        entry.id,
      ),
    );
    if (u) onSaved(u);
  };
  return (
    <Modal
      title={`Edit ${entry.name}`}
      onClose={onClose}
      narrow
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" onClick={() => void save()}>
            <Icon name="check" />
            {tr('Save')}
          </button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => void save(e)}>
        <label>
          {tr('Name')}
          <input
            className="inp"
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
          />
        </label>
        <label>
          {tr('Path')}
          <input
            className="inp mono"
            value={v.path}
            onChange={(e) => setV({ ...v, path: e.target.value })}
          />
        </label>
        <label>
          {tr('Tags')}
          <input
            className="inp"
            value={v.tags}
            placeholder={tr('office, customer')}
            onChange={(e) => setV({ ...v, tags: e.target.value })}
          />
        </label>
        <label>
          {tr('Note')}
          <textarea
            className="inp"
            rows={3}
            value={v.note}
            onChange={(e) => setV({ ...v, note: e.target.value })}
          />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
