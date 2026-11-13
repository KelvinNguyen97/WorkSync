import { describe, expect, it } from 'vitest';
import { JA } from './i18n-ja';
import { resolveUiLanguage, translate } from './i18n';
import { reminderText } from './myTasks';

describe('app language', () => {
  it('follows the computer, or English when WorkSync does not have its language', () => {
    expect(resolveUiLanguage('system', 'ja-JP')).toBe('ja');
    expect(resolveUiLanguage('system', 'vi-VN')).toBe('en');
    expect(resolveUiLanguage('system', 'en-US')).toBe('en');
    expect(resolveUiLanguage('en', 'ja-JP')).toBe('en');
  });
  it('translates, fills in values, and keeps English without a translation', () => {
    expect(translate('ja', 'My tasks')).toBe('マイタスク');
    expect(translate('ja', 'Overdue by {n} days', { n: 3 })).toBe('3 日超過');
    expect(translate('ja', 'A text nobody translated')).toBe(
      'A text nobody translated',
    );
    expect(translate('en', 'Overdue by {n} days', { n: 3 })).toBe(
      'Overdue by 3 days',
    );
  });
  it('has Japanese for every value it needs to fill in', () => {
    for (const [en, ja] of Object.entries(JA)) {
      const need = [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const have = [...ja.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect([en, have]).toEqual([en, need]);
    }
  });
  it('writes reminders in the app language', () => {
    const t = {
      title: '経費精算',
      status: 'todo' as const,
      priority: 'U' as const,
      dueDate: '2026-11-05',
    };
    expect(reminderText(t, '2026-11-06').body).toBe(
      'Urgent · Todo · overdue since 2026/11/05',
    );
    expect(
      reminderText(t, '2026-11-06', (s, v) => translate('ja', s, v)).body,
    ).toBe('緊急 · 未着手 · 2026/11/05 から期限切れ');
  });
});
