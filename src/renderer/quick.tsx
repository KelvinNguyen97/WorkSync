import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isApp,
  matchesEntry,
  sortEntries,
  type CatalogEntry,
  type EverythingAnswer,
} from '../shared/catalog';
import { Icon } from './Icon';
import { FileIcon } from './fileIcon';
import { setTheme, setUiLanguage, tr } from './i18n';

/** Up to 8 Catalog entries and 8 files from Everything, as in FileManagement. */
const CATALOG_LIMIT = 8;
const FOUND_LIMIT = 8;

type Row =
  | { kind: 'entry'; entry: CatalogEntry }
  | {
      kind: 'found';
      path: string;
      name: string;
      folder: string;
      isFolder: boolean;
    };

/**
 * The quick-search box the shortcut opens over other apps. It searches the
 * Catalog first, then files on this PC with Everything.
 */
export function QuickSearch() {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [found, setFound] = useState<EverythingAnswer | null>(null);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [, rerender] = useState(0);
  const load = () => {
    void window.worksync.listCatalog().then(setEntries, () => {});
    // The app language may have changed in Settings.
    void window.worksync.start().then(
      (s) => {
        if (s.ok) {
          setUiLanguage(s.settings.uiLanguage);
          setTheme(s.settings.theme);
          rerender((n) => n + 1);
        }
      },
      () => {},
    );
  };
  useEffect(() => {
    load();
    return window.worksync.onOpen((t) => {
      if (t.page !== 'quickShown') return;
      load();
      setError(null);
      input.current?.focus();
      input.current?.select();
    });
  }, []);

  // Everything, a moment after typing stops.
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setFound(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      void window.worksync.searchEverything(query, FOUND_LIMIT).then(
        (r) => live && setFound(r),
        () => live && setFound(null),
      );
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q]);

  const rows: Row[] = useMemo(() => {
    const mine = q.trim()
      ? sortEntries(
          entries.filter((e) => matchesEntry(e, q)),
          'lastOpened',
        ).slice(0, CATALOG_LIMIT)
      : sortEntries(entries, 'lastOpened').slice(0, CATALOG_LIMIT);
    const savedPaths = new Set(mine.map((e) => e.path.toLowerCase()));
    const more = (found?.results ?? [])
      .filter((r) => !r.saved && !savedPaths.has(r.path.toLowerCase()))
      .slice(0, FOUND_LIMIT);
    return [
      ...mine.map((entry) => ({ kind: 'entry' as const, entry })),
      ...more.map((r) => ({ kind: 'found' as const, ...r })),
    ];
  }, [entries, found, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current
      ?.querySelector(`[data-i="${sel}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = async (row: Row | undefined, reveal: boolean) => {
    if (!row) return;
    setError(null);
    try {
      if (row.kind === 'entry') {
        if (reveal) await window.worksync.revealCatalogEntry(row.entry.id);
        else await window.worksync.openCatalogEntry(row.entry.id);
      } else await window.worksync.openFound(row.path, reveal);
      setQ('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const copyPath = async (row: Row | undefined) => {
    if (!row) return;
    await window.worksync.copyText(
      row.kind === 'entry' ? row.entry.path : row.path,
    );
    setError(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void run(rows[sel], e.ctrlKey || e.metaKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQ('');
      void window.worksync.hideQuickSearch();
    } else if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === 'c' &&
      input.current?.selectionStart === input.current?.selectionEnd
    ) {
      e.preventDefault();
      void copyPath(rows[sel]);
    }
  };

  const catalogRows = rows.filter((r) => r.kind === 'entry').length;
  const status =
    !q.trim() || !found
      ? null
      : found.state === 'starting'
        ? 'Everything is starting. Results from this PC appear in a moment.'
        : found.state === 'unavailable'
          ? 'Everything isn’t available, so only the Catalog is searched.'
          : null;

  return (
    <div className="qs" role="dialog" aria-label={tr('Quick search')}>
      <label className="qs-head">
        <Icon name="search" />
        <input
          ref={input}
          autoFocus
          aria-label={tr('Search')}
          placeholder={tr('Search the Catalog and files on this PC')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <span className="qs-brand">{tr('WORKSYNC')}</span>
      </label>
      <div
        className="qs-list"
        ref={list}
        role="listbox"
        aria-label={tr('Results')}
      >
        {catalogRows > 0 && <div className="qs-cap">{tr('Catalog')}</div>}
        {rows.map((r, i) => (
          <div key={i}>
            {i === catalogRows && (
              <div className="qs-cap">
                {tr('Files on this PC')} <span>{tr('· from Everything')}</span>
              </div>
            )}
            <div
              data-i={i}
              role="option"
              aria-selected={i === sel}
              className={`qs-row ${i === sel ? 'hl' : ''}`}
              onMouseMove={() => setSel(i)}
              onClick={() => void run(r, false)}
            >
              <FileIcon
                path={r.kind === 'entry' ? r.entry.path : r.path}
                kind={
                  r.kind === 'entry'
                    ? r.entry.kind === 'folder'
                      ? 'folder'
                      : isApp(r.entry)
                        ? 'app'
                        : 'file'
                    : r.isFolder
                      ? 'folder'
                      : 'found'
                }
                fallback={
                  (r.kind === 'entry' ? r.entry.kind === 'folder' : r.isFolder)
                    ? 'folder'
                    : r.kind === 'entry' && isApp(r.entry)
                      ? 'app'
                      : 'file'
                }
              />
              <span className="qs-text">
                <b>{r.kind === 'entry' ? r.entry.name : r.name}</b>
                <small>{r.kind === 'entry' ? r.entry.path : r.folder}</small>
              </span>
              {i === sel && (
                <span className="qs-hint">{tr('Enter to open')}</span>
              )}
            </div>
          </div>
        ))}
        {!rows.length && (
          <div className="qs-empty">
            {q.trim()
              ? tr('Nothing found.')
              : tr(
                  'Your Catalog is empty. Add apps, files and folders in WorkSync’s Catalog.',
                )}
          </div>
        )}
      </div>
      {(error || status) && (
        <div className={`qs-msg ${error ? 'error' : ''}`} role="status">
          {error ?? status}
        </div>
      )}
      <div className="qs-keys">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>{tr('Enter')}</kbd> open
        </span>
        <span>
          <kbd>{tr('Ctrl')}</kbd>+<kbd>{tr('Enter')}</kbd>{' '}
          {tr('show in folder')}
        </span>
        <span>
          <kbd>{tr('Ctrl')}</kbd>+<kbd>C</kbd> {tr('copy path')}
        </span>
        <span className="grow" />
        <span>
          <kbd>{tr('Esc')}</kbd> close
        </span>
      </div>
    </div>
  );
}
