import ExcelJS from 'exceljs';
import {
  DATA_SHEET,
  IMPORT_COLUMNS,
  columnOf,
  headingKey,
  type ImportColumn,
} from '../shared/releaseFormat';
import {
  fieldKey,
  moduleName,
  type Release,
  type ReleaseInput,
  type ReleaseLists,
} from '../shared/releases';
import type {
  ReleaseImportFile,
  ReleaseImportPlan,
  ReleaseImportRelease,
} from '../shared/releaseImportTypes';
import type { Releases } from './releases';

const MAX_ROWS = 20_000;

/** A cell's value as text: rich text, formulas, links and dates included. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isoDate(v);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText))
      return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if ('text' in o) return String(o.text ?? '');
    if ('error' in o) return '';
    return '';
  }
  return String(v);
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

const realDate = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d
    ? isoDate(t)
    : null;
};

/** A release date from a cell: an Excel date, a day number, or 2026/08/21 and the like. */
export function parseDate(v: ExcelJS.CellValue): {
  date: string | null;
  bad: boolean;
} {
  if (v === null || v === undefined || v === '')
    return { date: null, bad: false };
  if (v instanceof Date) return { date: isoDate(v), bad: false };
  if (typeof v === 'number') {
    // Excel's day number: day 1 is 1900-01-01, with its 1900 leap-year slip.
    if (v > 20000 && v < 80000) {
      const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
      return { date: isoDate(t), bad: false };
    }
    return { date: null, bad: true };
  }
  const s = cellText(v).normalize('NFKC').trim();
  if (!s) return { date: null, bad: false };
  const m = /^(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?/.exec(
    s,
  );
  const date = m ? realDate(+m[1], +m[2], +m[3]) : null;
  return date ? { date, bad: false } : { date: null, bad: true };
}

const statusOf = (s: string, date: string | null): 'released' | 'planned' => {
  const t = s.normalize('NFKC').trim().toLowerCase();
  if (/planned|plan|予定|未/.test(t)) return 'planned';
  if (t) return 'released';
  return date ? 'released' : 'planned';
};

interface Found {
  sheet: ExcelJS.Worksheet;
  headerRow: number;
  cols: Map<ImportColumn, number>;
  unknown: { col: number; name: string }[];
  ownExport: boolean;
}

/** The sheet and heading row that look most like the import format. */
function findTable(wb: ExcelJS.Workbook): Found | null {
  let best: (Found & { score: number }) | null = null;
  for (const sheet of wb.worksheets) {
    const own = [DATA_SHEET.ja, DATA_SHEET.en].includes(sheet.name);
    const last = Math.min(sheet.rowCount, 30);
    for (let r = 1; r <= last; r++) {
      const cols = new Map<ImportColumn, number>();
      const unknown: { col: number; name: string }[] = [];
      const row = sheet.getRow(r);
      const width = Math.min(row.cellCount, 200);
      for (let c = 1; c <= width; c++) {
        const name = cellText(row.getCell(c).value).trim();
        if (!name) continue;
        const key = columnOf(name);
        if (key && !cols.has(key)) cols.set(key, c);
        else if (!key) unknown.push({ col: c, name });
      }
      const usable =
        cols.has('version') &&
        cols.has('product') &&
        (cols.has('date') || cols.has('fileName') || cols.has('module'));
      if (!usable) continue;
      // A table with rows under its headings beats an empty one.
      const filled = sheet.rowCount > r ? 100 : 0;
      const score = cols.size * 10 - unknown.length + filled + (own ? 1000 : 0);
      if (!best || score > best.score)
        best = { sheet, headerRow: r, cols, unknown, ownExport: own, score };
    }
  }
  return best;
}

/**
 * Reads a workbook in the import format (or the app's own release export)
 * into what an import would add, without saving anything.
 */
export async function readReleaseImport(
  data: Uint8Array,
  fileName: string,
  existing: Release[],
  lists: ReleaseLists,
): Promise<ReleaseImportPlan> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(
      data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer,
    );
  } catch {
    throw new Error(
      'This file is not an Excel workbook (.xlsx), or it is damaged.',
    );
  }
  const found = findTable(wb);
  if (!found)
    throw new Error(
      'No release table was found: the first rows need the headings Product and Release version, and Release date or File name.',
    );
  const { sheet, headerRow, cols, ownExport } = found;
  const at = (row: ExcelJS.Row, k: ImportColumn) =>
    cols.has(k) ? row.getCell(cols.get(k)!).value : null;
  const text = (row: ExcelJS.Row, k: ImportColumn) =>
    cellText(at(row, k)).trim();
  // Unknown headings are the project's own fields: known ones by name or key.
  const unknown = found.unknown.map((u) => {
    const key = fieldKey(u.name);
    const known = lists.fields.find(
      (f) => f.key === key || headingKey(f.name) === headingKey(u.name),
    );
    return { ...u, key: known?.key ?? key, known: !!known };
  });

  const problems: ReleaseImportPlan['problems'] = [];
  const groups = new Map<string, ReleaseImportRelease>();
  let rows = 0;
  let merged = 0;
  const last = Math.min(sheet.rowCount, headerRow + MAX_ROWS);
  for (let r = headerRow + 1; r <= last; r++) {
    const row = sheet.getRow(r);
    const values = IMPORT_COLUMNS.map((c) => text(row, c.key));
    const extra: Record<string, string> = {};
    for (const u of unknown) {
      const v = cellText(row.getCell(u.col).value).trim();
      if (v) extra[u.key] = v;
    }
    if (values.every((v) => !v) && !Object.keys(extra).length) continue;
    rows++;
    const d = parseDate(at(row, 'date'));
    if (d.bad) {
      problems.push({ row: r, code: 'date', value: text(row, 'date') });
      continue;
    }
    const product = text(row, 'product');
    const version = text(row, 'version');
    if (!product) {
      problems.push({ row: r, code: 'noProduct', value: '' });
      continue;
    }
    if (!version) {
      problems.push({ row: r, code: 'noVersion', value: '' });
      continue;
    }
    const status = statusOf(text(row, 'status'), d.date);
    if (status === 'released' && !d.date) {
      problems.push({ row: r, code: 'noDate', value: '' });
      continue;
    }
    const file: ReleaseImportFile = {
      fileName: text(row, 'fileName'),
      module: text(row, 'module'),
      type: text(row, 'type'),
      destination: text(row, 'destination'),
      category: text(row, 'category'),
      environment: text(row, 'environment'),
      version: text(row, 'fileVersion'),
      changes: cellText(at(row, 'changes')).trim(),
      purpose: cellText(at(row, 'purpose')).trim(),
      verification: cellText(at(row, 'verification')).trim(),
      extra,
    };
    const fileOnly =
      file.type ||
      file.destination ||
      file.category ||
      file.environment ||
      file.version ||
      Object.keys(extra).length;
    // A file without a name or module is still a file ("No info" where shown).
    const hasFile = !!(file.fileName || file.module || fileOnly);
    const key = [
      product.toLowerCase(),
      version.toLowerCase(),
      d.date ?? '',
    ].join('\u0000');
    let g = groups.get(key);
    if (!g) {
      const match = existing.find(
        (x) =>
          x.product.toLowerCase() === product.toLowerCase() &&
          x.version.toLowerCase() === version.toLowerCase() &&
          (x.releasedOn ?? '') === (d.date ?? ''),
      );
      g = {
        key,
        product,
        version,
        target: '',
        releasedOn: d.date,
        status,
        summary: '',
        purpose: '',
        changes: '',
        verification: '',
        files: [],
        match: match ? match.id : null,
      };
      groups.set(key, g);
    }
    if (!g.target) g.target = text(row, 'edition');
    if (!g.summary) g.summary = text(row, 'summary');
    if (status === 'planned') g.status = 'planned';
    const texts = ['changes', 'purpose', 'verification'] as const;
    if (hasFile) {
      const f = { ...file, type: file.type || text(row, 'edition') };
      // The same file twice in a release (from two sheets put together) is one file.
      const same = g.files.find((x) => fileKey(x) === fileKey(f));
      if (same) {
        merged++;
        for (const k of texts) same[k] = joinText(same[k], f[k]);
        for (const [k, v] of Object.entries(f.extra))
          same.extra[k] = joinText(same.extra[k] ?? '', v);
      } else g.files.push(f);
    } else {
      if (texts.some((k) => g[k]) && texts.some((k) => file[k])) merged++;
      for (const k of texts) g[k] = joinText(g[k], file[k]);
    }
  }
  if (sheet.rowCount > last)
    problems.push({ row: last + 1, code: 'tooMany', value: String(MAX_ROWS) });
  const columns = [...cols.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k);
  return {
    fileName,
    sheet: sheet.name,
    rows,
    ownExport,
    merged,
    columns,
    unknown: unknown.map(({ name, key, known }) => ({ name, key, known })),
    releases: [...groups.values()].sort(
      (a, b) =>
        (a.releasedOn ?? '9999').localeCompare(b.releasedOn ?? '9999') ||
        a.product.localeCompare(b.product),
    ),
    problems,
  };
}

export type ImportMode = 'skip' | 'update' | 'replace';

/** A file in a release: its name, place, environment and version. */
const fileKey = (f: ReleaseImportFile) =>
  [
    moduleName(f),
    f.fileName,
    f.destination,
    f.category,
    f.environment,
    f.version,
  ]
    .map((x) => x.trim().toLowerCase())
    .join('\u0000');

/** Two texts for the same thing: both, once each, the first one first. */
export function joinText(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  if (!y || x.includes(y)) return a;
  if (!x || y.includes(x)) return b;
  return `${x}\n${y}`;
}

const sameFile = (a: ReleaseImportFile, b: Release['modules'][number]) =>
  moduleName(a).toLowerCase() === moduleName(b).toLowerCase() &&
  a.environment.toLowerCase() === b.environment.toLowerCase() &&
  a.destination.toLowerCase() === b.destination.toLowerCase() &&
  a.category.toLowerCase() === b.category.toLowerCase();

/**
 * Saves what the plan adds, in one transaction. Fields named in `fields`
 * join the project's file fields; other unknown columns are left out.
 */
export function applyReleaseImport(
  store: Releases,
  projectId: string,
  plan: ReleaseImportPlan,
  o: { mode: ImportMode; fields: string[] },
): { added: number; updated: number; skipped: number } {
  return store.inOne(() => {
    let added = 0;
    let updated = 0;
    let skipped = 0;
    if (o.mode === 'replace') store.deleteAll(projectId);
    const lists = store.getLists(projectId);
    for (const u of plan.unknown)
      if (
        o.fields.includes(u.key) &&
        !lists.fields.some((f) => f.key === u.key)
      )
        lists.fields.push({ key: u.key, name: u.name });
    store.saveLists(projectId, lists);
    const allowed = new Set(lists.fields.map((f) => f.key));
    const extraOf = (f: ReleaseImportFile) =>
      Object.fromEntries(
        Object.entries(f.extra).filter(([k]) => allowed.has(k)),
      );
    for (const r of plan.releases) {
      const match = o.mode === 'replace' ? null : r.match;
      if (match && o.mode === 'skip') {
        skipped++;
        continue;
      }
      if (match) {
        let old: Release;
        try {
          old = store.get(match);
        } catch {
          old = null as unknown as Release;
        }
        if (old) {
          // Filled in and changed from the file; what it leaves empty stays.
          const modules: ReleaseInput['modules'] = old.modules.map((m) => ({
            ...m,
          }));
          for (const f of r.files) {
            const hit = modules.find((m) => sameFile(f, m as never));
            const patch = Object.fromEntries(
              (
                [
                  'fileName',
                  'module',
                  'type',
                  'version',
                  'changes',
                  'purpose',
                  'verification',
                ] as const
              )
                .filter((k) => f[k])
                .map((k) => [k, f[k]]),
            );
            if (hit)
              Object.assign(hit, patch, {
                extra: { ...hit.extra, ...extraOf(f) },
              });
            else modules.push({ ...f, extra: extraOf(f) });
          }
          store.save(
            projectId,
            {
              product: old.product,
              version: old.version,
              releasedOn: old.releasedOn,
              status: r.status === 'planned' ? old.status : r.status,
              target: r.target || old.target,
              summary: r.summary || old.summary,
              purpose: r.purpose || old.purpose,
              changes: r.changes || old.changes,
              verification: r.verification || old.verification,
              modules,
            },
            old.id,
            false,
          );
          updated++;
          continue;
        }
      }
      store.save(
        projectId,
        {
          product: r.product,
          version: r.version,
          releasedOn: r.releasedOn,
          status: r.status,
          target: r.target,
          summary: r.summary,
          purpose: r.purpose,
          changes: r.changes,
          verification: r.verification,
          modules: r.files.map((f) => ({ ...f, extra: extraOf(f) })),
        },
        undefined,
        false,
      );
      added++;
    }
    return { added, updated, skipped };
  });
}

/** An empty sheet in the import format, with an example on a second sheet. */
export async function importSheet(language: 'ja' | 'en'): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkSync';
  const heads = IMPORT_COLUMNS.map((c) => (language === 'ja' ? c.ja : c.en));
  const style = (ws: ExcelJS.Worksheet) => {
    const h = ws.getRow(1);
    h.font = { name: 'Meiryo UI', bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F497D' },
    };
    h.alignment = { vertical: 'middle', wrapText: true };
    IMPORT_COLUMNS.forEach((c, i) => {
      ws.getColumn(i + 1).width = [
        'changes',
        'purpose',
        'verification',
        'summary',
      ].includes(c.key)
        ? 36
        : 16;
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const main = wb.addWorksheet(language === 'ja' ? 'リリース' : 'Releases');
  main.addRow(heads);
  style(main);
  const ex = wb.addWorksheet(language === 'ja' ? '記入例' : 'Example');
  ex.addRow(heads);
  ex.addRow([
    '2026/08/21',
    'EMVCon',
    'Target A',
    '5.5.0',
    'Released',
    'New payment terminal',
    'FakeFile_21.dll',
    'Module X',
    'Target A',
    'Destination C',
    'Category 4',
    'Prod',
    '7300_100200',
    'Added the new terminal.',
    'Customer request',
    'Stg test passed',
  ]);
  ex.addRow([
    '2026/08/21',
    'EMVCon',
    'Target A',
    '5.5.0',
    'Released',
    'New payment terminal',
    'FakeFile_34.exe',
    'Module W',
    'Target A',
    'Destination C',
    'Category 1',
    'Prod',
    '2.4.0',
    '',
    '',
    '',
  ]);
  ex.addRow([
    '',
    'EMVCon',
    'Target A',
    '6.0.0',
    'Planned',
    'Next major release',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'Support the new card brand.',
    '',
  ]);
  style(ex);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
