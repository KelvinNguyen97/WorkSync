import ExcelJS from 'exceljs';
import { DATA_SHEET, IMPORT_COLUMNS } from '../shared/releaseFormat';
import {
  byDate,
  latestModules,
  productsOf,
  sheetDate,
  versionMatrix,
  type Release,
  type ReleaseLists,
} from '../shared/releases';

/**
 * The releases of a project as an Excel workbook, laid out like the release
 * sheets customers are used to:
 * 1. the module version list for the customer: a row per destination,
 *    category, module and environment, a column per release date, each cell
 *    the version in use then;
 * 2. the release module version table: the newest version of each module;
 * 3. one release history per product, oldest first.
 */

export type ReleaseSheetLanguage = 'ja' | 'en';

const WORDS = {
  ja: {
    matrix: 'モジュールバージョン一覧',
    matrixTitle: (customer: string) =>
      `モジュールバージョン一覧${customer ? `（${customer}様 提出用）` : ''}`,
    destination: '仕向け先',
    category: 'カテゴリ',
    module: 'モジュール',
    environment: '環境',
    fileVersion: 'ファイル名 / バージョン',
    list: 'リリースモジュール一覧',
    listTitle: (project: string) =>
      `${project} リリースモジュールバージョン管理表`,
    no: 'No.',
    type: '種別',
    moduleFile: 'モジュール／ファイル名',
    date: 'リリース日',
    version: 'バージョン',
    history: (product: string) => `リリース履歴一覧(${product})`,
    historyTitle: (product: string) => `${product} リリース履歴（旧→新）`,
    target: '対象版',
    releaseVersion: 'リリースバージョン',
    summary: '概要',
    purpose: '目的',
    changes: '内容（改善点／変更点等）',
    verification: '検証',
    none: 'リリースはまだありません。',
    noInfo: '情報なし',
  },
  en: {
    matrix: 'Module versions',
    matrixTitle: (customer: string) =>
      `Module versions${customer ? ` (for ${customer})` : ''}`,
    destination: 'Destination',
    category: 'Category',
    module: 'Module',
    environment: 'Environment',
    fileVersion: 'File / version',
    list: 'Release modules',
    listTitle: (project: string) => `${project}: release module versions`,
    no: 'No.',
    type: 'Type',
    moduleFile: 'Module / file name',
    date: 'Release date',
    version: 'Version',
    history: (product: string) => `Release history (${product})`,
    historyTitle: (product: string) => `${product} release history (old → new)`,
    target: 'Edition',
    releaseVersion: 'Release version',
    summary: 'Summary',
    purpose: 'Purpose',
    changes: 'Changes (improvements, changes)',
    verification: 'Verification',
    none: 'No releases yet.',
    noInfo: 'No info',
  },
};

const FONT = 'Meiryo UI';
const NAVY = 'FF1F497D';
const GREY = 'FFD9D9D9';
const thin = { style: 'thin' as const, color: { argb: 'FF808080' } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };

/** A sheet name Excel accepts: at most 31 characters, none of []:*?/\, unique. */
export function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet';
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++)
    n = `${base.slice(0, 31 - String(i).length - 1)}_${i}`;
  used.add(n.toLowerCase());
  return n;
}

function print(ws: ExcelJS.Worksheet) {
  ws.pageSetup = {
    paperSize: 9,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: {
      left: 0.4,
      right: 0.4,
      top: 0.5,
      bottom: 0.5,
      header: 0.3,
      footer: 0.3,
    },
  };
}

const title = (ws: ExcelJS.Worksheet, cell: string, text: string) => {
  const c = ws.getCell(cell);
  c.value = text;
  c.font = { name: FONT, size: 14, bold: true };
};

const head = (c: ExcelJS.Cell, text: string | Date, navy: boolean) => {
  c.value = text;
  c.font = {
    name: FONT,
    bold: true,
    color: { argb: navy ? 'FFFFFFFF' : 'FF000000' },
  };
  c.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: navy ? NAVY : GREY },
  };
  c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  c.border = BOX;
};

const body = (
  c: ExcelJS.Cell,
  text: string | number,
  o: { bold?: boolean } = {},
) => {
  c.value = text;
  c.font = { name: FONT, bold: !!o.bold };
  c.alignment = { vertical: 'top', wrapText: true };
  c.border = BOX;
};

export async function releaseWorkbook(o: {
  project: string;
  customer: string;
  releases: Release[];
  lists: ReleaseLists;
  language: ReleaseSheetLanguage;
  /** Planned releases in the history sheets too. */
  includePlanned?: boolean;
  /** In the version list, only the versions released that day. */
  onlyChanged?: boolean;
}): Promise<Uint8Array> {
  const w = WORDS[o.language];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkSync';
  const used = new Set<string>();

  // 1. The module version list: a column per release date.
  const { dates, rows } = versionMatrix(o.releases, o.lists);
  const m = wb.addWorksheet(sheetName(w.matrix, used));
  title(m, 'A1', w.matrixTitle(o.customer));
  [w.destination, w.category, w.module, w.environment].forEach((t, i) => {
    head(m.getCell(3, i + 1), t, true);
    head(m.getCell(4, i + 1), '', true);
    m.mergeCells(3, i + 1, 4, i + 1);
  });
  if (dates.length) {
    head(m.getCell(3, 5), w.fileVersion, true);
    for (let i = 1; i < dates.length; i++) head(m.getCell(3, 5 + i), '', true);
    if (dates.length > 1) m.mergeCells(3, 5, 3, 4 + dates.length);
    dates.forEach((d, i) => head(m.getCell(4, 5 + i), sheetDate(d), true));
  }
  rows.forEach((r, k) => {
    const row = 5 + k;
    body(m.getCell(row, 1), r.destination, { bold: true });
    body(m.getCell(row, 2), r.category, { bold: true });
    body(m.getCell(row, 3), r.module || w.noInfo);
    body(m.getCell(row, 4), r.environment);
    r.versions.forEach((v, i) =>
      body(m.getCell(row, 5 + i), o.onlyChanged && !r.changed[i] ? '' : v),
    );
  });
  // Rows of the same destination, and of the same category in it, share one cell.
  const group = (col: number, same: (a: number, b: number) => boolean) => {
    for (let start = 0; start < rows.length;) {
      let end = start;
      while (end + 1 < rows.length && same(start, end + 1)) end++;
      if (end > start) m.mergeCells(5 + start, col, 5 + end, col);
      start = end + 1;
    }
  };
  group(1, (a, b) => rows[a].destination === rows[b].destination);
  group(
    2,
    (a, b) =>
      rows[a].destination === rows[b].destination &&
      rows[a].category === rows[b].category,
  );
  [26, 23, 22, 14].forEach((wd, i) => (m.getColumn(i + 1).width = wd));
  dates.forEach((_, i) => (m.getColumn(5 + i).width = 16));
  m.views = [{ state: 'frozen', xSplit: 4, ySplit: 4 }];
  if (!rows.length) m.getCell('A5').value = w.none;
  print(m);

  // 2. The newest version of each module.
  const latest = latestModules(o.releases, o.lists);
  const l = wb.addWorksheet(sheetName(w.list, used));
  title(l, 'B2', w.listTitle(o.project));
  [w.no, w.type, w.moduleFile, w.date, w.version, w.environment].forEach(
    (t, i) => head(l.getCell(3, 2 + i), t, false),
  );
  latest.forEach((x, k) => {
    const row = 4 + k;
    body(l.getCell(row, 2), k + 1);
    body(l.getCell(row, 3), x.type);
    body(l.getCell(row, 4), x.module || w.noInfo);
    body(l.getCell(row, 5), sheetDate(x.releasedOn));
    body(l.getCell(row, 6), x.version);
    body(l.getCell(row, 7), x.environment);
  });
  [3.6, 5.6, 16, 34, 14, 18, 14].forEach(
    (wd, i) => (l.getColumn(i + 1).width = wd),
  );
  l.views = [{ state: 'frozen', ySplit: 3 }];
  print(l);

  // 3. A release history per product, oldest first.
  for (const product of productsOf(o.releases, o.lists)) {
    // What was delivered: planned releases are not in the history yet.
    const list = byDate(
      o.releases.filter(
        (r) =>
          r.product === product &&
          (o.includePlanned || r.status === 'released'),
      ),
    );
    if (!list.length) continue;
    const h = wb.addWorksheet(sheetName(w.history(product), used));
    title(h, 'B2', w.historyTitle(product));
    [
      w.no,
      w.target,
      w.date,
      w.releaseVersion,
      w.summary,
      w.purpose,
      w.changes,
      w.verification,
    ].forEach((t, i) => head(h.getCell(3, 2 + i), t, false));
    list.forEach((r, k) => {
      const row = 4 + k;
      body(h.getCell(row, 2), k + 1);
      body(h.getCell(row, 3), r.target);
      body(
        h.getCell(row, 4),
        r.status === 'planned'
          ? o.language === 'ja'
            ? '予定'
            : 'Planned'
          : sheetDate(r.releasedOn),
      );
      body(h.getCell(row, 5), r.version);
      body(h.getCell(row, 6), r.summary);
      body(h.getCell(row, 7), r.purpose);
      body(h.getCell(row, 8), r.changes);
      body(h.getCell(row, 9), r.verification);
    });
    [3.6, 5.6, 16.6, 14, 18, 34, 38, 52, 46].forEach(
      (wd, i) => (h.getColumn(i + 1).width = wd),
    );
    h.views = [{ state: 'frozen', ySplit: 3 }];
    print(h);
  }
  dataSheet(wb, o.releases, o.lists, o.language, used);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/**
 * The releases in the import format, on a hidden sheet, so the app can read
 * its own workbook back: a row for a release's own text, then a row per file.
 */
export function dataSheet(
  wb: ExcelJS.Workbook,
  releases: Release[],
  lists: ReleaseLists,
  language: ReleaseSheetLanguage,
  used = new Set<string>(),
) {
  const ws = wb.addWorksheet(sheetName(DATA_SHEET[language], used), {
    state: 'hidden',
  });
  ws.addRow([
    ...IMPORT_COLUMNS.map((c) => (language === 'ja' ? c.ja : c.en)),
    ...lists.fields.map((f) => f.name),
  ]);
  ws.getRow(1).font = { bold: true };
  for (const r of byDate(releases)) {
    const base = {
      date: sheetDate(r.releasedOn),
      product: r.product,
      edition: r.target,
      version: r.version,
      status: r.status === 'planned' ? 'Planned' : 'Released',
      summary: r.summary,
    } as Record<string, string>;
    const line = (
      more: Record<string, string>,
      extra: Record<string, string>,
    ) =>
      ws.addRow([
        ...IMPORT_COLUMNS.map((c) => ({ ...base, ...more })[c.key] ?? ''),
        ...lists.fields.map((f) => extra[f.key] ?? ''),
      ]);
    if (r.purpose || r.changes || r.verification || !r.modules.length)
      line(
        {
          changes: r.changes,
          purpose: r.purpose,
          verification: r.verification,
        },
        {},
      );
    for (const m of r.modules)
      line(
        {
          fileName: m.fileName,
          module: m.module,
          type: m.type,
          destination: m.destination,
          category: m.category,
          environment: m.environment,
          fileVersion: m.version,
          changes: m.changes,
          purpose: m.purpose,
          verification: m.verification,
        },
        m.extra,
      );
  }
}
