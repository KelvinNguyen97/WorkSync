import {
  resolveUiLanguage,
  translate,
  type UiLanguage,
  type UiLanguageChoice,
} from '../shared/i18n';

/** The language of the screens now; set from Settings before each render. */
let current: UiLanguage = resolveUiLanguage('system', navigator.language);

export function setUiLanguage(choice: UiLanguageChoice): UiLanguage {
  current = resolveUiLanguage(choice, navigator.language);
  document.documentElement.lang = current;
  return current;
}

export const uiLanguage = (): UiLanguage => current;

/**
 * The theme chosen in Settings, on the page itself: it does not depend on
 * the system telling the page whether it is dark.
 */
export function setTheme(theme: 'system' | 'light' | 'dark'): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** WorkSync's own text in the chosen language; English when there is no translation. */
export const tr = (text: string, vars?: Record<string, string | number>) =>
  translate(current, text, vars);

/** A deadline from the task model ("Overdue by 2 days", "Due in 3 days", "Due 15 Nov") in the app language. */
export function trDeadline(text: string): string {
  let m = /^Overdue by (\d+) days?$/.exec(text);
  if (m)
    return tr(m[1] === '1' ? 'Overdue by {n} day' : 'Overdue by {n} days', {
      n: m[1],
    });
  m = /^Due in (\d+) days?$/.exec(text);
  if (m) return tr('Due in {n} days', { n: m[1] });
  if (text === 'Due today') return tr('Due today');
  m = /^Due (.+)$/.exec(text);
  if (m) return tr('Due {date}', { date: m[1] });
  return tr(text);
}

/** A focus reason from the task model ("Planned to start 5 Nov") in the app language. */
export function trReason(text: string): string {
  let m = /^Next step was due (.+)$/.exec(text);
  if (m) return tr('Next step was due {date}', { date: m[1] });
  m = /^Planned to start (.+)$/.exec(text);
  if (m) return tr('Planned to start {date}', { date: m[1] });
  m = /^Your action: (.+)$/s.exec(text);
  if (m) return tr('Your action: {action}', { action: m[1] });
  return tr(text);
}
