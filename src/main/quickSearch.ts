import path from 'node:path';
import { BrowserWindow, globalShortcut, screen } from 'electron';
import { OPEN_EVENT, type OpenTarget } from '../shared/ipc';
import { log } from './log';

/**
 * The quick-search box: a small window over other apps, opened with the
 * shortcut from Settings. It searches the Catalog and Everything, and hides
 * when it loses focus, as FileManagement's does.
 */

let win: BrowserWindow | null = null;
let current: string | null = null;

function create(): BrowserWindow {
  const w = new BrowserWindow({
    width: 680,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const hash = 'quick';
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
    void w.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${hash}`);
  else
    void w.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { hash },
    );
  w.on('blur', () => w.hide());
  w.on('closed', () => {
    if (win === w) win = null;
  });
  return w;
}

/** Shows the box on the screen with the pointer, a little above the middle. */
export function showQuickSearch(): void {
  if (!win || win.isDestroyed()) win = create();
  const w = win;
  const area = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint(),
  ).workArea;
  const [ww] = w.getSize();
  w.setPosition(
    Math.round(area.x + (area.width - ww) / 2),
    Math.round(area.y + Math.max(60, area.height * 0.16)),
  );
  const reveal = () => {
    w.show();
    w.focus();
    w.webContents.send(OPEN_EVENT, { page: 'quickShown' } satisfies OpenTarget);
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal);
  else reveal();
}

export function hideQuickSearch(): void {
  win?.hide();
}

/**
 * Registers the shortcut, replacing the old one. Returns false when another
 * app already uses it; the old one then stays.
 */
export function setQuickSearchKey(accel: string | null): boolean {
  if (accel === current) return true;
  if (accel) {
    let ok = false;
    try {
      ok = globalShortcut.register(accel, showQuickSearch);
    } catch {
      ok = false;
    }
    if (!ok) {
      log('info', `The shortcut ${accel} could not be registered`);
      return false;
    }
  }
  if (current) globalShortcut.unregister(current);
  current = accel;
  return true;
}

export function dropQuickSearchKey(): void {
  globalShortcut.unregisterAll();
  current = null;
}
