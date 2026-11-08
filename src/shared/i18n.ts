/**
 * The language of WorkSync's own screens (menus, buttons, messages). It is
 * separate from a project's languages, which decide translations and reports.
 * English text is the key: a text without a translation shows in English.
 */
import { JA } from './i18n-ja';
import { ERRORS_JA, ERROR_PARTS_JA } from './errors-ja';

export type UiLanguage = 'en' | 'ja';
/** System follows the computer's language, or English when WorkSync doesn't have it. */
export type UiLanguageChoice = 'system' | UiLanguage;

export const UI_LANGUAGES: Record<UiLanguage, string> = {
  en: 'English',
  ja: '日本語',
};

export function resolveUiLanguage(
  choice: UiLanguageChoice,
  locale: string,
): UiLanguage {
  if (choice !== 'system') return choice;
  return locale.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** The text in this language, with {name} parts filled in. */
export function translate(
  lang: UiLanguage,
  text: string,
  vars?: Record<string, string | number>,
): string {
  const s = lang === 'ja' ? (JA[text] ?? text) : text;
  return vars
    ? s.replace(/\{(\w+)\}/g, (m, k: string) =>
        k in vars ? String(vars[k]) : m,
      )
    : s;
}

const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The English messages as patterns, with {0}… matching any text. */
const ERROR_PATTERNS = ERRORS_JA.map(([en, ja]) => ({
  re: new RegExp(
    `^${en
      .split(/(\{\d\})/)
      .map((part) => (/^\{\d\}$/.test(part) ? '(.+?)' : escape(part)))
      .join('')}$`,
    's',
  ),
  holes: [...en.matchAll(/\{(\d)\}/g)].map((m) => Number(m[1])),
  ja,
}));

/**
 * A message from the main process (a refusal or an error) in the app
 * language. The parts that change, such as a file name, are kept.
 */
export function translateMessage(lang: UiLanguage, message: string): string {
  if (lang === 'en') return message;
  for (const p of ERROR_PATTERNS) {
    const m = p.re.exec(message);
    if (!m) continue;
    const values: string[] = [];
    p.holes.forEach((n, i) => (values[n] = m[i + 1]));
    return p.ja.replace(/\{(\d)\}/g, (_, n: string) => {
      const v = values[Number(n)] ?? '';
      return ERROR_PARTS_JA[v] ?? v;
    });
  }
  return JA[message] ?? message;
}
