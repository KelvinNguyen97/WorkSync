/**
 * History entries in Japanese. The app writes each entry in English when it
 * happens ("Status In progress → Done."); in Japanese mode the history shows
 * them in Japanese. Only the app's own wording is translated: names, notes
 * and other text the owner or the customer wrote stay as they are.
 */
import { JA } from './i18n-ja';

/** A word the app itself puts in an entry (a status, a field…), in Japanese. */
const word = (w: string): string => {
  const t = w.trim();
  if (t === '(empty)') return '（空）';
  if (t === '(none)') return '（なし）';
  return JA[t] ?? t;
};
/** "Status, Priority" → "状態、優先度". */
const words = (list: string, sep = ', ') =>
  list
    .split(sep)
    .map((w) => word(w))
    .join('、');

/** "Status 未着手 → 対応中; Title A → B": labels and values the app knows. */
const changes = (text: string) =>
  text
    .split('; ')
    .map((part) => {
      if (part === 'Back in the file') return 'ファイルに戻りました';
      const m = /^(.+?) (.*) → (.*)$/.exec(part);
      if (!m) return part;
      // The label is the longest known field name at the start.
      const labels = Object.keys(JA)
        .filter((k) => part.startsWith(`${k} `))
        .sort((a, b) => b.length - a.length);
      const label = labels[0];
      if (!label) return part;
      const rest = part.slice(label.length + 1);
      const arrow = rest.lastIndexOf(' → ');
      if (arrow < 0) return part;
      return `${word(label)} ${word(rest.slice(0, arrow))} → ${word(rest.slice(arrow + 3))}`;
    })
    .join('、');

const RULES: [RegExp, (...m: string[]) => string][] = [
  [/^Added by hand\.$/, () => '手動で追加しました。'],
  [
    /^Read from (.+), row (\d+)\.$/,
    (f, r) => `${f} の ${r} 行目から読み込みました。`,
  ],
  [
    /^Matched in (.+), row (\d+)\.$/,
    (f, r) => `${f} の ${r} 行目と照合しました。`,
  ],
  [
    /^No longer in (.+)\. The task is kept with its history\.$/,
    (f) => `${f} にはもうありません。タスクは履歴ごと残します。`,
  ],
  [
    /^Joined by hand to row (\d+) of (.+?)(?:, No\. (.+) → (.+))?\.$/,
    (r, f, a, b) =>
      `${f} の ${r} 行目に手動で結び付けました${a ? `（No. ${word(a)} → ${word(b)}）` : ''}。`,
  ],
  [/^From (.+?): (.+)\.$/, (f, list) => `${f} から：${changes(list)}。`],
  [
    /^Written to (.+?): (.+)\.$/,
    (f, list) => `${f} に書き込みました：${changes(list)}。`,
  ],
  [
    /^Moved to the Board column (.+)\.$/,
    (c) => `ボードの列「${c}」に移しました。`,
  ],
  [/^Status (.+) → (.+)\.$/, (a, b) => `状態 ${word(a)} → ${word(b)}。`],
  [/^Priority (.+) → (.+)\.$/, (a, b) => `優先度 ${word(a)} → ${word(b)}。`],
  [
    /^Language (.+) → (.+?)(, chosen by you)?\.$/,
    (a, b, mine) =>
      `言語 ${word(a)} → ${word(b)}${mine ? '（手動で選択）' : ''}。`,
  ],
  [/^Changed who can resolve: (.+)\.$/, (t) => `解決する人を変更：${t}。`],
  [/^Changed (.+)\.$/, (list) => `変更：${words(list)}。`],
  [
    /^Set to (\w+) for you\. The task's own level is (\w+)\.$/,
    (a, b) =>
      `あなたの優先度を ${word(a)} にしました。タスク本来の優先度は ${word(b)} です。`,
  ],
  [/^Removed\.$/, () => '解除しました。'],
  [/^Confirmed the situation\.$/, () => '状況を確認しました。'],
  [/^Reopened: (.+)\.$/, (t) => `再開：${t}。`],
  [/^Resolved: (.+)\.$/, (t) => `解決：${t}。`],
  [/^Deleted: (.+)\.$/, (t) => `削除：${t}。`],
  [/^Corrected: (.+) → (.+)\.$/, (a, b) => `修正：${a} → ${b}。`],
  [
    /^Corrected ([a-z ,]+)\.$/,
    (list) =>
      `修正：${list
        .split(', ')
        .map((w) => word(w.charAt(0).toUpperCase() + w.slice(1)))
        .join('、')}。`,
  ],
  [
    /^Your notes translated for reports and briefs\.$/,
    () => '自分用メモをレポートと概要用に翻訳しました。',
  ],
  [
    /^Filled in the (.+) from a Gemini batch\.$/,
    (list) => `Gemini の一括処理で${words(list, ' and ')}を入力しました。`,
  ],
];

/** Parts of an entry that come together: situation updates and links. */
const PARTS: [RegExp, string][] = [
  [/(^|\. )Doing now: /g, `$1${JA['Doing now']}：`],
  [/(^|\. )Next: /g, `$1${JA['Next step']}：`],
  [/ by (\d{4}\/\d\d\/\d\d)\./g, '（期限 $1）。'],
  [/(^|\. )New difficulty: /g, '$1新しい課題：'],
  [/(^|\. )Added link /g, '$1リンクを追加：'],
  [/(^|\. )Removed link /g, '$1リンクを削除：'],
];

export function historyJa(text: string): string {
  for (const [re, to] of RULES) {
    const m = re.exec(text);
    if (m) return to(...m.slice(1));
  }
  let out = text;
  for (const [re, to] of PARTS) out = out.replace(re, to);
  return out;
}
