import ExcelJS from 'exceljs';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  LANGUAGES,
  LEVEL_NAME,
  addDays,
  daysBetween,
  isClosed,
  shownPriority,
  type Level,
  type Project,
  type Task,
} from '../shared/model';
import {
  COLUMNS,
  DEFAULT_COLUMNS,
  REPORTS,
  briefParts,
  hasPart,
  statusText,
  dateIn,
  heading,
  periodOverview,
  reportTitle,
  type ReportOptions,
} from '../shared/reports';

/** What every report starts with (spec 05). */
interface ReportHead {
  project: Project;
  options: ReportOptions;
  today: string;
  /** The newest As of date among the tasks: how current the information is. */
  asOf: string;
}

const LEVEL_FILL: Record<Level, string> = {
  U: 'FCE1E0',
  H: 'FDF1D3',
  N: 'FFFFFF',
  L: 'F1F2F4',
};
const LEVEL_TEXT: Record<Level, string> = {
  U: 'C0302C',
  H: '9A6B00',
  N: '3D4450',
  L: '6B7280',
};
const BAR_FILL: Record<Level, string> = {
  U: 'E8615E',
  H: 'F2B52B',
  N: '7C93BF',
  L: 'B9BFC9',
};
const FONT = 'Yu Gothic';

/** True when the report is in Japanese only, so its labels are too. */
const inJapanese = (h: ReportHead) =>
  h.options.language === 'original' &&
  (h.project.originalLanguages[0] ?? 'ja') === 'ja';

/** A label in the report's language: Japanese for a Japanese report, else English. */
const tr = (h: ReportHead, en: string, ja: string) => (inJapanese(h) ? ja : en);

const REPORT_NAME_JA: Record<ReportOptions['kind'], string> = {
  progress: '進捗報告書',
  taskList: 'タスク一覧',
  schedule: 'スケジュール',
  briefs: 'タスク概要',
};
const LEVEL_JA: Record<Level, string> = {
  U: '至急',
  H: '高',
  N: '中',
  L: '低',
};
/** A priority in the report's language; the file's own word when it has one. */
const levelName = (h: ReportHead, t: Task) =>
  inJapanese(h)
    ? t.priorityOverride
      ? LEVEL_JA[shownPriority(t)]
      : t.priorityWord || LEVEL_JA[shownPriority(t)]
    : LEVEL_NAME[shownPriority(t)];
const reportName = (h: ReportHead) =>
  tr(h, REPORTS[h.options.kind].name, REPORT_NAME_JA[h.options.kind]);

function headLines(h: ReportHead): [string, string][] {
  const o = h.options;
  const lines: [string, string][] = [
    [tr(h, 'Project', 'プロジェクト'), h.project.name],
    [tr(h, 'Customer', 'お客様'), h.project.customer],
    [tr(h, 'Prepared by', '作成者'), o.preparedBy],
    [tr(h, 'Made', '作成日'), dateIn(h.today, o)],
    [tr(h, 'Information as of', '情報の時点'), dateIn(h.asOf, o)],
  ];
  if (o.kind === 'progress')
    lines.push([
      tr(h, 'Period', '期間'),
      `${dateIn(o.from, o)} – ${dateIn(o.to, o)}`,
    ]);
  if (o.language !== 'working')
    lines.push([
      tr(h, 'Language', '言語'),
      o.language === 'both'
        ? `${LANGUAGES[h.project.originalLanguages[0] ?? 'ja']} and ${LANGUAGES[h.project.workingLanguage]}`
        : tr(h, LANGUAGES[h.project.originalLanguages[0] ?? 'ja'], '日本語'),
    ]);
  return lines.filter(([, v]) => v);
}

export function newestAsOf(tasks: Task[], today: string): string {
  return (
    tasks
      .map((t) => t.situation.asOf)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? today
  );
}

// ---------------------------------------------------------------- Excel

function xlsxHead(ws: ExcelJS.Worksheet, h: ReportHead, title: string): number {
  ws.addRow([title]).font = { name: FONT, size: 16, bold: true };
  // One cell per line, so the text runs across the empty cells beside it whatever the column widths.
  for (const [k, v] of headLines(h)) {
    const r = ws.addRow([`${k}: ${v}`]);
    r.getCell(1).font = { name: FONT, color: { argb: 'FF3D4450' } };
  }
  ws.addRow([]);
  return ws.rowCount;
}

function printSetup(ws: ExcelJS.Worksheet) {
  ws.pageSetup = {
    paperSize: 9,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: {
      left: 0.5,
      right: 0.5,
      top: 0.6,
      bottom: 0.6,
      header: 0.3,
      footer: 0.3,
    },
  };
  ws.headerFooter = { oddFooter: '&L&8WorkSync&R&8&P / &N' };
}

/** A table with a frozen header row, filters, set widths and wrapped text, printing on A4 landscape. */
function xlsxTable(
  ws: ExcelJS.Worksheet,
  startRow: number,
  cols: { label: string; width: number }[],
  rows: { values: string[]; level: Level; closed: boolean }[],
  levelCol: number,
) {
  cols.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));
  const head = ws.getRow(startRow + 1);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.label;
    cell.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2F3B4D' },
    };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  head.height = 22;
  rows.forEach((r, k) => {
    const row = ws.getRow(startRow + 2 + k);
    r.values.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      cell.font = {
        name: FONT,
        color: { argb: r.closed ? 'FF8C96A7' : 'FF1C1F24' },
      };
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E5EA' } } };
    });
    if (levelCol >= 0 && !r.closed) {
      const p = row.getCell(levelCol + 1);
      p.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: `FF${LEVEL_FILL[r.level]}` },
      };
      p.font = {
        name: FONT,
        bold: r.level === 'U' || r.level === 'H',
        color: { argb: `FF${LEVEL_TEXT[r.level]}` },
      };
    }
  });
  ws.views = [{ state: 'frozen', ySplit: startRow + 1 }];
  ws.autoFilter = {
    from: { row: startRow + 1, column: 1 },
    to: { row: startRow + 1 + rows.length, column: cols.length },
  };
  printSetup(ws);
  ws.pageSetup.printTitlesRow = `${startRow + 1}:${startRow + 1}`;
}

async function xlsxReport(h: ReportHead, tasks: Task[]): Promise<Buffer> {
  const o = h.options;
  const ja = (h.project.originalLanguages[0] ?? 'ja') === 'ja';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkSync';
  wb.created = new Date(`${h.today}T09:00:00`);
  const title = reportName(h);

  if (o.kind === 'schedule') {
    scheduleSheet(
      wb.addWorksheet('Schedule', { properties: { defaultRowHeight: 18 } }),
      h,
      tasks,
    );
  } else if (o.kind === 'progress') {
    const ov = periodOverview(tasks, h.project, o, h.today);
    if (hasPart(o, 'overview')) {
      const s = wb.addWorksheet('Overview');
      xlsxHead(s, h, title);
      s.getColumn(1).width = 26;
      s.getColumn(2).width = 60;
      const lines: [string, number][] = [
        ['Open tasks', ov.open],
        ['Finished in the period', ov.finished],
        ['Started in the period', ov.started],
        ['Overdue', ov.overdue],
        ...(hasPart(o, 'difficulties')
          ? [['Open difficulties', ov.difficulties] as [string, number]]
          : []),
        ...ov.byStatus.map((x) => [x.status, x.count] as [string, number]),
      ];
      for (const [k, v] of lines) {
        const r = s.addRow([k, v]);
        r.font = { name: FONT };
        r.getCell(2).alignment = { horizontal: 'left' };
      }
      printSetup(s);
    }
    const t = wb.addWorksheet('Tasks');
    const start = xlsxHead(t, h, title);
    type Col = {
      label: string;
      width: number;
      part?: Parameters<typeof hasPart>[1];
      value: (x: Task, b: ReturnType<typeof briefParts>) => string;
    };
    const all: Col[] = [
      { label: 'No.', width: 8, value: (x) => x.customerId },
      {
        label: heading({ label: 'Title', ja: '件名' }, o.language, ja),
        width: 40,
        value: (x) => reportTitle(x, o.language),
      },
      {
        label: heading({ label: 'Priority', ja: '優先度' }, o.language, ja),
        width: 10,
        value: (x) => levelName(h, x),
      },
      {
        label: heading({ label: 'Status', ja: '状態' }, o.language, ja),
        width: 12,
        value: (x) => statusText(x, o),
      },
      {
        label: heading({ label: 'Due', ja: '期限' }, o.language, ja),
        width: 14,
        part: 'dates',
        value: (_x, b) => b.due,
      },
      {
        label: heading({ label: 'What it is', ja: '概要' }, o.language, ja),
        width: 40,
        part: 'what',
        value: (_x, b) => b.what,
      },
      {
        label: '現状 (Doing now)',
        width: 36,
        part: 'doingNow',
        value: (_x, b) => b.doingNow,
      },
      {
        label: '課題 (Open difficulties)',
        width: 34,
        part: 'difficulties',
        value: (_x, b) => b.difficulties.join('\n'),
      },
      {
        label: '今後の予定 (Next step)',
        width: 34,
        part: 'next',
        value: (_x, b) => b.next,
      },
      {
        label: heading({ label: 'As of', ja: '更新日' }, o.language, ja),
        width: 12,
        part: 'dates',
        value: (_x, b) => b.asOf,
      },
    ];
    const cols = all.filter((c) => !c.part || hasPart(o, c.part));
    xlsxTable(
      t,
      start,
      cols,
      tasks.map((x) => {
        const b = briefParts(x, o, h.today, h.project.dueSoonDays);
        return {
          values: cols.map((c) => c.value(x, b)),
          level: shownPriority(x),
          closed: isClosed(x),
        };
      }),
      2,
    );
  } else {
    const keys = o.columns.length ? o.columns : DEFAULT_COLUMNS;
    const cols = COLUMNS.filter(
      (c) => keys.includes(c.key) && (c.key !== 'notes' || o.includeNotes),
    );
    const s = wb.addWorksheet('Tasks');
    const start = xlsxHead(s, h, title);
    xlsxTable(
      s,
      start,
      cols.map((c) => ({ label: heading(c, o.language, ja), width: c.width })),
      tasks.map((t) => ({
        values: cols.map((c) => c.value(t, o)),
        level: shownPriority(t),
        closed: isClosed(t),
      })),
      cols.findIndex((c) => c.key === 'priority'),
    );
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Planned and actual dates as shaded cells: a 予定 row and a 実績 row per task. */
function scheduleSheet(ws: ExcelJS.Worksheet, h: ReportHead, tasks: Task[]) {
  const o = h.options;
  const ja = (h.project.originalLanguages[0] ?? 'ja') === 'ja';
  const start0 = xlsxHead(ws, h, REPORTS.schedule.name);
  const dated = tasks.filter(
    (t) => t.plannedStart || t.plannedEnd || t.actualStart,
  );
  const dates = dated
    .flatMap((t) => [t.plannedStart, t.plannedEnd, t.actualStart, t.actualEnd])
    .filter((d): d is string => !!d);
  const first0 = [h.today, ...dates].sort()[0];
  const dow = new Date(`${first0}T00:00:00Z`).getUTCDay();
  const first = addDays(first0, -((dow + 6) % 7));
  const last = [addDays(h.today, 14), ...dates].sort().at(-1)!;
  const span = daysBetween(first, last) + 7;
  const byWeek = span > 70;
  const unit = byWeek ? 7 : 1;
  const slots = Math.ceil(Math.min(span, 730) / unit);
  const fixed = [
    { label: 'No.', width: 7 },
    {
      label: heading({ label: 'Title', ja: '件名' }, o.language, ja),
      width: 36,
    },
    {
      label: heading({ label: 'Priority', ja: '優先度' }, o.language, ja),
      width: 9,
    },
    {
      label: heading({ label: 'Status', ja: '状態' }, o.language, ja),
      width: 11,
    },
    { label: '', width: 6 },
    {
      label: heading({ label: 'Start', ja: '開始' }, o.language, ja),
      width: 11,
    },
    { label: heading({ label: 'End', ja: '終了' }, o.language, ja), width: 11 },
  ];
  fixed.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));
  const c0 = fixed.length + 1;
  for (let i = 0; i < slots; i++) ws.getColumn(c0 + i).width = byWeek ? 5 : 3.2;

  const monthRow = ws.getRow(start0 + 1);
  const dayRow = ws.getRow(start0 + 2);
  fixed.forEach((c, i) => {
    const cell = dayRow.getCell(i + 1);
    cell.value = c.label;
    cell.font = { name: FONT, bold: true };
  });
  let lastMonth = '';
  for (let i = 0; i < slots; i++) {
    const d = addDays(first, i * unit);
    const m = d.slice(0, 7);
    if (m !== lastMonth) {
      monthRow.getCell(c0 + i).value =
        `${Number(d.slice(5, 7))}月 ${d.slice(0, 4)}`;
      monthRow.getCell(c0 + i).font = { name: FONT, bold: true, size: 9 };
      lastMonth = m;
    }
    const cell = dayRow.getCell(c0 + i);
    cell.value = Number(d.slice(8));
    cell.font = { name: FONT, size: 8, color: { argb: 'FF6B7280' } };
    cell.alignment = { horizontal: 'center' };
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (!byWeek && (wd === 0 || wd === 6))
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F2F4' },
      };
  }
  const todaySlot = Math.floor(daysBetween(first, h.today) / unit);
  const slotOf = (d: string) => Math.floor(daysBetween(first, d) / unit);

  let r = start0 + 3;
  for (const t of dated) {
    const level = shownPriority(t);
    const plan = ws.getRow(r);
    const act = ws.getRow(r + 1);
    plan.getCell(1).value = t.customerId;
    plan.getCell(2).value = reportTitle(t, o.language);
    plan.getCell(3).value = levelName(h, t);
    plan.getCell(4).value = statusText(t, o);
    plan.getCell(5).value = ja ? '予定' : 'Plan';
    act.getCell(5).value = ja ? '実績' : 'Actual';
    plan.getCell(6).value = dateIn(t.plannedStart, o);
    plan.getCell(7).value = dateIn(t.plannedEnd, o);
    act.getCell(6).value = dateIn(t.actualStart, o);
    act.getCell(7).value = dateIn(t.actualEnd, o);
    for (const row of [plan, act])
      row.eachCell((c) => (c.font = { name: FONT, size: 9 }));
    plan.getCell(3).font = {
      name: FONT,
      size: 9,
      bold: level === 'U' || level === 'H',
      color: { argb: `FF${LEVEL_TEXT[level]}` },
    };
    ws.mergeCells(r, 1, r + 1, 1);
    ws.mergeCells(r, 2, r + 1, 2);
    ws.mergeCells(r, 3, r + 1, 3);
    ws.mergeCells(r, 4, r + 1, 4);
    plan.getCell(2).alignment = { vertical: 'top', wrapText: true };
    const fill = (
      row: ExcelJS.Row,
      from: string | null,
      to: string | null,
      color: string,
    ) => {
      if (!from) return;
      const a = Math.max(0, slotOf(from));
      const b = Math.min(slots - 1, slotOf(to ?? from));
      for (let i = a; i <= b; i++)
        row.getCell(c0 + i).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${color}` },
        };
    };
    fill(
      plan,
      t.plannedStart ?? t.plannedEnd,
      t.plannedEnd ?? t.plannedStart,
      isClosed(t) ? 'C9CED6' : BAR_FILL[level],
    );
    fill(
      act,
      t.actualStart,
      t.actualEnd ?? (t.actualStart ? h.today : null),
      '4B5563',
    );
    for (const row of [plan, act])
      if (todaySlot >= 0 && todaySlot < slots)
        row.getCell(c0 + todaySlot).border = {
          left: { style: 'medium', color: { argb: 'FF0F8EA3' } },
        };
    act.getCell(1).border = {
      bottom: { style: 'thin', color: { argb: 'FFE2E5EA' } },
    };
    for (let c = 1; c < c0 + slots; c++)
      act.getCell(c).border = {
        ...act.getCell(c).border,
        bottom: { style: 'thin', color: { argb: 'FFE2E5EA' } },
      };
    r += 2;
  }
  ws.views = [{ state: 'frozen', xSplit: fixed.length, ySplit: start0 + 2 }];
  printSetup(ws);
  ws.pageSetup.printTitlesRow = `${start0 + 1}:${start0 + 2}`;
  const legend = ws.getRow(r + 1);
  legend.getCell(2).value =
    `${ja ? '予定' : 'Plan'}: shaded in the priority color · ${ja ? '実績' : 'Actual'}: dark grey · the blue line is today (${dateIn(h.today, o)})${byWeek ? ' · one column per week' : ''}`;
  legend.getCell(2).font = { name: FONT, size: 9, color: { argb: 'FF6B7280' } };
}

// ---------------------------------------------------------------- Word

const run = (
  text: string,
  o: { bold?: boolean; color?: string; size?: number } = {},
) => {
  const parts = text.split('\n');
  return parts.map(
    (p, i) =>
      new TextRun({
        text: p,
        bold: o.bold,
        color: o.color,
        size: o.size,
        break: i ? 1 : undefined,
      }),
  );
};
const para = (
  text: string,
  o: {
    bold?: boolean;
    color?: string;
    size?: number;
    heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel];
    after?: number;
  } = {},
) =>
  new Paragraph({
    heading: o.heading,
    spacing: { after: o.after ?? 80 },
    children: run(text, o),
  });

function headBlock(h: ReportHead, title: string): Paragraph[] {
  return [
    para(title, { heading: HeadingLevel.TITLE, after: 120 }),
    ...headLines(h).map(
      ([k, v]) =>
        new Paragraph({
          spacing: { after: 20 },
          children: [
            new TextRun({ text: `${k}: `, color: '6B7280', size: 18 }),
            new TextRun({ text: v, size: 18 }),
          ],
        }),
    ),
    new Paragraph({
      spacing: { after: 160 },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 6,
          color: 'D0D5DD',
          space: 4,
        },
      },
      children: [],
    }),
  ];
}

/** One task's brief: its number, title and priority, then what it is, 現状, 課題 and 今後の予定. */
function briefBlock(t: Task, h: ReportHead): Paragraph[] {
  const o = h.options;
  const b = briefParts(t, o, h.today, h.project.dueSoonDays);
  const level = shownPriority(t);
  const head = new Paragraph({
    heading: HeadingLevel.HEADING_3,
    keepNext: true,
    spacing: { before: 200, after: 60 },
    children: [
      new TextRun({ text: `No. ${t.customerId}  ` }),
      ...run(reportTitle(t, o.language)),
      ...(level === 'U' || level === 'H'
        ? [
            new TextRun({
              text: `  ${levelName(h, t)}`,
              color: LEVEL_TEXT[level],
              bold: true,
            }),
          ]
        : []),
    ],
  });
  const line = (label: string, value: string | string[]) =>
    new Paragraph({
      keepNext: true,
      indent: { left: 240 },
      spacing: { after: 40 },
      children: [
        new TextRun({ text: `${label}  `, bold: true, color: '3D4450' }),
        ...run(
          Array.isArray(value)
            ? value.join('\n') || tr(h, 'None', 'なし')
            : value || '—',
        ),
      ],
    });
  const dates = hasPart(o, 'dates');
  const meta = [
    statusText(t, o),
    dates && b.due,
    dates && b.asOf && tr(h, `as of ${b.asOf}`, `${b.asOf}時点`),
  ]
    .filter(Boolean)
    .join(' · ');
  return [
    head,
    new Paragraph({
      indent: { left: 240 },
      spacing: { after: 60 },
      children: [new TextRun({ text: meta, color: '6B7280', size: 18 })],
    }),
    ...(hasPart(o, 'what') ? [line(tr(h, 'What it is', '概要'), b.what)] : []),
    ...(hasPart(o, 'doingNow')
      ? [line(tr(h, '現状 Doing now', '現状'), b.doingNow)]
      : []),
    ...(hasPart(o, 'difficulties')
      ? [line(tr(h, '課題 Difficulties', '課題'), b.difficulties)]
      : []),
    ...(hasPart(o, 'next')
      ? [
          new Paragraph({
            indent: { left: 240 },
            spacing: { after: 60 },
            children: [
              new TextRun({
                text: `${tr(h, '今後の予定 Next step', '今後の予定')}  `,
                bold: true,
                color: '3D4450',
              }),
              ...run(b.next || '—'),
            ],
          }),
        ]
      : []),
    ...(o.includeNotes && t.notes
      ? [
          new Paragraph({
            indent: { left: 240 },
            children: [
              new TextRun({ text: 'Notes  ', bold: true, color: '3D4450' }),
              ...run(t.notes),
            ],
          }),
        ]
      : []),
  ];
}

function docTable(
  cols: { label: string; width: number }[],
  rows: { values: string[]; level: Level; closed: boolean }[],
  levelCol: number,
): Table {
  const total = cols.reduce((n, c) => n + c.width, 0);
  const cell = (
    text: string,
    w: number,
    o: { head?: boolean; fill?: string; color?: string; bold?: boolean } = {},
  ) =>
    new TableCell({
      width: {
        size: Math.round((w / total) * 100),
        type: WidthType.PERCENTAGE,
      },
      shading: o.fill
        ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill }
        : undefined,
      margins: { top: 40, bottom: 40, left: 80, right: 80 },
      children: [
        new Paragraph({
          children: run(text, {
            bold: o.head || o.bold,
            color: o.head ? 'FFFFFF' : o.color,
            size: 18,
          }),
        }),
      ],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: cols.map((c) =>
          cell(c.label, c.width, { head: true, fill: '2F3B4D' }),
        ),
      }),
      ...rows.map(
        (r) =>
          new TableRow({
            cantSplit: true,
            children: r.values.map((v, i) =>
              cell(
                v,
                cols[i].width,
                i === levelCol && !r.closed
                  ? {
                      fill: LEVEL_FILL[r.level],
                      color: LEVEL_TEXT[r.level],
                      bold: r.level === 'U' || r.level === 'H',
                    }
                  : { color: r.closed ? '8C96A7' : undefined },
              ),
            ),
          }),
      ),
    ],
  });
}

async function docxReport(h: ReportHead, tasks: Task[]): Promise<Buffer> {
  const o = h.options;
  const ja = (h.project.originalLanguages[0] ?? 'ja') === 'ja';
  const title = reportName(h);
  const children: (Paragraph | Table)[] = headBlock(h, title);
  let landscape = false;
  if (o.kind === 'progress') {
    const ov = periodOverview(tasks, h.project, o, h.today);
    if (hasPart(o, 'overview')) {
      children.push(
        para('Overview of the period', { heading: HeadingLevel.HEADING_2 }),
      );
      const facts = [
        `${ov.open} open task${ov.open === 1 ? '' : 's'}, ${ov.finished} finished and ${ov.started} started in the period.`,
        hasPart(o, 'difficulties')
          ? `${ov.overdue} overdue, and ${ov.difficulties} open difficult${ov.difficulties === 1 ? 'y' : 'ies'}.`
          : `${ov.overdue} overdue.`,
        `By status: ${ov.byStatus.map((x) => `${x.status} ${x.count}`).join(', ') || 'no tasks'}.`,
      ];
      for (const f of facts)
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40 },
            children: run(f),
          }),
        );
    }
    // The heading names the parts the briefs have.
    const named = (
      [
        ['doingNow', '現状'],
        ['difficulties', '課題'],
        ['next', '今後の予定'],
      ] as const
    )
      .filter(([k]) => hasPart(o, k))
      .map(([, n]) => n);
    children.push(
      para(ja && named.length ? `Tasks (${named.join('・')})` : 'Tasks', {
        heading: HeadingLevel.HEADING_2,
      }),
    );
    for (const t of tasks) children.push(...briefBlock(t, h));
  } else if (o.kind === 'briefs') {
    for (const t of tasks) children.push(...briefBlock(t, h));
  } else {
    const keys = o.columns.length ? o.columns : DEFAULT_COLUMNS;
    const cols = COLUMNS.filter(
      (c) => keys.includes(c.key) && (c.key !== 'notes' || o.includeNotes),
    );
    landscape = cols.length > 5;
    children.push(
      docTable(
        cols.map((c) => ({
          label: heading(c, o.language, ja),
          width: c.width,
        })),
        tasks.map((t) => ({
          values: cols.map((c) => c.value(t, o)),
          level: shownPriority(t),
          closed: isClosed(t),
        })),
        cols.findIndex((c) => c.key === 'priority'),
      ),
    );
  }
  if (!tasks.length)
    children.push(
      para('No tasks match the chosen scope.', { color: '6B7280' }),
    );
  const doc = new Document({
    creator: 'WorkSync',
    title: `${h.project.name} ${title}`,
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: FONT, eastAsia: FONT, hAnsi: FONT, cs: FONT },
            size: 21,
          },
        },
        title: {
          run: {
            font: { ascii: FONT, eastAsia: FONT, hAnsi: FONT },
            size: 36,
            bold: true,
            color: '1C1F24',
          },
        },
        heading2: {
          run: {
            font: { ascii: FONT, eastAsia: FONT, hAnsi: FONT },
            size: 26,
            bold: true,
            color: '1C1F24',
          },
          paragraph: { spacing: { before: 240, after: 100 } },
        },
        heading3: {
          run: {
            font: { ascii: FONT, eastAsia: FONT, hAnsi: FONT },
            size: 22,
            bold: true,
            color: '1C1F24',
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            // A4: 210 × 297 mm, with 2 cm margins.
            size: {
              width: 11906,
              height: 16838,
              orientation: landscape
                ? PageOrientation.LANDSCAPE
                : PageOrientation.PORTRAIT,
            },
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        children: [
          ...children,
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { before: 240 },
            children: [
              new TextRun({
                text: tr(h, 'Made with WorkSync', 'WorkSyncで作成'),
                color: '9AA0A8',
                size: 16,
              }),
            ],
          }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/** Builds a report as a file's bytes. */
export async function buildReport(
  project: Project,
  tasks: Task[],
  options: ReportOptions,
  today: string,
): Promise<Buffer> {
  if (!REPORTS[options.kind].formats.includes(options.format))
    throw new Error(
      `${REPORTS[options.kind].name} is made as ${REPORTS[options.kind].formats.join(' or ')}.`,
    );
  const h: ReportHead = {
    project,
    options,
    today,
    asOf: newestAsOf(tasks, today),
  };
  return options.format === 'xlsx'
    ? xlsxReport(h, tasks)
    : docxReport(h, tasks);
}
