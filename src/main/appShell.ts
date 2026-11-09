import { app, BrowserWindow, Menu, nativeTheme, Tray } from 'electron';
import type { AppSettings } from '../shared/settings';
import { resolveUiLanguage, translate } from '../shared/i18n';
import { trayImage } from './windowChrome';

/**
 * What the app does around its window: the theme, the tray icon, and
 * whether closing the window hides it or quits. Nothing here is written to
 * the system: WorkSync doesn't start with Windows.
 */

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let current: AppSettings | null = null;
/** Extra tray menu items added by other features, such as quick search. */
const extraItems: Electron.MenuItemConstructorOptions[] = [];

/** The app's main window, for dialogs and messages; null before it opens. */
export const getMainWindow = (): BrowserWindow | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;

/** Brings the main window to the front, also from the tray. */
export function showMainWindow(): void {
  const w = getMainWindow();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/** Quits for real, even when closing would only hide the window. */
export function quitApp(): void {
  quitting = true;
  app.quit();
}

/** Lets the window close: the app is quitting, from any menu or the OS. */
export function markQuitting(): void {
  quitting = true;
}

/** True once the app is quitting, so the window may close. */
export const isQuitting = (): boolean => quitting;

/** Called by the main process for the main window, once. */
export function attachMainWindow(w: BrowserWindow): void {
  mainWindow = w;
  w.on('close', (e) => {
    if (quitting || !current?.keepInTray || !tray) return;
    // Keep running for reminders and the shortcut; quit from the tray.
    e.preventDefault();
    w.hide();
  });
  w.on('closed', () => {
    if (mainWindow === w) mainWindow = null;
    // The hidden quick-search window must not keep WorkSync running.
    if (!tray) quitApp();
  });
}

/** A tray item another feature adds, shown above Quit. */
export function addTrayItem(item: Electron.MenuItemConstructorOptions): void {
  extraItems.push(item);
  if (tray) tray.setContextMenu(trayMenu());
}

/** The tray menu in the app language. */
const trayMenu = () => {
  const lang = resolveUiLanguage(
    current?.uiLanguage ?? 'system',
    app.getLocale(),
  );
  const tr = (s: string) => translate(lang, s);
  return Menu.buildFromTemplate([
    { label: tr('Open WorkSync'), click: showMainWindow },
    ...extraItems.map((i) => ({ ...i, label: tr(String(i.label)) })),
    { type: 'separator' },
    { label: tr('Quit WorkSync'), click: quitApp },
  ]);
};

/** Applies the settings that live outside the page: theme and tray. */
export function applyAppSettings(s: AppSettings): void {
  const languageChanged = current?.uiLanguage !== s.uiLanguage;
  current = s;
  nativeTheme.themeSource = s.theme;
  if (tray && languageChanged) tray.setContextMenu(trayMenu());
  if (s.keepInTray && !tray) {
    try {
      tray = new Tray(trayImage());
      tray.setToolTip('WorkSync');
      tray.setContextMenu(trayMenu());
      tray.on('click', showMainWindow);
    } catch {
      // No tray on this desktop: closing the window then quits.
      tray = null;
    }
  } else if (!s.keepInTray && tray) {
    tray.destroy();
    tray = null;
  }
}

/** True while the tray icon is there, so the app keeps running without its window. */
export const inTray = (): boolean => !!tray;
