import { describe, expect, it } from 'vitest';
import {
  continueList,
  parseInline,
  parseRich,
  richFirstLine,
  richPlain,
  safeHref,
  toggleLines,
  toggleWrap,
} from './rich';

describe('rich text', () => {
  it('reads headings, lists with nesting, check items, quotes, code and rules', () => {
    const b = parseRich(
      [
        '# Cause',
        'Shift-JIS files are read as **UTF-8**.',
        'Second line.',
        '',
        '- Osaka',
        '  - only *new* files',
        '- Tokyo',
        '1. Detect',
        '2. Test',
        '- [x] done',
        '- [ ] open',
        '> quoted',
        '```',
        'a * b * c',
        '```',
        '---',
      ].join('\n'),
    );
    expect(b.map((x) => x.t)).toEqual([
      'h',
      'p',
      'ul',
      'ol',
      'ul',
      'quote',
      'code',
      'hr',
    ]);
    expect(b[1]).toMatchObject({
      lines: [
        [{ t: 'text' }, { t: 'b' }, { t: 'text', v: '.' }],
        [{ t: 'text', v: 'Second line.' }],
      ],
    });
    const ul = b[2] as Extract<(typeof b)[number], { t: 'ul' }>;
    expect(ul.items).toHaveLength(2);
    expect(ul.items[0].children[0]).toMatchObject({
      t: 'ul',
      items: [{ c: [[{ t: 'text' }, { t: 'i' }, { t: 'text' }]] }],
    });
    expect(b[3]).toMatchObject({ t: 'ol', start: 1 });
    expect((b[4] as typeof ul).items.map((i) => i.checked)).toEqual([
      true,
      false,
    ]);
    expect(b[6]).toEqual({ t: 'code', v: 'a * b * c' });
  });

  it('leaves ordinary text alone', () => {
    const plain = [
      '2 * 3 * 4 = 24',
      'file_name_like_this.txt',
      'Issue #12 and C# code',
      'a_b and 5*5',
    ];
    for (const p of plain)
      expect(parseInline(p)).toEqual([{ t: 'text', v: p }]);
    expect(parseRich('#12 is not a heading')[0].t).toBe('p');
    // Japanese text with marks
    expect(parseInline('これは**重要**です')).toEqual([
      { t: 'text', v: 'これは' },
      { t: 'b', c: [{ t: 'text', v: '重要' }] },
      { t: 'text', v: 'です' },
    ]);
  });

  it('links only web and mail addresses', () => {
    expect(parseInline('see https://example.com/a?b=1.')).toEqual([
      { t: 'text', v: 'see ' },
      {
        t: 'link',
        href: 'https://example.com/a?b=1',
        c: [{ t: 'text', v: 'https://example.com/a?b=1' }],
      },
      { t: 'text', v: '.' },
    ]);
    expect(parseInline('[spec](https://x.test/s)')[0]).toMatchObject({
      t: 'link',
      href: 'https://x.test/s',
    });
    expect(parseInline('[bad](javascript:alert(1))')[0].t).toBe('text');
    expect(safeHref('file:///c:/x')).toBeNull();
  });

  it('gives the text without marks for reports', () => {
    expect(
      richPlain(
        '## Plan\n- **Detect** the encoding\n  - only Osaka\n1. Test\n2. [Spec](https://x.test)\n\nDone ~~soon~~ `now`',
      ),
    ).toBe(
      'Plan\n• Detect the encoding\n  • only Osaka\n1. Test\n2. Spec (https://x.test)\nDone soon now',
    );
    expect(richPlain('Plain text\nwith two lines')).toBe(
      'Plain text\nwith two lines',
    );
    expect(richFirstLine('\n# Title\nmore')).toBe('Title');
  });

  it('edits: wrap, lines and list continuation', () => {
    expect(toggleWrap('make bold now', 5, 9, '**')).toEqual({
      text: 'make **bold** now',
      start: 7,
      end: 11,
    });
    expect(toggleWrap('make **bold** now', 7, 11, '**')).toEqual({
      text: 'make bold now',
      start: 5,
      end: 9,
    });
    expect(toggleLines('a\nb', 0, 3, 'ol').text).toBe('1. a\n2. b');
    expect(toggleLines('- a\n- b', 0, 7, 'ul').text).toBe('a\nb');
    expect(toggleLines('- a', 0, 3, 'ol').text).toBe('1. a');
    expect(toggleLines('title', 2, 2, 'h').text).toBe('## title');
    // On an empty line the cursor lands after the mark, so typing keeps it.
    expect(toggleLines('a\n', 2, 2, 'ul')).toEqual({
      text: 'a\n- ',
      start: 4,
      end: 4,
    });
    expect(toggleLines('a\nb', 0, 3, 'ul')).toMatchObject({ start: 0, end: 7 });
    expect(continueList('- one', 5)).toEqual({
      text: '- one\n- ',
      start: 8,
      end: 8,
    });
    expect(continueList('  3. three', 10)?.text).toBe('  3. three\n  4. ');
    expect(continueList('- [x] a', 7)?.text).toBe('- [x] a\n- [ ] ');
    expect(continueList('- one\n- ', 8)).toEqual({
      text: '- one\n',
      start: 6,
      end: 6,
    });
    expect(continueList('plain', 5)).toBeNull();
  });
});
