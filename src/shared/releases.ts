/**
 * Releases of the software a project delivers: per product, a history of
 * releases (date, version, summary, purpose, changes, verification), and the
 * modules each release delivers, with their version per destination, category
 * and environment.
 *
 * Free of Node.js and Electron imports: the view and the Excel export share it.
 */

export interface ReleaseModule {
  id: string;
  /** 仕向け先: where it is delivered. */
  destination: string;
  /** カテゴリ */
  category: string;
  /** 種別: the edition or kind. */
  type: string;
  /** モジュール: the module's name. */
  module: string;
  /** ファイル名: the file delivered, if it differs from the module name. */
  fileName: string;
  /** 環境: Dev, Stg, Prod… */
  environment: string;
  version: string;
  /** What changed in this file; empty: the release's text stands for it. */
  changes: string;
  /** Why this file changed. */
  purpose: string;
  /** How this file was checked. */
  verification: string;
  /** The project's own file fields (Ticket No.…), by field key. */
  extra: Record<string, string>;
}

export type ReleaseStatus = 'planned' | 'released';

export interface Release {
  id: string;
  projectId: string;
  /** The product or component the release is of (OCX_DLL, EMVCon…). */
  product: string;
  /** 対象版: the edition it is for. */
  target: string;
  /** リリース日, YYYY-MM-DD; may be empty while planned. */
  releasedOn: string | null;
  version: string;
  status: ReleaseStatus;
  /** 概要 */
  summary: string;
  /** 目的 */
  purpose: string;
  /** 内容（改善点／変更点等） */
  changes: string;
  /** 検証 */
  verification: string;
  modules: ReleaseModule[];
  createdAt: string;
  updatedAt: string;
}

export type ReleaseInput = Omit<
  Release,
  'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'modules'
> & {
  /** A module with its id keeps it (and so its place in merges). */
  modules: (Omit<ReleaseModule, 'id'> & { id?: string })[];
};

/** A field the project adds to each released file. */
export interface ReleaseField {
  /** How it is written in templates and kept: ticket_no. */
  key: string;
  /** How it is shown: Ticket No. */
  name: string;
}

/** The project's lists to pick from, in the order they are shown and exported. */
export interface ReleaseLists {
  products: string[];
  /** 対象版 and 種別 */
  editions: string[];
  destinations: string[];
  categories: string[];
  environments: string[];
  /** The project's own fields on each file. */
  fields: ReleaseField[];
}

export const DEFAULT_RELEASE_LISTS: ReleaseLists = {
  products: [],
  editions: [],
  destinations: [],
  categories: [],
  environments: ['Dev', 'Stg', 'Prod'],
  fields: [],
};

/** The key a field name is kept under: `Ticket No.` → `ticket_no`. */
export function fieldKey(name: string): string {
  const k = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return k || 'field';
}

/** The text a file shows for what changed, why and how it was checked. */
export interface FileInfo {
  changes: string;
  purpose: string;
  verification: string;
  /** True where the text is the release's, the file having none of its own. */
  fromRelease: { changes: boolean; purpose: boolean; verification: boolean };
}

export function fileInfo(r: Release, m: ReleaseModule): FileInfo {
  const pick = (k: 'changes' | 'purpose' | 'verification') =>
    m[k].trim() ? [m[k], false] : [r[k], !!r[k].trim()];
  const [changes, c] = pick('changes');
  const [purpose, p] = pick('purpose');
  const [verification, v] = pick('verification');
  return {
    changes: changes as string,
    purpose: purpose as string,
    verification: verification as string,
    fromRelease: {
      changes: c as boolean,
      purpose: p as boolean,
      verification: v as boolean,
    },
  };
}

export const EMPTY_MODULE: Omit<ReleaseModule, 'id'> = {
  destination: '',
  category: '',
  type: '',
  module: '',
  fileName: '',
  environment: '',
  version: '',
  changes: '',
  purpose: '',
  verification: '',
  extra: {},
};

/** Released ones, oldest first; planned ones (no date yet) after, by when they were added. */
export function byDate(list: Release[]): Release[] {
  return [...list].sort((a, b) => {
    const da = a.status === 'released' && a.releasedOn ? a.releasedOn : '9999';
    const db = b.status === 'released' && b.releasedOn ? b.releasedOn : '9999';
    return (
      da.localeCompare(db) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
    );
  });
}

const released = (list: Release[]) =>
  byDate(list).filter((r) => r.status === 'released' && r.releasedOn);

/** A module's name as it is shown: its name, else its file. */
export const moduleName = (m: Pick<ReleaseModule, 'module' | 'fileName'>) =>
  m.module.trim() || m.fileName.trim();

/** Orders by a list first (its order), then by name. */
const inOrder = (order: string[]) => (a: string, b: string) => {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia >= 0 || ib >= 0)
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b);
  return a.localeCompare(b, undefined, { numeric: true });
};

export interface MatrixRow {
  destination: string;
  category: string;
  module: string;
  environment: string;
  /** One value per date: the version in use then ('' before the first release). */
  versions: string[];
  /** Where the version changed on that date. */
  changed: boolean[];
}

/**
 * The version matrix: a row per destination, category, module and
 * environment, a column per release date (oldest first). Each cell is the
 * version in use on that date: a release that does not deliver the module
 * leaves its last version.
 */
export function versionMatrix(
  list: Release[],
  lists: ReleaseLists,
): { dates: string[]; rows: MatrixRow[] } {
  // Only releases that deliver files make a column; a file without a
  // name has a row of its own ("No info" where it is shown).
  const rel = released(list).filter((r) => r.modules.length > 0);
  const dates = [...new Set(rel.map((r) => r.releasedOn!))];
  const rows = new Map<string, MatrixRow>();
  for (const r of rel)
    for (const m of r.modules) {
      const k = moduleKey(m);
      if (!rows.has(k))
        rows.set(k, {
          destination: m.destination,
          category: m.category,
          module: moduleName(m),
          environment: m.environment,
          versions: dates.map(() => ''),
          changed: dates.map(() => false),
        });
      const row = rows.get(k)!;
      const at = dates.indexOf(r.releasedOn!);
      row.versions[at] = m.version;
      row.changed[at] = true;
    }
  // Carry each version forward to the dates after it.
  for (const row of rows.values())
    for (let i = 1; i < dates.length; i++)
      if (!row.changed[i]) row.versions[i] = row.versions[i - 1];
  const d = inOrder(lists.destinations);
  const c = inOrder(lists.categories);
  const e = inOrder(lists.environments);
  const sorted = [...rows.values()].sort(
    (a, b) =>
      d(a.destination, b.destination) ||
      c(a.category, b.category) ||
      a.module.localeCompare(b.module, undefined, { numeric: true }) ||
      e(a.environment, b.environment),
  );
  return { dates, rows: sorted };
}

export interface LatestModule {
  type: string;
  module: string;
  environment: string;
  version: string;
  releasedOn: string;
  product: string;
}

/** The newest version of each module (by kind, module or file, and environment). */
export function latestModules(
  list: Release[],
  lists: ReleaseLists,
): LatestModule[] {
  const latest = new Map<string, LatestModule>();
  // Matched by module name; shown by its file, the newest one known.
  const fileOf = new Map<string, string>();
  for (const r of released(list))
    for (const m of r.modules) {
      // A file without a name is kept, by where it went ("No info" where shown).
      const name = moduleName(m);
      const k = [m.type, name, m.environment, name ? '' : moduleKey(m)].join(
        '\u0000',
      );
      if (m.fileName.trim()) fileOf.set(k, m.fileName.trim());
      latest.set(k, {
        type: m.type,
        module: fileOf.get(k) ?? name,
        environment: m.environment,
        version: m.version,
        releasedOn: r.releasedOn!,
        product: r.product,
      });
    }
  const t = inOrder(lists.editions);
  const e = inOrder(lists.environments);
  return [...latest.values()].sort(
    (a, b) =>
      t(a.type, b.type) ||
      a.module.localeCompare(b.module, undefined, { numeric: true }) ||
      e(a.environment, b.environment),
  );
}

/** The products releases are of: the list's order first, then any others. */
export function productsOf(list: Release[], lists: ReleaseLists): string[] {
  const all = new Set([...lists.products, ...list.map((r) => r.product)]);
  return [...all].filter(Boolean).sort(inOrder(lists.products));
}

/** `2026-11-12` → `2026/11/12`, as the release sheets write dates. */
export const sheetDate = (d: string | null) =>
  d ? d.replaceAll('-', '/') : '';

/** The same module in the same place: destination, category, name and environment. */
export const moduleKey = (m: ReleaseModule) =>
  [m.destination, m.category, moduleName(m), m.environment].join('\u0000');

/**
 * The version of this module before this release: from the newest earlier
 * released release that delivered it ('' when this is its first).
 */
export function previousVersion(
  list: Release[],
  r: Release,
  m: ReleaseModule,
): string {
  const k = moduleKey(m);
  const sorted = byDate(list);
  const at = sorted.findIndex((x) => x.id === r.id);
  for (let i = (at < 0 ? sorted.length : at) - 1; i >= 0; i--) {
    const x = sorted[i];
    if (x.status !== 'released' || !x.releasedOn) continue;
    const hit = x.modules.find((y) => moduleKey(y) === k);
    if (hit) return hit.version;
  }
  return '';
}
