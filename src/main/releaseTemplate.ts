import ExcelJS from 'exceljs';
import {
  byDate,
  fileInfo,
  latestModules,
  moduleName,
  previousVersion,
  productsOf,
  sheetDate,
  versionMatrix,
  type Release,
  type ReleaseLists,
} from '../shared/releases';
import { sheetName, type ReleaseSheetLanguage } from './releaseExcel';

/**
 * Release workbooks from the project's own Excel template. The template is a
 * normal workbook with markers in its cells:
 *
 * - `{{project.name}}`, `{{project.customer}}`, `{{today}}`, `{{product}}`;
 * - `{{#releases}}` … `{{/releases}}`: the rows between (the same row, or
 *   down to the row with the closing marker) repeat once per release,
 *   oldest first, keeping their style; `{{release.version}}` and the other
 *   release fields inside;
 * - `{{#files}}` … `{{/files}}`: once per file, inside a release block for
 *   that release's files, outside for every file; `{{file.name}}`…;
 * - `{{#latest}}` … `{{/latest}}`: once per module, its newest version;
 * - `{{matrix}}`: the version table, a column per release date;
 * - a sheet whose name has `{{product}}` repeats once per product, with that
 *   product's releases;
 * - a sheet whose name starts with `#` (notes on how to fill it) is left out.
 */

type Ctx = Record<string, string | number>;
type Item = Ctx;

const MARK = /\{\{\s*([#/]?)\s*([^{}\s]+)\s*\}\}/g;

export const TEMPLATE_FIELDS = {
  top: ['project.name', 'project.customer', 'today', 'product'],
  release: [
    'no',
    'product',
    'edition',
    'date',
    'version',
    'status',
    'summary',
    'purpose',
    'changes',
    'verification',
    'files',
  ],
  file: [
    'no',
    'name',
    'file_name',
    'module',
    'type',
    'destination',
    'category',
    'environment',
    'version',
    'previous',
    'changes',
    'purpose',
    'verification',
    'date',
    'product',
  ],
};

export interface TemplateData {
  project: string;
  customer: string;
  today: string;
  releases: Release[];
  lists: ReleaseLists;
  language: ReleaseSheetLanguage;
  includePlanned: boolean;
  onlyChanged: boolean;
}

// ------------------------------------------------------------ cells

function cellString(v: ExcelJS.CellValue): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'richText' in v)
    return (v.richText as { text: string }[]).map((t) => t.text).join('');
  return null;
}

const markersIn = (v: ExcelJS.CellValue) => {
  const s = cellString(v);
  return s
    ? [...s.matchAll(MARK)].map((m) => ({ kind: m[1], name: m[2] }))
    : [];
};

// ------------------------------------------------------------ the template's shape

type Node =
  | { t: 'row'; r: number }
  | { t: 'matrix'; r: number; c: number }
  | { t: 'block'; name: string; kids: Node[] };

function parse(ws: ExcelJS.Worksheet): Node[] {
  const root: Node[] = [];
  const stack: { name: string; kids: Node[] }[] = [{ name: '', kids: root }];
  const top = () => stack[stack.length - 1].kids;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const opens: string[] = [];
    const closes: string[] = [];
    let matrixCol = 0;
    for (let c = 1; c <= row.cellCount; c++)
      for (const m of markersIn(row.getCell(c).value)) {
        if (m.kind === '#') opens.push(m.name);
        else if (m.kind === '/') closes.push(m.name);
        else if (m.name === 'matrix') matrixCol = c;
      }
    for (const name of opens) {
      const b: Node = { t: 'block', name, kids: [] };
      top().push(b);
      stack.push(b);
    }
    top().push(matrixCol ? { t: 'matrix', r, c: matrixCol } : { t: 'row', r });
    for (const name of closes) {
      const at = stack.map((s) => s.name).lastIndexOf(name);
      if (at <= 0)
        throw new Error(
          `The template's sheet "${ws.name}" closes {{/${name}}} without opening it.`,
        );
      stack.length = at;
    }
  }
  if (stack.length > 1)
    throw new Error(
      `The template's sheet "${ws.name}" opens {{#${stack[stack.length - 1].name}}} without closing it.`,
    );
  return root;
}

// ------------------------------------------------------------ what fills it

function releaseItems(d: TemplateData, product: string | null): Item[] {
  const list = byDate(
    d.releases.filter(
      (r) =>
        (d.includePlanned || r.status === 'released') &&
        (product === null || r.product === product),
    ),
  );
  return list.map((r, i) => ({
    'release.id': r.id,
    'release.no': i + 1,
    'release.product': r.product,
    'release.edition': r.target,
    'release.date': r.status === 'planned' ? '' : sheetDate(r.releasedOn),
    'release.version': r.version,
    'release.status':
      r.status === 'planned'
        ? d.language === 'ja'
          ? '予定'
          : 'Planned'
        : d.language === 'ja'
          ? 'リリース済'
          : 'Released',
    'release.summary': r.summary,
    'release.purpose': r.purpose,
    'release.changes': r.changes,
    'release.verification': r.verification,
    'release.files': r.modules.length,
  }));
}

function fileItems(d: TemplateData, releaseIds: string[]): Item[] {
  const out: Item[] = [];
  for (const id of releaseIds) {
    const r = d.releases.find((x) => x.id === id);
    if (!r) continue;
    for (const m of r.modules) {
      const info = fileInfo(r, m);
      const item: Item = {
        'file.no': out.length + 1,
        'file.name': m.fileName || moduleName(m),
        'file.file_name': m.fileName,
        'file.module': m.module,
        'file.type': m.type,
        'file.destination': m.destination,
        'file.category': m.category,
        'file.environment': m.environment,
        'file.version': m.version,
        'file.previous': previousVersion(d.releases, r, m),
        'file.changes': info.changes,
        'file.purpose': info.purpose,
        'file.verification': info.verification,
        'file.date': r.status === 'planned' ? '' : sheetDate(r.releasedOn),
        'file.product': r.product,
      };
      for (const f of d.lists.fields)
        item[`file.${f.key}`] = m.extra[f.key] ?? '';
      out.push(item);
    }
  }
  return out;
}

function latestItems(d: TemplateData, product: string | null): Item[] {
  const list = d.releases.filter(
    (r) => product === null || r.product === product,
  );
  return latestModules(list, d.lists).map((m, i) => ({
    'file.no': i + 1,
    'file.name': m.module,
    'file.module': m.module,
    'file.type': m.type,
    'file.environment': m.environment,
    'file.version': m.version,
    'file.date': sheetDate(m.releasedOn),
    'file.product': m.product,
  }));
}

// ------------------------------------------------------------ writing

const clone = <T>(v: T): T =>
  v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);

const NAVY = 'FF1F497D';
const thin = { style: 'thin' as const, color: { argb: 'FF808080' } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };

class Writer {
  out = 0;
  /** Template row → the rows written from it, in order. */
  rowMap = new Map<number, number[]>();
  unknown = new Set<string>();
  /** Rows the matrix wrote: [first, last]. */
  matrixRows: [number, number][] = [];

  constructor(
    private src: ExcelJS.Worksheet,
    private dst: ExcelJS.Worksheet,
    private d: TemplateData,
    private product: string | null,
  ) {}

  private value(name: string, ctx: Ctx): string | number {
    if (name in ctx) return ctx[name];
    // A file's own field the file does not have.
    if (name.startsWith('file.')) {
      if (!this.d.lists.fields.some((f) => `file.${f.key}` === name))
        this.unknown.add(name);
      return '';
    }
    this.unknown.add(name);
    return '';
  }

  private fill(v: ExcelJS.CellValue, ctx: Ctx): ExcelJS.CellValue {
    const s = cellString(v);
    if (s === null || !s.includes('{{')) return clone(v);
    const stripped = s.replace(MARK, (all, kind: string, name: string) =>
      kind || name === 'matrix' ? '' : all,
    );
    // A cell that is just one marker keeps a number as a number.
    const only = /^\s*\{\{\s*([^{}#/\s]+)\s*\}\}\s*$/.exec(stripped);
    if (only) {
      const x = this.value(only[1], ctx);
      return x === '' ? null : x;
    }
    const text = stripped.replace(MARK, (_all, _k: string, name: string) =>
      String(this.value(name, ctx)),
    );
    return text === '' ? null : text;
  }

  row(r: number, ctx: Ctx) {
    const src = this.src.getRow(r);
    const at = ++this.out;
    const dst = this.dst.getRow(at);
    if (src.height) dst.height = src.height;
    dst.hidden = src.hidden;
    for (let c = 1; c <= src.cellCount; c++) {
      const a = src.getCell(c);
      const b = dst.getCell(c);
      b.style = clone(a.style) ?? {};
      b.value = this.fill(a.value, ctx);
    }
    const list = this.rowMap.get(r) ?? [];
    list.push(at);
    this.rowMap.set(r, list);
  }

  matrix(r: number, col: number, ctx: Ctx) {
    const marker = this.src.getRow(r).getCell(col);
    const font = {
      name: marker.font?.name ?? 'Meiryo UI',
      size: marker.font?.size,
    };
    const ja = this.d.language === 'ja';
    const list = this.d.releases.filter(
      (x) => this.product === null || x.product === this.product,
    );
    const { dates, rows } = versionMatrix(list, this.d.lists);
    const head = (row: number, c: number, text: string) => {
      const cell = this.dst.getCell(row, c);
      cell.value = text;
      cell.font = { ...font, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: NAVY },
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'center',
        wrapText: true,
      };
      cell.border = BOX;
    };
    const h1 = this.out + 1;
    const h2 = this.out + 2;
    (ja
      ? ['仕向け先', 'カテゴリ', 'モジュール', '環境']
      : ['Destination', 'Category', 'Module', 'Environment']
    ).forEach((t, i) => {
      head(h1, col + i, t);
      head(h2, col + i, '');
      this.dst.mergeCells(h1, col + i, h2, col + i);
    });
    if (dates.length) {
      head(h1, col + 4, ja ? 'ファイル名 / バージョン' : 'File / version');
      for (let i = 1; i < dates.length; i++) head(h1, col + 4 + i, '');
      if (dates.length > 1)
        this.dst.mergeCells(h1, col + 4, h1, col + 3 + dates.length);
      dates.forEach((x, i) => head(h2, col + 4 + i, sheetDate(x)));
    }
    rows.forEach((m, k) => {
      const row = h2 + 1 + k;
      const values = [
        m.destination,
        m.category,
        m.module,
        m.environment,
        ...m.versions.map((v, i) =>
          this.d.onlyChanged && !m.changed[i] ? '' : v,
        ),
      ];
      values.forEach((v, i) => {
        const cell = this.dst.getCell(row, col + i);
        cell.value = v;
        cell.font = { ...font, bold: i < 2 };
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = BOX;
      });
    });
    // A destination, and a category in it, once per group.
    const group = (c: number, same: (a: number, b: number) => boolean) => {
      for (let s = 0; s < rows.length;) {
        let e = s;
        while (e + 1 < rows.length && same(s, e + 1)) e++;
        if (e > s)
          this.dst.mergeCells(h2 + 1 + s, col + c, h2 + 1 + e, col + c);
        s = e + 1;
      }
    };
    group(0, (a, b) => rows[a].destination === rows[b].destination);
    group(
      1,
      (a, b) =>
        rows[a].destination === rows[b].destination &&
        rows[a].category === rows[b].category,
    );
    this.out = h2 + rows.length;
    this.matrixRows.push([h1, this.out]);
    void ctx;
  }

  render(nodes: Node[], ctx: Ctx) {
    for (const n of nodes) {
      if (n.t === 'row') this.row(n.r, ctx);
      else if (n.t === 'matrix') this.matrix(n.r, n.c, ctx);
      else
        for (const item of this.items(n.name, ctx))
          this.render(n.kids, { ...ctx, ...item });
    }
  }

  private items(name: string, ctx: Ctx): Item[] {
    if (name === 'releases') return releaseItems(this.d, this.product);
    if (name === 'latest') return latestItems(this.d, this.product);
    if (name === 'files') {
      const ids =
        'release.id' in ctx
          ? [String(ctx['release.id'])]
          : releaseItems(this.d, this.product).map((r) =>
              String(r['release.id']),
            );
      return fileItems(this.d, ids);
    }
    this.unknown.add(`#${name}`);
    return [];
  }
}

/** Copies a template sheet's layout: columns, merges, views, print settings, images. */
function copyLayout(
  src: ExcelJS.Worksheet,
  dst: ExcelJS.Worksheet,
  w: Writer,
  srcBook: ExcelJS.Workbook,
  dstBook: ExcelJS.Workbook,
) {
  const cols = Math.max(src.columnCount, src.actualColumnCount);
  for (let c = 1; c <= cols; c++) {
    const a = src.getColumn(c);
    const b = dst.getColumn(c);
    if (a.width) b.width = a.width;
    if (a.hidden) b.hidden = true;
  }
  // Merged cells follow the rows they were on.
  const merges = ((src.model as { merges?: string[] }).merges ?? []).slice();
  for (const range of merges) {
    const [a, b] = range.split(':');
    if (!b) continue;
    const ca = src.getCell(a);
    const cb = src.getCell(b);
    const tops = w.rowMap.get(Number(ca.row)) ?? [];
    const bottoms = w.rowMap.get(Number(cb.row)) ?? [];
    if (!tops.length || tops.length !== bottoms.length) continue;
    tops.forEach((t, i) => {
      try {
        dst.mergeCells(t, Number(ca.col), bottoms[i], Number(cb.col));
      } catch {
        // Overlaps what the matrix wrote: left unmerged.
      }
    });
  }
  dst.views = clone(src.views) ?? [];
  const ps = clone(src.pageSetup) as Partial<ExcelJS.PageSetup>;
  if (ps) {
    delete ps.printArea;
    delete ps.printTitlesRow;
    dst.pageSetup = ps as ExcelJS.PageSetup;
  }
  dst.headerFooter = clone(src.headerFooter);
  dst.properties = { ...dst.properties, ...clone(src.properties) };
  // Pictures (a logo…) stay by the row they were on.
  for (const img of src.getImages()) {
    try {
      const media = srcBook.getImage(Number(img.imageId));
      const id = dstBook.addImage({
        buffer: media.buffer as ExcelJS.Buffer,
        extension: (media.extension ?? 'png') as 'png',
      });
      const tl = img.range.tl;
      const br = img.range.br;
      const shift = (row: number) => {
        const to = w.rowMap.get(Math.floor(row) + 1)?.[0];
        return to === undefined ? row : to - 1 + (row - Math.floor(row));
      };
      dst.addImage(id, {
        tl: {
          col: tl.nativeCol + tl.nativeColOff / 1e6,
          row: shift(tl.nativeRow),
        },
        br: br
          ? {
              col: br.nativeCol + br.nativeColOff / 1e6,
              row: shift(br.nativeRow),
            }
          : undefined,
      } as unknown as ExcelJS.ImageRange);
    } catch {
      // A picture the library cannot copy is left out.
    }
  }
}

async function load(data: Uint8Array): Promise<ExcelJS.Workbook> {
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
  return wb;
}

/** The release workbook from a template; `unknown` lists markers it did not know. */
export async function fillTemplate(
  template: Uint8Array,
  d: TemplateData,
): Promise<{ data: Uint8Array; unknown: string[] }> {
  const src = await load(template);
  const out = new ExcelJS.Workbook();
  out.creator = 'WorkSync';
  const used = new Set<string>();
  const unknown = new Set<string>();
  const top: Ctx = {
    'project.name': d.project,
    'project.customer': d.customer,
    today: d.today,
  };
  for (const ws of src.worksheets) {
    if (ws.name.startsWith('#') || ws.state === 'veryHidden') continue;
    const nodes = parse(ws);
    const perProduct = ws.name.includes('{{product}}');
    const products: (string | null)[] = perProduct
      ? productsOf(d.releases, d.lists).filter((p) =>
          d.releases.some(
            (r) =>
              r.product === p && (d.includePlanned || r.status === 'released'),
          ),
        )
      : [null];
    for (const product of products) {
      const name = ws.name.replaceAll('{{product}}', product ?? '');
      const dst = out.addWorksheet(sheetName(name, used), {
        state: ws.state === 'hidden' ? 'hidden' : 'visible',
      });
      const w = new Writer(ws, dst, d, product);
      w.render(nodes, { ...top, product: product ?? '' });
      copyLayout(ws, dst, w, src, out);
      for (const u of w.unknown) unknown.add(u);
    }
  }
  if (!out.worksheets.length)
    throw new Error('The template has no sheet to fill.');
  return {
    data: new Uint8Array(await out.xlsx.writeBuffer()),
    unknown: [...unknown],
  };
}

/** What a template holds, to check it when it is chosen. */
export async function describeTemplate(
  data: Uint8Array,
): Promise<{ sheets: number; markers: number; fields: string[] }> {
  const wb = await load(data);
  let markers = 0;
  const fields = new Set<string>();
  let sheets = 0;
  for (const ws of wb.worksheets) {
    if (ws.name.startsWith('#')) continue;
    sheets++;
    parse(ws); // Throws on a block that is not closed.
    if (ws.name.includes('{{product}}')) markers++;
    ws.eachRow((row) =>
      row.eachCell((cell) => {
        for (const m of markersIn(cell.value)) {
          markers++;
          if (!m.kind && m.name.startsWith('file.')) {
            const k = m.name.slice(5);
            if (!TEMPLATE_FIELDS.file.includes(k)) fields.add(k);
          }
        }
      }),
    );
  }
  if (!markers)
    throw new Error(
      'This workbook has no markers like {{release.version}}, so the export would not fill anything. Start from "Save the default template".',
    );
  return { sheets, markers, fields: [...fields] };
}

/**
 * The built-in layout as a template to edit: the version list, the newest
 * module versions, a history per product and the files of each release,
 * with a sheet on how markers work (left out of the export).
 */
export async function defaultTemplate(
  language: ReleaseSheetLanguage,
  lists: ReleaseLists,
): Promise<Uint8Array> {
  const ja = language === 'ja';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkSync';
  const FONT = 'Meiryo UI';
  const title = (c: ExcelJS.Cell, text: string) => {
    c.value = text;
    c.font = { name: FONT, size: 14, bold: true };
  };
  const head = (c: ExcelJS.Cell, text: string) => {
    c.value = text;
    c.font = { name: FONT, bold: true };
    c.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9D9D9' },
    };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BOX;
  };
  const body = (c: ExcelJS.Cell, text: string) => {
    c.value = text;
    c.font = { name: FONT };
    c.alignment = { vertical: 'top', wrapText: true };
    c.border = BOX;
  };
  const table = (
    ws: ExcelJS.Worksheet,
    row: number,
    cols: [string, string, number][],
    open: string,
    close: string,
  ) => {
    cols.forEach(([h, f, width], i) => {
      head(ws.getCell(row, 2 + i), h);
      const first = i === 0 ? open : '';
      const last = i === cols.length - 1 ? close : '';
      body(ws.getCell(row + 1, 2 + i), `${first}${f}${last}`);
      ws.getColumn(2 + i).width = width;
    });
    ws.getColumn(1).width = 3.6;
    ws.views = [{ state: 'frozen', ySplit: row }];
    ws.pageSetup = {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
  };

  const m = wb.addWorksheet(
    ja ? 'モジュールバージョン一覧' : 'Module versions',
  );
  title(
    m.getCell('A1'),
    ja
      ? 'モジュールバージョン一覧（{{project.customer}}様 提出用）'
      : 'Module versions (for {{project.customer}})',
  );
  m.getCell('A3').value = '{{matrix}}';
  m.getCell('A3').font = { name: FONT };
  [26, 23, 22, 14, 16, 16, 16, 16, 16, 16].forEach(
    (w, i) => (m.getColumn(i + 1).width = w),
  );
  m.views = [{ state: 'frozen', xSplit: 4, ySplit: 4 }];
  m.pageSetup = {
    paperSize: 9,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  };

  const l = wb.addWorksheet(ja ? 'リリースモジュール一覧' : 'Release modules');
  title(
    l.getCell('B2'),
    ja
      ? '{{project.name}} リリースモジュールバージョン管理表'
      : '{{project.name}}: release module versions',
  );
  table(
    l,
    3,
    [
      ['No.', '{{file.no}}', 5.6],
      [ja ? '種別' : 'Type', '{{file.type}}', 16],
      [
        ja ? 'モジュール／ファイル名' : 'Module / file name',
        '{{file.name}}',
        34,
      ],
      [ja ? 'リリース日' : 'Release date', '{{file.date}}', 14],
      [ja ? 'バージョン' : 'Version', '{{file.version}}', 18],
      [ja ? '環境' : 'Environment', '{{file.environment}}', 14],
    ],
    '{{#latest}}',
    '{{/latest}}',
  );

  const h = wb.addWorksheet(
    ja ? 'リリース履歴一覧({{product}})' : 'Release history ({{product}})',
  );
  title(
    h.getCell('B2'),
    ja
      ? '{{product}} リリース履歴（旧→新）'
      : '{{product}} release history (old → new)',
  );
  table(
    h,
    3,
    [
      ['No.', '{{release.no}}', 5.6],
      [ja ? '対象版' : 'Edition', '{{release.edition}}', 16.6],
      [ja ? 'リリース日' : 'Release date', '{{release.date}}', 14],
      [
        ja ? 'リリースバージョン' : 'Release version',
        '{{release.version}}',
        18,
      ],
      [ja ? '概要' : 'Summary', '{{release.summary}}', 34],
      [ja ? '目的' : 'Purpose', '{{release.purpose}}', 38],
      [
        ja ? '内容（改善点／変更点等）' : 'Changes (improvements, changes)',
        '{{release.changes}}',
        52,
      ],
      [ja ? '検証' : 'Verification', '{{release.verification}}', 46],
    ],
    '{{#releases}}',
    '{{/releases}}',
  );

  const f = wb.addWorksheet(ja ? 'ファイル別リリース内容' : 'Released files');
  title(
    f.getCell('B2'),
    ja
      ? '{{project.name}} ファイル別リリース内容'
      : '{{project.name}}: released files',
  );
  table(
    f,
    3,
    [
      ['No.', '{{file.no}}', 5.6],
      [ja ? 'リリース日' : 'Release date', '{{release.date}}', 14],
      [ja ? '製品' : 'Product', '{{release.product}}', 14],
      [
        ja ? 'リリースバージョン' : 'Release version',
        '{{release.version}}',
        14,
      ],
      [ja ? 'ファイル名' : 'File name', '{{file.name}}', 26],
      [ja ? '環境' : 'Environment', '{{file.environment}}', 10],
      [ja ? '旧バージョン' : 'Previous version', '{{file.previous}}', 16],
      [ja ? '新バージョン' : 'New version', '{{file.version}}', 16],
      [ja ? '内容' : 'Change log', '{{file.changes}}', 40],
      [ja ? '目的' : 'Purpose', '{{file.purpose}}', 30],
      [ja ? '検証' : 'Verification', '{{file.verification}}', 30],
      ...lists.fields.map((x): [string, string, number] => [
        x.name,
        `{{file.${x.key}}}`,
        16,
      ]),
    ],
    '{{#releases}}{{#files}}',
    '{{/files}}{{/releases}}',
  );

  const g = wb.addWorksheet(ja ? '#使い方' : '#How to use');
  const rows: [string, string][] = [
    [
      ja ? 'セルに書く' : 'Write in a cell',
      ja ? 'エクスポートで入るもの' : 'What the export puts there',
    ],
    [
      '{{project.name}}  {{project.customer}}  {{today}}',
      ja
        ? 'プロジェクト名、顧客名、今日の日付'
        : 'The project, the customer, today',
    ],
    [
      '{{#releases}} … {{/releases}}',
      ja
        ? 'その行（から閉じる行まで）をリリースごとに繰り返す（旧→新、書式はそのまま）'
        : 'Repeats the row (down to the closing row) once per release, oldest first, keeping its style',
    ],
    [
      '{{#files}} … {{/files}}',
      ja
        ? 'ファイルごとに繰り返す。リリースの中ではそのリリースのファイル'
        : 'Repeats once per file; inside a release block, that release’s files',
    ],
    [
      '{{#latest}} … {{/latest}}',
      ja ? 'モジュールごとの最新バージョン' : 'Each module’s newest version',
    ],
    [
      '{{matrix}}',
      ja
        ? 'バージョン一覧表（リリース日ごとの列）'
        : 'The version table, a column per release date',
    ],
    [
      '{{release.' + TEMPLATE_FIELDS.release.join('}}  {{release.') + '}}',
      ja ? 'リリースの項目' : 'Release fields',
    ],
    [
      '{{file.' + TEMPLATE_FIELDS.file.join('}}  {{file.') + '}}',
      ja ? 'ファイルの項目' : 'File fields',
    ],
    ...lists.fields.map((x): [string, string] => [`{{file.${x.key}}}`, x.name]),
    [
      ja ? 'シート名に {{product}}' : '{{product}} in a sheet name',
      ja ? '製品ごとにシートを作る' : 'One sheet per product',
    ],
    [
      ja ? '名前が # で始まるシート' : 'A sheet named #…',
      ja
        ? 'エクスポートに含めない（このシートなど）'
        : 'Left out of the export, like this one',
    ],
  ];
  rows.forEach(([a, b], i) => {
    g.getCell(i + 1, 1).value = a;
    g.getCell(i + 1, 2).value = b;
    g.getCell(i + 1, 1).font = { name: 'Consolas', bold: i === 0 };
    g.getCell(i + 1, 2).font = { name: FONT, bold: i === 0 };
    g.getCell(i + 1, 1).alignment = { wrapText: true, vertical: 'top' };
    g.getCell(i + 1, 2).alignment = { wrapText: true, vertical: 'top' };
  });
  g.getColumn(1).width = 60;
  g.getColumn(2).width = 70;
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
