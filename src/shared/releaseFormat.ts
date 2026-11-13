/**
 * The release import format: one row per released file, its release's
 * fields repeated on each row. A row without a file carries only the
 * release's own text (its summary, purpose, changes and verification).
 *
 * Columns are found by their heading, in English or Japanese, in any order.
 * Free of Node.js and Electron imports: the import, the empty sheet and the
 * instructions for an AI share it.
 */

export type ImportColumn =
  | 'date'
  | 'product'
  | 'edition'
  | 'version'
  | 'status'
  | 'summary'
  | 'fileName'
  | 'module'
  | 'type'
  | 'destination'
  | 'category'
  | 'environment'
  | 'fileVersion'
  | 'changes'
  | 'purpose'
  | 'verification';

export interface ColumnInfo {
  key: ImportColumn;
  en: string;
  ja: string;
  /** Other headings that mean it (compared without case, spaces or marks). */
  also: string[];
  /** What goes in it, for the instructions. */
  help: string;
  required?: boolean;
}

export const IMPORT_COLUMNS: ColumnInfo[] = [
  {
    key: 'date',
    en: 'Release date',
    ja: 'リリース日',
    also: ['date', '日付', 'released on'],
    help: 'YYYY/MM/DD. Empty for a planned release.',
  },
  {
    key: 'product',
    en: 'Product',
    ja: '製品',
    also: ['プロダクト', 'component'],
    help: 'The product or component released, e.g. EMVCon.',
    required: true,
  },
  {
    key: 'edition',
    en: 'Edition',
    ja: '対象版',
    also: ['target', 'target edition'],
    help: 'The edition the release is for, e.g. Target A.',
  },
  {
    key: 'version',
    en: 'Release version',
    ja: 'リリースバージョン',
    also: ['release ver', 'リリース版'],
    help: 'The version of the release as a whole, e.g. 5.5.0.',
    required: true,
  },
  {
    key: 'status',
    en: 'Status',
    ja: '状態',
    also: ['ステータス'],
    help: 'Released or Planned. Empty: Released when there is a date.',
  },
  {
    key: 'summary',
    en: 'Summary',
    ja: '概要',
    also: [],
    help: 'One line about the release.',
  },
  {
    key: 'fileName',
    en: 'File name',
    ja: 'ファイル名',
    also: ['file', 'モジュール／ファイル名', 'module / file name'],
    help: 'The file delivered, e.g. FakeFile_21.dll.',
  },
  {
    key: 'module',
    en: 'Module',
    ja: 'モジュール',
    also: ['module name', 'モジュール名'],
    help: 'The module the file belongs to.',
  },
  {
    key: 'type',
    en: 'Type',
    ja: '種別',
    also: ['kind'],
    help: 'The kind of file; empty: the edition.',
  },
  {
    key: 'destination',
    en: 'Destination',
    ja: '仕向け先',
    also: ['仕向先'],
    help: 'Where it is delivered.',
  },
  {
    key: 'category',
    en: 'Category',
    ja: 'カテゴリ',
    also: ['カテゴリー', '分類'],
    help: 'The category of the module.',
  },
  {
    key: 'environment',
    en: 'Environment',
    ja: '環境',
    also: ['env'],
    help: 'Dev, Stg, Prod…',
  },
  {
    key: 'fileVersion',
    en: 'File version',
    ja: 'ファイルバージョン',
    also: ['version', 'バージョン', 'ver', 'module version'],
    help: 'The version of this file, e.g. 7300_100200.',
  },
  {
    key: 'changes',
    en: 'Change log',
    ja: '内容',
    also: [
      'changes',
      '変更内容',
      '内容（改善点／変更点等）',
      'changes (improvements, changes)',
      'changelog',
    ],
    help: 'What changed; several lines are fine.',
  },
  {
    key: 'purpose',
    en: 'Purpose',
    ja: '目的',
    also: [],
    help: 'Why it changed.',
  },
  {
    key: 'verification',
    en: 'Verification',
    ja: '検証',
    also: ['test', 'テスト', '検証内容'],
    help: 'How it was checked.',
  },
];

/** A heading compared without case, width, spaces or marks. */
export const headingKey = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');

/** The column a heading means, or null. */
export function columnOf(heading: string): ImportColumn | null {
  const k = headingKey(heading);
  if (!k) return null;
  for (const c of IMPORT_COLUMNS)
    if ([c.en, c.ja, ...c.also].some((h) => headingKey(h) === k)) return c.key;
  return null;
}

/** The sheet the app writes into its own release workbook, to read it back. */
export const DATA_SHEET = { ja: '取込用データ', en: 'Import data' };

/** Instructions to give an AI, with the sheet to convert, to get an importable sheet. */
export function aiInstructions(): string {
  const cols = IMPORT_COLUMNS.map(
    (c) =>
      `- ${c.en} (or ${c.ja})${c.required ? ' — required' : ''}: ${c.help}`,
  ).join('\n');
  return `Convert the attached spreadsheet of software releases into ONE table I can import, and give it back as an .xlsx file (or as a table I can paste into Excel).

Rules:
- One row per released file. Repeat the release's date, product, edition, release version, status and summary on every row of that release.
- A release that has no file list still gets one row, with the file columns left empty.
- Use exactly these column headings, in this order, in the first row:
${cols}
- Release date as YYYY/MM/DD. Leave it empty for a release that is only planned, and write Planned in Status.
- Copy the text as it is, in its own language. Do not translate, shorten or invent anything; leave a cell empty when the sheet does not say.
- If the sheet has other columns about each file (a ticket number, a checksum…), keep them as extra columns after Verification, with their own heading.
- No merged cells, no title rows above the headings, no totals.

Example rows:
Release date | Product | Edition | Release version | Status | Summary | File name | Module | Type | Destination | Category | Environment | File version | Change log | Purpose | Verification
2026/08/21 | EMVCon | Target A | 5.5.0 | Released | New payment terminal | FakeFile_21.dll | Module X | Target A | Destination C | Category 4 | Prod | 7300_100200 | Added the new terminal. | Customer request | Stg test passed
2026/08/21 | EMVCon | Target A | 5.5.0 | Released | New payment terminal | FakeFile_34.exe | Module W | Target A | Destination C | Category 1 | Prod | 2.4.0 | | |`;
}
