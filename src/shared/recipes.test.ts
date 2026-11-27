import { describe, expect, it } from 'vitest';
import {
  STARTERS,
  allText,
  blankKeys,
  buildRequest,
  followUpRequest,
  isOptional,
  missingBlanks,
  readRecipeAnswer,
  syncBlanks,
  type Recipe,
} from './recipes';

describe('recipes', () => {
  it('finds the blanks in the instructions, each once, in order', () => {
    expect(
      blankKeys(
        'Hi {{ customer }}, {{vendor}} and {{customer}} again; {{their email}} {not}',
      ),
    ).toEqual(['customer', 'vendor', 'their email']);
  });

  it('keeps the settings of blanks still named, and adds new ones', () => {
    const old = syncBlanks('{{a}} {{b}}', []).map((b) =>
      b.key === 'a'
        ? { ...b, label: 'Customer', remember: true, last: 'X' }
        : b,
    );
    const next = syncBlanks('{{b}} then {{a}} and {{c}}', old);
    expect(next.map((b) => b.key)).toEqual(['b', 'a', 'c']);
    expect(next[1]).toMatchObject({
      label: 'Customer',
      remember: true,
      last: 'X',
    });
    expect(next[2]).toMatchObject({ label: 'C', kind: 'short' });
  });

  it('builds the request: values, glossary terms used, and the sections', () => {
    const r = {
      instructions: 'Translate for {{who}}:\n{{text}}',
      sections: ['Corrected', ' ', 'Translation'],
    };
    const req = buildRequest(
      r,
      { who: 'Tanaka', text: '受入テストは来週です' },
      [
        { term: '受入テスト', translation: 'acceptance test', note: '' },
        { term: '本番', translation: 'production', note: '' },
      ],
    );
    expect(req).toContain('Translate for Tanaka:\n受入テストは来週です');
    expect(req).toContain('- 受入テスト = acceptance test');
    expect(req).not.toContain('本番');
    expect(req).toMatch(/=== Corrected ===\n=== Translation ===$/);
    // No sections and no glossary: only the instructions, filled in.
    expect(
      buildRequest({ instructions: 'Fix: {{x}}', sections: [] }, { x: ' a ' }),
    ).toBe('Fix: a');
  });

  it('reads the sections and drops what comes before them', () => {
    const answer = [
      'Sure! Here is your answer:',
      '',
      '**=== Corrected ===**',
      'We have fixed it.',
      '',
      '=== translation ===',
      '修正しました。',
    ].join('\n');
    const r = readRecipeAnswer(answer, [
      'Corrected',
      'Translation',
      'What changed',
    ]);
    expect(r.ok).toBe(true);
    expect(r.sections).toEqual([
      { title: 'Corrected', text: 'We have fixed it.' },
      { title: 'Translation', text: '修正しました。' },
      { title: 'What changed', text: '' },
    ]);
    expect(allText(r.sections)).toContain('Corrected\nWe have fixed it.');
    expect(readRecipeAnswer('No markers at all', ['Corrected'])).toEqual({
      sections: [{ title: '', text: 'No markers at all' }],
      ok: false,
    });
    expect(readRecipeAnswer('```\nJust this\n```', [])).toEqual({
      sections: [{ title: '', text: 'Just this' }],
      ok: true,
    });
  });

  it('asks for a follow-up with the previous answer', () => {
    const f = followUpRequest('REQ', ' ANS ', 'Shorter');
    expect(f).toContain('REQ\n\n--- Your previous answer ---\nANS');
    expect(f).toContain('Make it shorter.');
    expect(followUpRequest('R', 'A', 'Use bullet points')).toContain(
      'Use bullet points',
    );
  });

  it('needs every blank except the optional ones', () => {
    const r = {
      blanks: syncBlanks('{{a}} {{b}}', []).map((b) =>
        b.key === 'b' ? { ...b, label: 'Note (optional)' } : b,
      ),
    } as Recipe;
    expect(isOptional(r.blanks[1])).toBe(true);
    expect(missingBlanks(r, { a: ' ' }).map((b) => b.key)).toEqual(['a']);
    expect(missingBlanks(r, { a: 'x' })).toEqual([]);
  });

  it('starters name every blank their instructions use', () => {
    for (const s of STARTERS)
      expect(s.blanks.map((b) => b.key).sort()).toEqual(
        blankKeys(s.instructions).sort(),
      );
  });
});
