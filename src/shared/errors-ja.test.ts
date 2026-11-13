import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERRORS_JA } from './errors-ja';
import { translateMessage } from './i18n';

describe('messages from the main process in Japanese', () => {
  it('translates a refusal and keeps the parts that change', () => {
    expect(
      translateMessage(
        'ja',
        'No. 012 is already used by another task in this project. Choose another number, or leave it empty for the next one.',
      ),
    ).toBe(
      'No. 012 はこのプロジェクトの別のタスクが使っています。別の番号にするか、空にして次の番号を使ってください。',
    );
    expect(
      translateMessage(
        'ja',
        'This folder is inside Box, where the customer could see it. Choose another folder.',
      ),
    ).toBe(
      'このフォルダーは Box の中にあり、お客様から見える可能性があります。別のフォルダーを選んでください。',
    );
    expect(translateMessage('en', 'A task needs a title.')).toBe(
      'A task needs a title.',
    );
    expect(translateMessage('ja', 'Something nobody translated.')).toBe(
      'Something nobody translated.',
    );
  });
  it('has Japanese for every message the main process writes', () => {
    const known = ERRORS_JA.map(([en]) => en);
    const missing: string[] = [];
    for (const dir of ['../main', '.']) {
      const folder = path.join(__dirname, dir);
      for (const f of fs.readdirSync(folder)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
        const src = fs.readFileSync(path.join(folder, f), 'utf8');
        for (const m of src.matchAll(
          /new (?:Error|UnreadableFileError)\(\s*(['`])([\s\S]*?)\1\s*[,)]/g,
        )) {
          let n = 0;
          const tpl = m[2]
            .replace(/\$\{[^}]*\}/g, () => `{${n++}}`)
            .replace(/\\\\/g, '\\');
          if (!known.includes(tpl)) missing.push(`${f}: ${tpl}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
