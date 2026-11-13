/**
 * The Catalog: apps, files and folders the owner opens often, with tags,
 * notes and favorites, and file search with Everything on Windows. The
 * functions follow FileManagement's Catalog.
 */

export type EntryKind = 'file' | 'folder';

export interface CatalogEntry {
  id: string;
  kind: EntryKind;
  /** What the owner calls it; defaults to the file or folder name. */
  name: string;
  path: string;
  tags: string[];
  note: string;
  favorite: boolean;
  addedAt: string;
  lastOpened: string | null;
  /** The path was not found when the list was last read. */
  missing: boolean;
}

export type CatalogEntryInput = Pick<
  CatalogEntry,
  'kind' | 'name' | 'path' | 'tags' | 'note' | 'favorite'
>;

export type CatalogFilter =
  | 'all'
  | 'apps'
  | 'files'
  | 'folders'
  | 'favorites'
  | 'missing';
export type CatalogSort = 'lastOpened' | 'name' | 'kind' | 'added';
/** Where the Catalog page searches: saved entries, files on the PC, or both. */
export type SearchSource = 'catalog' | 'everything' | 'both';

/** A file or folder found by Everything. */
export interface EverythingResult {
  path: string;
  name: string;
  folder: string;
  isFolder: boolean;
  /** Already in the Catalog. */
  saved: boolean;
}

export type EverythingState =
  /** Searched; results may be empty. */
  | 'ok'
  /** Everything is starting or building its index. */
  | 'starting'
  /** Not found, or it could not start. */
  | 'unavailable'
  /** Turned off in Settings. */
  | 'off'
  /** Not on Windows. */
  | 'unsupported';

export interface EverythingAnswer {
  state: EverythingState;
  results: EverythingResult[];
}

const APP_EXT = /\.(exe|lnk|bat|cmd|msi|appref-ms|url|app)$/i;

/** An entry that starts a program, shown as an app. */
export const isApp = (e: Pick<CatalogEntry, 'kind' | 'path'>): boolean =>
  e.kind === 'file' && APP_EXT.test(e.path);

/** The last part of a path: the file or folder name. */
export const baseName = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;

/** The folder a path is in. */
export const folderOf = (p: string): string => {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  return i > 0 ? t.slice(0, i) : t;
};

/** A path compared without case, trailing slashes or the other kind of slash. */
export const pathKey = (p: string): string =>
  p
    .trim()
    .replace(/[\\/]+$/, '')
    .replaceAll('/', '\\')
    .toLowerCase();

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle);

/** Search: the name, file or folder name, full path, tags and note. */
export function matchesEntry(e: CatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    has(e.name, q) ||
    has(baseName(e.path), q) ||
    has(e.path, q) ||
    e.tags.some((t) => has(t, q)) ||
    has(e.note, q)
  );
}

export function passesFilter(e: CatalogEntry, f: CatalogFilter): boolean {
  switch (f) {
    case 'apps':
      return isApp(e);
    case 'files':
      return e.kind === 'file' && !isApp(e);
    case 'folders':
      return e.kind === 'folder';
    case 'favorites':
      return e.favorite;
    case 'missing':
      return e.missing;
    default:
      return true;
  }
}

const kindRank = (e: CatalogEntry) =>
  isApp(e) ? 0 : e.kind === 'file' ? 1 : 2;

/** Favorites first, then the chosen order. */
export function sortEntries(
  list: CatalogEntry[],
  sort: CatalogSort,
): CatalogEntry[] {
  const byName = (a: CatalogEntry, b: CatalogEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return [...list].sort(
    (a, b) =>
      Number(b.favorite) - Number(a.favorite) ||
      (sort === 'name'
        ? byName(a, b)
        : sort === 'kind'
          ? kindRank(a) - kindRank(b) || byName(a, b)
          : sort === 'added'
            ? b.addedAt.localeCompare(a.addedAt)
            : (b.lastOpened ?? '').localeCompare(a.lastOpened ?? '') ||
              b.addedAt.localeCompare(a.addedAt)),
  );
}

const lettersAndDigits = (s: string) =>
  [...s].filter((c) => /[\p{L}\p{N}]/u.test(c)).join('');

/** Splits where letters meet digits: "wbs2026v2" → wbs, 2026, v, 2. */
function segments(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  const kind = (c: string) => (/\p{N}/u.test(c) ? 'n' : 'l');
  for (const c of lettersAndDigits(s)) {
    if (cur && kind(cur[cur.length - 1]) !== kind(c)) {
      out.push(cur);
      cur = '';
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The searches sent to Everything for one query, as FileManagement does:
 * the query, the query without punctuation, and its parts in any order (a b)
 * or in order with anything between (a*b).
 */
export function everythingQueries(query: string): string[] {
  const out: string[] = [];
  const add = (q: string) => {
    const t = q.trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  const q = query.trim();
  add(q);
  const collapsed = lettersAndDigits(q);
  add(collapsed);
  for (const v of [q, collapsed]) {
    const parts = segments(v);
    if (parts.length <= 1) continue;
    add(parts.join(' '));
    add(parts.join('*'));
  }
  return out;
}

/** Accelerator text such as CommandOrControl+Shift+F, shown as Ctrl + Shift + F. */
export function shortcutLabel(accel: string | null, mac = false): string {
  if (!accel) return 'Off';
  return accel
    .split('+')
    .map((k) =>
      k === 'CommandOrControl'
        ? mac
          ? '⌘'
          : 'Ctrl'
        : k === 'Super'
          ? 'Win'
          : k,
    )
    .join(' + ');
}

/**
 * The accelerator for a key press, or null when it is not a usable
 * shortcut: it needs Ctrl or Alt (or ⌘) and one other key.
 */
export function acceleratorFor(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) return null;
  const mods = [
    e.ctrlKey || e.metaKey ? 'CommandOrControl' : '',
    e.altKey ? 'Alt' : '',
    e.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  if (!mods.some((m) => m === 'CommandOrControl' || m === 'Alt')) return null;
  let key = '';
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else if (e.code === 'Space') key = 'Space';
  else if (e.code === 'Backquote') key = '`';
  else return null;
  return [...mods, key].join('+');
}
