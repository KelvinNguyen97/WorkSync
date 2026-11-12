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
> & { modules: Omit<ReleaseModule, 'id'>[] };

/** The project's lists to pick from, in the order they are shown and exported. */
export interface ReleaseLists {
  products: string[];
  /** 対象版 and 種別 */
  editions: string[];
  destinations: string[];
  categories: string[];
  environments: string[];
}

export const DEFAULT_RELEASE_LISTS: ReleaseLists = {
  products: [],
  editions: [],
  destinations: [],
  categories: [],
  environments: ['Dev', 'Stg', 'Prod'],
};

export const EMPTY_MODULE: Omit<ReleaseModule, 'id'> = {
  destination: '',
  category: '',
  type: '',
  module: '',
  fileName: '',
  environment: '',
  version: '',
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
  // Only releases that deliver modules make a column.
  const rel = released(list).filter((r) =>
    r.modules.some((m) => moduleName(m)),
  );
  const dates = [...new Set(rel.map((r) => r.releasedOn!))];
  const key = (m: ReleaseModule) =>
    [m.destination, m.category, moduleName(m), m.environment].join('\u0000');
  const rows = new Map<string, MatrixRow>();
  for (const r of rel)
    for (const m of r.modules) {
      if (!moduleName(m)) continue;
      const k = key(m);
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
      const name = moduleName(m);
      if (!name) continue;
      const k = [m.type, name, m.environment].join('\u0000');
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
