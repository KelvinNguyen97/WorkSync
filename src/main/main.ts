import { app, BrowserWindow, nativeTheme, session } from 'electron';
import path from 'node:path';
import { log } from './log';
import {
  chromeOptions,
  followTheme,
  glassKind,
  taskbarIcon,
} from './windowChrome';
import { koffiLoads } from './everything';
import {
  addTrayItem,
  applyAppSettings,
  attachMainWindow,
  inTray,
  markQuitting,
  showMainWindow,
} from './appShell';
import {
  appSettings,
  backupTick,
  checkLinkedFiles,
  closeStore,
  openInWindow,
  publishOnClose,
  registerIpcHandlers,
  remindMyTasks,
} from './ipc';
import {
  dropQuickSearchKey,
  setQuickSearchKey,
  showQuickSearch,
} from './quickSearch';

/** Linked files are checked at start, when the window comes to the front, and every few minutes (spec 04). */
const CHECK_EVERY_MS = 3 * 60 * 1000;

const createWindow = (): void => {
  const glass = glassKind();
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'WorkSync',
    // Matches the window color of the theme, so nothing flashes while it loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#10141b' : '#f6f7f9',
    autoHideMenuBar: true,
    // WorkSync's own title bar, with glass where the system has it.
    ...chromeOptions(glass),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // The renderer is treated as untrusted web content: it gets no Node.js
      // access and talks to the main process only through the preload API.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Windows and macOS use the system's spell checker. On Linux, Electron
      // would download dictionaries from Google, and WorkSync makes no network
      // requests, so spell checking is off there.
      spellcheck: process.platform !== 'linux',
    },
  });

  // The page needs to know which glass it is on before it first paints.
  const query = { glass, platform: process.platform };
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(
      `${MAIN_WINDOW_VITE_DEV_SERVER_URL}?${new URLSearchParams(query)}`,
    );
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { query },
    );
  }
  followTheme(mainWindow);
  taskbarIcon(mainWindow);

  attachMainWindow(mainWindow);
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

// One WorkSync at a time: a second start brings the running one to the front,
// so two copies never write the same database.
// Windows shows notifications under this name, and needs it to show them at all.
if (process.platform === 'win32') app.setAppUserModelId('com.worksync.desktop');

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', showMainWindow);

app.whenReady().then(() => {
  if (!primary) return;
  // See spellcheck above: no dictionary downloads on Linux.
  if (process.platform === 'linux') {
    session.defaultSession.setSpellCheckerEnabled(false);
    session.defaultSession.setSpellCheckerDictionaryDownloadURL(
      'http://127.0.0.1:9/',
    );
  }
  registerIpcHandlers();
  applyAppSettings(appSettings());
  createWindow();
  setInterval(checkLinkedFiles, CHECK_EVERY_MS);
  // My tasks reminders: every 5 minutes, and shortly after start.
  setTimeout(() => remindMyTasks(), 20 * 1000);
  setInterval(() => remindMyTasks(), 5 * 60 * 1000);
  // The quick-search shortcut, from any app.
  const key = appSettings().quickSearchKey;
  if (key && !setQuickSearchKey(key))
    log('info', `The quick-search shortcut ${key} is taken by another app`);
  addTrayItem({ label: 'Quick search', click: showQuickSearch });
  // For the end-to-end tests: open the quick-search box at start.
  if (process.env.WORKSYNC_TEST_QUICK) setTimeout(showQuickSearch, 2500);
  if (process.env.WORKSYNC_TEST_KOFFI) log('info', koffiLoads());
  addTrayItem({
    label: 'Catalog',
    click: () => openInWindow({ page: 'catalog' }),
  });
  addTrayItem({
    label: 'My tasks',
    click: () => openInWindow({ page: 'myTasks' }),
  });
  // The day's backup, taken once the date changes while the app runs.
  setInterval(backupTick, 60 * 60 * 1000);
  app.on('browser-window-focus', () => checkLinkedFiles());

  // On macOS it's common to re-create a window when the dock icon is clicked
  // and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS, where apps stay active
// until the user quits explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !inTray()) {
    app.quit();
  }
});

// Publish first, while the database is still open (spec 05, publish when it closes).
let published = false;
app.on('before-quit', () => {
  // The window may close now (it only hides while WorkSync keeps running).
  markQuitting();
  if (published) return;
  published = true;
  publishOnClose();
});
app.on('will-quit', () => {
  dropQuickSearchKey();
  closeStore();
});
