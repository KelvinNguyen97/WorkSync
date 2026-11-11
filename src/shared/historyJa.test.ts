import { describe, expect, it } from 'vitest';
import { historyJa } from './historyJa';

describe('history entries in Japanese', () => {
  it('translates the app’s own wording and keeps the owner’s text', () => {
    expect(historyJa('Added by hand.')).toBe('手動で追加しました。');
    expect(historyJa('Status In progress → Done.')).toBe(
      '状態 対応中 → 完了。',
    );
    expect(historyJa('Priority Normal → Urgent.')).toBe('優先度 通常 → 緊急。');
    expect(historyJa('Changed Summary, Planned end.')).toBe(
      '変更：要約、予定終了。',
    );
    expect(
      historyJa('Doing now: 出荷CSVを確認. Next: 顧客に連絡 by 2026/11/20.'),
    ).toBe(
      '現在の作業：出荷CSVを確認. 次の手順：顧客に連絡（期限 2026/11/20）。',
    );
    expect(historyJa('Resolved: No access.')).toBe('解決：No access。');
    expect(historyJa('Changed who can resolve: Tanaka.')).toBe(
      '解決する人を変更：Tanaka。',
    );
    expect(
      historyJa(
        'From WBS.xlsx: Status 未着手 → 対応中; Title (empty) → ログイン.',
      ),
    ).toBe('WBS.xlsx から：状態 未着手 → 対応中、タイトル （空） → ログイン。');
    expect(historyJa('Corrected doing now, next step.')).toBe(
      '修正：現在の作業、次の手順。',
    );
    expect(historyJa('Something the app never wrote')).toBe(
      'Something the app never wrote',
    );
  });
});
