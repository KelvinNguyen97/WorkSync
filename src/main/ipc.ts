import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  shell,
} from 'electron';
import { buildBatches, readAnswer } from '../shared/aiBatch';
import {
  buildOwnerBatches,
  readOwnerAnswer,
  translationMap,
  untranslated,
} from '../shared/ownerBatch';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { fileIcons } from './fileIcons';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  API_METHODS,
  channel,
  type AppInfo,
  type Startup,
  type WorkSyncApi,
} from '../shared/ipc';
import { assigneeText, linkKind, toIsoDate } from '../shared/model';
import { OPEN_EVENT, SOURCES_EVENT, type OpenTarget } from '../shared/ipc';
import { reminderKey, reminderText } from '../shared/myTasks';
import { noteLinks } from '../shared/notes';
import { resolveUiLanguage, translate, translateMessage } from '../shared/i18n';
import { pathKey, type EntryKind } from '../shared/catalog';
import { everythingStatus, searchEverything } from './everything';
import { hideQuickSearch, setQuickSearchKey } from './quickSearch';
import { spawn } from 'node:child_process';
import { Mine } from './mine';
import { dataFolderPath, isNetworkPath } from './dataFolder';
import { writeTargetProblem } from './fileLinks';
import { SCHEMA_VERSION, migrate, openDatabase } from './db';
import {
  backupAtStart,
  backupBefore,
  backupDaily,
  inspectBackup,
  listBackups,
  replaceDatabase,
} from './backups';
import { log, logFolder, startLog } from './log';
import { exportProject, importProject, readExport } from './projectTransfer';
import {
  applyMerge,
  mergeTargets,
  planMerge,
  startMerge,
  type MergeSession,
} from './projectMerge';
import {
  DEFAULT_SETTINGS,
  sharedFolderWarning,
  type AppSettings,
  type StorageInfo,
} from '../shared/settings';
import { applyAppSettings, getMainWindow, showMainWindow } from './appShell';
import { addSampleProject } from './sample';
import { FileLinks } from './fileLinks';
import { CopyWriter } from './copyWriter';
import { buildReport } from './reportFiles';
import { reportFileName, reportTasks } from '../shared/reports';
import { PAGE_FILE, Publisher } from './publisher';
import { Sources } from './sources';
import { Store } from './store';
import { UnreadableFileError } from './workbook';

let db: DatabaseSync | null = null;
let store: Store | null = null;
let sources: Sources | null = null;
let mine: Mine | null = null;
let links: FileLinks | null = null;
let publisher: Publisher | null = null;
let writer: CopyWriter | null = null;
/** Copies written in this session, which the window may open. */
const writtenCopies = new Set<string>();
/** Files the owner picked in this session; only these and linked files are read. */
const chosenFiles = new Set<string>();
let startup: Startup | null = null;
let dataFolder = '';
/** .worksync files the owner picked in this session; only these are imported. */
const chosenImports = new Set<string>();
/** Merges being looked at in the merge window, by token. */
const merges = new Map<string, MergeSession>();
/** Backup files the owner picked from elsewhere in this session. */
const chosenBackups = new Set<string>();

const defaultBackups = () => path.join(dataFolder, 'backups');
const backupFolder = () =>
  store?.getSettings().backupFolder || defaultBackups();

const today = () => toIsoDate(new Date());

/** Opens the data folder and the database once, backing up first. */
function open(): Startup {
  if (startup)
    return startup.ok
      ? {
          ...startup,
          projects: store!.listProjects(),
          tasks: store!.listTasks(),
          sources: sources!.list(),
          settings: store!.getSettings(),
          people: store!.listPeople(),
          glossary: store!.listGlossary(),
          today: today(),
        }
      : startup;
  dataFolder = dataFolderPath();
  try {
    if (isNetworkPath(dataFolder)) {
      throw new Error(
        `The data folder ${dataFolder} is on a network drive, where the database can be damaged. Move the WorkSync folder to a local drive, such as C: or D:, and start it again.`,
      );
    }
    fs.mkdirSync(dataFolder, { recursive: true });
    startLog(path.join(dataFolder, 'logs'));
    log('info', `WorkSync ${app.getVersion()} started, data in ${dataFolder}`);
    const file = path.join(dataFolder, 'worksync.db');
    const existed = fs.existsSync(file);
    db = openDatabase(file);
    let chosen: string | null = null;
    try {
      const r = db
        .prepare("SELECT value FROM settings WHERE key = 'backupFolder'")
        .get() as { value: string } | undefined;
      chosen = r ? (JSON.parse(r.value) as string | null) : null;
    } catch {
      // No settings table before version 8.
    }
    const backups = chosen || path.join(dataFolder, 'backups');
    const version = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    );
    if (existed && version > 0 && version < SCHEMA_VERSION) {
      backupBefore(db, backups, 'upgrade', `v${version}`);
      log(
        'info',
        `Backed up before upgrading the data from version ${version}`,
      );
    }
    migrate(db);
    if (existed) {
      try {
        backupAtStart(db, backups, today());
      } catch (error) {
        // A missing USB drive must not stop the app; the backup is tried again later.
        log('warn', `Backup at start failed: ${String(error)}`);
      }
    }
    store = new Store(db);
    sources = new Sources(db, store);
    mine = new Mine(db);
    try {
      mine.dropUnusedNoteImages();
    } catch (error) {
      log('warn', `Could not tidy note images: ${String(error)}`);
    }
    links = new FileLinks(sources, path.join(dataFolder, 'snapshots'));
    publisher = new Publisher(store, sources, path.join(dataFolder, 'preview'));
    writer = new CopyWriter(
      db,
      store,
      sources,
      links,
      path.join(app.getPath('documents'), 'WorkSync', 'Copies'),
    );
    startup = {
      ok: true,
      dataFolder,
      today: today(),
      projects: [],
      tasks: [],
      sources: [],
      settings: store.getSettings(),
      people: [],
      glossary: [],
      warning: sharedFolderWarning(dataFolder)
        ? `The data folder ${dataFolder} is in a synced or shared folder. ${sharedFolderWarning(dataFolder)} Move the WorkSync folder to a local folder that is not synced.`
        : null,
    };
    return open();
  } catch (error) {
    log('error', `Start failed: ${String(error)}`);
    startup = {
      ok: false,
      dataFolder,
      message: error instanceof Error ? error.message : String(error),
    };
    return startup;
  }
}

const need = (): Store => {
  if (!store)
    throw new Error('The data could not be opened. Restart WorkSync.');
  return store;
};

const needMine = (): Mine => {
  if (!mine) throw new Error('The data could not be opened. Restart WorkSync.');
  return mine;
};

const needLinks = (): { sources: Sources; links: FileLinks } => {
  if (!sources || !links)
    throw new Error('The data could not be opened. Restart WorkSync.');
  return { sources, links };
};

const needWriter = (): CopyWriter => {
  if (!writer)
    throw new Error('The data could not be opened. Restart WorkSync.');
  return writer;
};

const needPublisher = (): Publisher => {
  if (!publisher)
    throw new Error('The data could not be opened. Restart WorkSync.');
  return publisher;
};

const allowed = (file: string): string => {
  if (!chosenFiles.has(file)) throw new Error('Choose the file again.');
  return file;
};

/** Turns a read error into a message the owner can act on, and marks the source. */
function readOrMark<T>(sourceId: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    needLinks().sources.setState(
      sourceId,
      error instanceof UnreadableFileError ? 'unreadable' : 'unavailable',
      msg,
    );
    notifySources();
    throw error;
  }
}

/** Tells the window that linked files changed state. */
function notifySources(): void {
  if (!sources) return;
  const list = sources.list();
  for (const w of BrowserWindow.getAllWindows())
    w.webContents.send(SOURCES_EVENT, list);
}

let checking = false;
/** Checks every linked file and tells the window. */
export function checkLinkedFiles(): void {
  if (!links || checking) return;
  checking = true;
  try {
    links.checkAll();
    notifySources();
  } finally {
    checking = false;
  }
}

const handlers: Omit<WorkSyncApi, 'onSourcesChanged' | 'onOpen'> = {
  listMyTasks: async () => needMine().listMyTasks(),
  saveMyTask: async (input, id) => needMine().saveMyTask(input, id),
  completeMyTask: async (id) => needMine().deleteMyTask(id),
  restoreMyTask: async (t) => needMine().restoreMyTask(t),
  listNotes: async () => needMine().listNotes(),
  saveNote: async (input, id) => needMine().saveNote(input, id),
  viewNote: async (id) => needMine().viewNote(id),
  deleteNote: async (id) => needMine().deleteNote(id),
  restoreNote: async (n) => needMine().restoreNote(n),
  listCatalog: async () => needMine().listCatalog(exists),
  addToCatalog: async (kind) => {
    let paths: string[];
    if (process.env.WORKSYNC_TEST_CATALOG_PATHS)
      paths = JSON.parse(process.env.WORKSYNC_TEST_CATALOG_PATHS) as string[];
    else {
      const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0];
      const r = await dialog.showOpenDialog(win, {
        title:
          kind === 'folder'
            ? 'Add folders to the Catalog'
            : 'Add apps or files to the Catalog',
        properties:
          kind === 'folder'
            ? ['openDirectory', 'multiSelections']
            : ['openFile', 'multiSelections'],
      });
      if (r.canceled) return null;
      paths = r.filePaths;
    }
    const m = needMine();
    const added = [];
    let skipped = 0;
    for (const p of paths) {
      if (m.findEntry(p)) {
        skipped++;
        continue;
      }
      added.push(m.saveEntry({ path: p, kind: kindOf(p, kind) }, exists));
    }
    return { added, skipped };
  },
  addFoundToCatalog: async (p) => {
    if (!found.has(pathKey(p))) throw new Error('Search for it again first.');
    return needMine().saveEntry({ path: p, kind: kindOf(p, 'file') }, exists);
  },
  saveCatalogEntry: async (input, id) =>
    needMine().saveEntry(input, exists, id),
  removeCatalogEntry: async (id) => needMine().deleteEntry(id, exists),
  restoreCatalogEntry: async (e) => needMine().restoreEntry(e, exists),
  openCatalogEntry: async (id) => {
    const m = needMine();
    const e = m.getEntry(id, exists);
    await openPath(e.path, e.kind);
    m.markOpened(id);
    hideQuickSearch();
    return m.getEntry(id, exists);
  },
  revealCatalogEntry: async (id) => {
    const e = needMine().getEntry(id, exists);
    if (e.missing)
      throw new Error(
        `${e.path} was not found. It may have been moved or deleted.`,
      );
    shell.showItemInFolder(e.path);
    hideQuickSearch();
  },
  searchEverything: async (query, limit) => {
    const m = needMine();
    const saved = new Set(
      m.listCatalog(() => true).map((e) => pathKey(e.path)),
    );
    const r = await searchEverything(
      query,
      need().getSettings().everything,
      (p) => saved.has(pathKey(p)),
      limit,
    );
    for (const x of r.results) found.add(pathKey(x.path));
    return r;
  },
  everythingStatus: async () =>
    everythingStatus(need().getSettings().everything),
  openFound: async (p, reveal) => {
    if (!found.has(pathKey(p))) throw new Error('Search for it again first.');
    if (reveal) shell.showItemInFolder(p);
    else await openPath(p, kindOf(p, 'file'));
    hideQuickSearch();
  },
  hideQuickSearch: async () => hideQuickSearch(),
  openNoteLink: async (noteId, url) => {
    // Only a web address written in that note opens, and only in the browser.
    if (!noteLinks(needMine().getNote(noteId).body).includes(url))
      throw new Error('This address is not in the note.');
    await shell.openExternal(url);
  },
  addNoteImage: async (bytes) => needMine().addNoteImage(bytes),
  getNoteImage: async (id) => needMine().getNoteImage(id),
  getFileIcons: async (paths) => fileIcons(paths),
  saveNoteImage: async (id) => {
    const { mime, data } = needMine().getNoteImage(id);
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    const r = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('pictures'), `WorkSync image.${ext}`),
      filters: [{ name: `${ext.toUpperCase()} image`, extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, data);
    return true;
  },
  getAppInfo: async (): Promise<AppInfo> => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    packaged: app.isPackaged,
  }),
  start: async () => open(),
  listOwnerTranslations: async (projectId) =>
    need().listOwnerTranslations(projectId),
  prepareOwnerBatches: async (projectId, taskIds) => {
    const st = need();
    const project = st.getProject(projectId);
    const to = project.originalLanguages[0] ?? 'ja';
    const done = st.listOwnerTranslations(projectId);
    const items = taskIds
      .map((id) => st.getTask(id))
      .filter((t) => t.projectId === projectId)
      .map((task) => ({ task, parts: untranslated(task, done, to) }));
    return buildOwnerBatches(
      items,
      project.workingLanguage,
      to,
      st.listGlossary(projectId),
    );
  },
  readOwnerAnswer: async (batch, answer) => readOwnerAnswer(batch, answer),
  saveOwnerTranslations: async (list) => need().saveOwnerTranslations(list),
  prepareRemarksBatches: async (taskIds) => {
    const st = need();
    const { sources: s } = needLinks();
    const tasks = taskIds
      .map((id) => st.getTask(id))
      .filter((t) => t.remarks.trim());
    if (!tasks.length) return [];
    const project = st.getProject(tasks[0].projectId);
    // Remarks go into the file, so they are translated into the file's main language.
    const src = tasks[0].sourceFileId ? s.get(tasks[0].sourceFileId) : null;
    const to = src?.mainLanguage ?? project.originalLanguages[0] ?? 'ja';
    return buildOwnerBatches(
      tasks
        .filter((t) => t.projectId === project.id)
        .map((task) => ({
          task,
          parts: [{ field: 'remarks', label: 'REMARKS', source: task.remarks }],
        })),
      project.workingLanguage,
      to,
      st.listGlossary(project.id),
    );
  },
  applyRemarks: async (list) => {
    const st = need();
    let n = 0;
    for (const x of list) {
      if (x.field !== 'remarks') continue;
      const t = st.getTask(x.taskId);
      // Only if the remarks are still the text that was translated.
      if (t.remarks !== x.source || !x.text.trim()) continue;
      st.updateTask(t.id, { remarks: x.text.trim() });
      n++;
    }
    return n;
  },
  listPeople: async () => need().listPeople(),
  savePerson: async (input) => need().savePerson(input),
  deletePerson: async (id) => need().deletePerson(id),
  listAllGlossary: async () => need().listGlossary(),
  updateSettings: async (patch) => {
    if (patch.backupFolder) {
      const problem = writeTargetProblem(
        patch.backupFolder,
        needLinks().sources.list(),
        'another folder',
      );
      // Never inside Box or beside a linked customer file (spec 06).
      if (problem) throw new Error(problem);
    }
    if (
      patch.quickSearchKey !== undefined &&
      !setQuickSearchKey(patch.quickSearchKey)
    )
      throw new Error(
        'That shortcut is used by another app or by Windows. Choose another one.',
      );
    const saved = need().updateSettings(patch);
    applyAppSettings(saved);
    return saved;
  },
  storageInfo: async () => storageInfo(),
  chooseBackupFolder: async () => {
    if (process.env.WORKSYNC_TEST_BACKUP_FOLDER)
      return process.env.WORKSYNC_TEST_BACKUP_FOLDER;
    const win =
      BrowserWindow.getFocusedWindow() ??
      getMainWindow() ??
      BrowserWindow.getAllWindows()[0];
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose the backup folder',
      defaultPath: backupFolder(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  backupNow: async () => {
    if (!db) need();
    backupBefore(db!, backupFolder(), 'manual');
    log('info', `Backup made in ${backupFolder()}`);
    return storageInfo();
  },
  chooseBackupFile: async () => {
    const test = process.env.WORKSYNC_TEST_BACKUP_FILE;
    let file: string | null = test ?? null;
    if (!test) {
      const win =
        BrowserWindow.getFocusedWindow() ??
        getMainWindow() ??
        BrowserWindow.getAllWindows()[0];
      const r = await dialog.showOpenDialog(win, {
        title: 'Choose a WorkSync backup',
        defaultPath: backupFolder(),
        filters: [{ name: 'WorkSync backup', extensions: ['db'] }],
        properties: ['openFile'],
      });
      file = r.canceled ? null : (r.filePaths[0] ?? null);
    }
    if (file) chosenBackups.add(file);
    return file;
  },
  inspectBackup: async (file) =>
    inspectBackup(allowedBackup(file), SCHEMA_VERSION),
  restoreBackup: async (file) => {
    const from = allowedBackup(file);
    inspectBackup(from, SCHEMA_VERSION);
    if (!db) need();
    const safety = backupBefore(db!, backupFolder(), 'restore');
    log('info', `Restoring ${from}; the data before it is in ${safety}`);
    // Copy the backup aside first, so restoring from the backup folder works even after pruning.
    const staged = path.join(dataFolder, 'restore-pending.db');
    fs.copyFileSync(from, staged);
    closeStore();
    replaceDatabase(path.join(dataFolder, 'worksync.db'), staged);
    fs.rmSync(staged, { force: true });
    app.relaunch();
    app.exit(0);
  },
  openFolder: async (which) => {
    const folder =
      which === 'data'
        ? dataFolder
        : which === 'logs'
          ? (logFolder() ?? dataFolder)
          : backupFolder();
    fs.mkdirSync(folder, { recursive: true });
    const err = await shell.openPath(folder);
    if (err) throw new Error(err);
  },
  createProject: async (input) => need().createProject(input),
  updateProject: async (id, patch) => need().updateProject(id, patch),
  exportProject: async (projectId, includeNotes) => {
    const st = need();
    const p = st.getProject(projectId);
    let file = process.env.WORKSYNC_TEST_EXPORT_FILE ?? null;
    if (!file) {
      const win =
        BrowserWindow.getFocusedWindow() ??
        getMainWindow() ??
        BrowserWindow.getAllWindows()[0];
      const r = await dialog.showSaveDialog(win, {
        title: 'Save a copy of the project',
        defaultPath: path.join(
          app.getPath('documents'),
          `${p.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Project'}.worksync`,
        ),
        filters: [{ name: 'WorkSync project', extensions: ['worksync'] }],
      });
      file = r.canceled || !r.filePath ? null : r.filePath;
    }
    if (!file) return null;
    // Never into Box or beside a customer file, where the customer could see it.
    const problem = writeTargetProblem(
      path.dirname(file),
      needLinks().sources.list(),
      'another folder',
    );
    if (problem) throw new Error(problem);
    if (!file.toLowerCase().endsWith('.worksync')) file += '.worksync';
    fs.writeFileSync(
      file,
      exportProject(db!, projectId, { includeNotes }, new Date().toISOString()),
    );
    log('info', 'Exported a project copy');
    return { file };
  },
  chooseImport: async () => {
    const st = need();
    let file = process.env.WORKSYNC_TEST_IMPORT_FILE ?? null;
    if (!file) {
      const win =
        BrowserWindow.getFocusedWindow() ??
        getMainWindow() ??
        BrowserWindow.getAllWindows()[0];
      const r = await dialog.showOpenDialog(win, {
        title: 'Import a WorkSync project',
        filters: [{ name: 'WorkSync project', extensions: ['worksync'] }],
        properties: ['openFile'],
      });
      file = r.canceled ? null : (r.filePaths[0] ?? null);
    }
    if (!file) return null;
    const x = readExport(fs.readFileSync(file));
    chosenImports.add(file);
    const name = String(x.tables.projects[0].name ?? x.name);
    const tasks = st.listTasks();
    const sameName = st
      .listProjects()
      .filter((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())
      .map((p) => ({
        id: p.id,
        name: p.name,
        tasks: tasks.filter((t) => t.projectId === p.id).length,
      }));
    return {
      file,
      name,
      exportedAt: x.exportedAt,
      tasks: (x.tables.tasks ?? []).length,
      sameName,
      mergeTargets: mergeTargets(db!, x),
      fromName: x.from.name,
    };
  },
  previewMerge: async (file, projectId) => {
    const st = need();
    if (!chosenImports.has(file)) throw new Error('Choose the file again.');
    const x = readExport(fs.readFileSync(file));
    const m = startMerge(db!, x, projectId);
    const plan = planMerge(m);
    const token = randomUUID();
    merges.clear();
    merges.set(token, m);
    return {
      token,
      projectName: st.getProject(projectId).name,
      fromName: x.from.name,
      exportedAt: x.exportedAt,
      lastMergedAt: m.baseAt,
      auto: plan.auto,
      questions: plan.questions,
    };
  },
  applyMerge: async (token, choices) => {
    const st = need();
    const m = merges.get(token);
    if (!m) throw new Error('Choose the file again.');
    // A backup first: a merge can be undone by restoring it.
    backupBefore(db!, backupFolder(), 'manual', 'before a merge');
    const r = applyMerge(db!, m, choices, {
      snapshotRoot: path.join(dataFolder, 'snapshots'),
      now: new Date().toISOString(),
    });
    merges.delete(token);
    // Files that came with the other copy are checked on this PC.
    const { sources: s, links: l } = needLinks();
    for (const src of s.list().filter((x) => x.projectId === m.projectId))
      l.check(src);
    notifySources();
    log(
      'info',
      `Merged a project copy: ${r.added} tasks added, ${r.changed} changed, ${r.removed} removed`,
    );
    return {
      ...r,
      projectId: m.projectId,
      name: st.getProject(m.projectId).name,
    };
  },
  importProject: async (file, replaceProjectId) => {
    const st = need();
    if (!chosenImports.has(file)) throw new Error('Choose the file again.');
    const replacing = replaceProjectId ? st.getProject(replaceProjectId) : null;
    // A backup first, as for any change this large; replacing can be undone from it.
    backupBefore(db!, backupFolder(), replacing ? 'delete' : 'manual');
    // The new project comes in first, so a failed import never loses the old one.
    const r = importProject(
      db!,
      fs.readFileSync(file),
      path.join(dataFolder, 'snapshots'),
      new Date().toISOString(),
    );
    let name = r.name;
    if (replacing) {
      st.deleteProject(replacing.id);
      name = st.updateProject(r.projectId, { name: replacing.name }).name;
      log('info', 'Replaced a project with an imported copy');
    }
    // Linked files are checked on this PC; they may be somewhere else here.
    const { sources: s, links: l } = needLinks();
    for (const src of s.list().filter((x) => x.projectId === r.projectId))
      l.check(src);
    notifySources();
    const missingFiles = s
      .list()
      .filter(
        (x) => x.projectId === r.projectId && x.state === 'missing',
      ).length;
    log('info', `Imported a project with ${r.tasks} tasks`);
    return { ...r, name, missingFiles };
  },
  relinkSource: async (sourceId) => {
    const { sources: s, links: l } = needLinks();
    const src = s.get(sourceId);
    let file = process.env.WORKSYNC_TEST_PICK_FILE ?? null;
    if (!file) {
      const win =
        BrowserWindow.getFocusedWindow() ??
        getMainWindow() ??
        BrowserWindow.getAllWindows()[0];
      const r = await dialog.showOpenDialog(win, {
        title: `Find ${path.basename(src.currentFile)}`,
        properties: ['openFile'],
        filters: [
          { name: 'Excel and CSV', extensions: ['xlsx', 'xlsm', 'xls', 'csv'] },
        ],
      });
      file = r.canceled ? null : (r.filePaths[0] ?? null);
    }
    if (!file) return null;
    // It must still have the sheet the format reads.
    const sheets = l.inspect(file).sheets.map((x) => x.name);
    if (!sheets.includes(src.format.sheet))
      throw new Error(
        `${path.basename(file)} has no sheet “${src.format.sheet}”. Choose the same customer file.`,
      );
    const moved = s.relocate(sourceId, file);
    l.check(moved);
    notifySources();
    log('info', 'A linked file was found at a new place');
    return s.get(sourceId);
  },
  deleteProject: async (id) => {
    const st = need();
    st.getProject(id);
    // A backup first, so a project deleted by mistake can be restored from Settings.
    const safety = backupBefore(db!, backupFolder(), 'delete');
    const r = st.deleteProject(id);
    log(
      'info',
      `Deleted a project with ${r.tasks} tasks; the data before it is in ${safety}`,
    );
    notifySources();
    return r;
  },
  addSampleProject: async () => addSampleProject(need(), today()),
  listTasks: async () => need().listTasks(),
  createTask: async (projectId, input) => need().createTask(projectId, input),
  updateTask: async (id, patch) => need().updateTask(id, patch),
  setPriorityOverride: async (id, level) =>
    need().setPriorityOverride(id, level),
  setPinned: async (id, pinned) => need().setPinned(id, pinned),
  setTaskLinks: async (id, links) => need().setLinks(id, links),
  openLink: async (target) => {
    const t = target.trim();
    const kind = linkKind(t);
    // Only links saved on a task are opened, never text from elsewhere.
    if (
      !kind ||
      !need()
        .listTasks()
        .some((x) => x.links.some((l) => l.target === t))
    )
      throw new Error('This link is not saved on a task.');
    if (kind === 'web') return shell.openExternal(t);
    // A program is never started from a link; its folder is shown instead.
    if (
      /\.(exe|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|msi|scr|lnk|hta|jar|reg)$/i.test(
        t,
      )
    )
      return shell.showItemInFolder(t);
    if (!fs.existsSync(t))
      throw new Error(
        `${t} was not found. The shared folder may not be connected.`,
      );
    const err = await shell.openPath(t);
    if (err) throw new Error(err);
  },
  bulkUpdate: async (ids, change) => need().bulkUpdate(ids, change),
  setBoard: async (id, board) => need().setBoard(id, board),
  setBoardColumn: async (taskId, columnId) =>
    need().setBoardColumn(taskId, columnId),
  setTableSettings: async (id, settings) =>
    need().setTableSettings(id, settings),
  addSituationUpdate: async (id, input) => need().addSituationUpdate(id, input),
  correctSituation: async (id, input) => need().correctSituation(id, input),
  editDifficulty: async (taskId, difficultyId, input) =>
    need().editDifficulty(taskId, difficultyId, input),
  deleteDifficulty: async (taskId, difficultyId) =>
    need().deleteDifficulty(taskId, difficultyId),
  setDifficultyOpen: async (taskId, difficultyId, isOpen) =>
    need().setDifficultyOpen(taskId, difficultyId, isOpen),
  deleteTask: async (id) => need().deleteTask(id),
  listActivity: async (taskId) => need().listActivity(taskId),
  addNote: async (taskId, text) => need().addNote(taskId, text),

  chooseFile: async () => {
    // Automated tests cannot click through the system dialog; they name the file instead.
    const testPick = process.env.WORKSYNC_TEST_PICK_FILE;
    if (testPick) {
      chosenFiles.add(testPick);
      return testPick;
    }
    const win =
      BrowserWindow.getFocusedWindow() ??
      getMainWindow() ??
      BrowserWindow.getAllWindows()[0];
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose the customer’s Excel file',
      properties: ['openFile'],
      filters: [
        { name: 'Excel and CSV', extensions: ['xlsx', 'xlsm', 'xls', 'csv'] },
      ],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    chosenFiles.add(r.filePaths[0]);
    return r.filePaths[0];
  },
  inspectFile: async (file) => needLinks().links.inspect(allowed(file)),
  previewFormat: async (file, format) =>
    needLinks().links.preview(allowed(file), format),
  linkFile: async (input) => {
    const { sources: s, links: l } = needLinks();
    allowed(input.file);
    const id = randomUUID();
    const v = l.readVersion(
      {
        id,
        path: input.file,
        pattern: input.pattern,
        currentFile: input.file,
        format: input.format,
      },
      input.file,
    );
    const r = s.link(input, v, id);
    notifySources();
    return r;
  },
  listSources: async () => needLinks().sources.list(),
  checkSources: async () => {
    checkLinkedFiles();
    return needLinks().sources.list();
  },
  reviewSource: async (id, byTitle) => {
    const { sources: s, links: l } = needLinks();
    const src = s.get(id);
    return readOrMark(id, () => s.review(id, l.readVersion(src), byTitle));
  },
  applySource: async (id, selection) => {
    const { sources: s, links: l } = needLinks();
    const src = s.get(id);
    const r = readOrMark(id, () => s.apply(id, l.readVersion(src), selection));
    notifySources();
    return r;
  },
  sourceSheet: async (id) => {
    const { sources: s, links: l } = needLinks();
    const src = s.get(id);
    const sheet = readOrMark(id, () =>
      l
        .inspect(src.currentFile)
        .sheets.find((x) => x.name === src.format.sheet),
    );
    if (!sheet)
      throw new Error(
        `The sheet “${src.format.sheet}” is no longer in the file.`,
      );
    return sheet;
  },
  updateSourceFormat: async (id, format) =>
    needLinks().sources.updateFormat(id, format),
  unlinkSource: async (id) => {
    needLinks().sources.remove(id);
    notifySources();
  },
  listGlossary: async (projectId) => need().listGlossary(projectId),
  saveGlossaryTerm: async (input) => need().saveGlossaryTerm(input),
  deleteGlossaryTerm: async (id) => need().deleteGlossaryTerm(id),
  // All AI work goes through these calls (spec 06). The only provider is the
  // clipboard: the owner pastes the request into the Gemini web app.
  prepareAiBatches: async (projectId, taskIds) => {
    const st = need();
    const project = st.getProject(projectId);
    const tasks = taskIds
      .map((id) => st.getTask(id))
      .filter((t) => t.projectId === projectId);
    return buildBatches(
      tasks.map((t) => ({
        taskId: t.id,
        customerId: t.customerId,
        language: t.language,
        title: t.titleOriginal,
        description: t.descriptionOriginal,
        summary: t.summary,
      })),
      project.workingLanguage,
      st.listGlossary(projectId),
    );
  },
  readAiAnswer: async (batch, answer) => readAnswer(batch, answer),
  applyAiResults: async (results) => need().applyAiResults(results),
  copyText: async (text) => clipboard.writeText(text),
  lastImport: async (projectId) => need().lastImport(projectId),

  choosePublishFolder: async (projectId) => {
    const win =
      BrowserWindow.getFocusedWindow() ??
      getMainWindow() ??
      BrowserWindow.getAllWindows()[0];
    const current = need().getProject(projectId).publishFolder;
    // Automated tests cannot click through the system dialog; they name the folder instead.
    let folder = process.env.WORKSYNC_TEST_PICK_FOLDER ?? null;
    if (!folder) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Choose the publish folder on the shared drive',
        defaultPath: current ?? undefined,
        properties: ['openDirectory', 'createDirectory'],
      });
      folder = r.canceled ? null : (r.filePaths[0] ?? null);
    }
    if (!folder) return null;
    const problem = needPublisher().folderProblem(folder);
    if (problem) throw new Error(problem);
    return need().setPublishOptions(projectId, { folder });
  },
  setPublishNotes: async (projectId, include) =>
    need().setPublishOptions(projectId, { notes: include }),
  setPublishOnClose: async (projectId, on) =>
    need().setPublishOptions(projectId, { onClose: on }),
  publishStatus: async (projectId) => needPublisher().status(projectId),
  previewPublish: async (projectId) => {
    const file = needPublisher().preview(projectId);
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      title: 'Preview of the published page',
      backgroundColor: '#10141b',
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // Links in the page open in the browser, never inside the app.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    await win.loadFile(file);
  },
  publish: async (projectId) => needPublisher().publish(projectId),
  writePlans: async () => {
    const plans = needWriter().plans();
    notifySources();
    return plans;
  },
  pendingCount: async () => needWriter().pendingCount(),
  pendingForTask: async (taskId) => {
    const t = need().getTask(taskId);
    if (!t.sourceFileId) return [];
    return needWriter()
      .pending(needLinks().sources.get(t.sourceFileId))
      .filter((c) => c.taskId === taskId);
  },
  chooseCopyFolder: async (current) => {
    // Automated tests cannot click through the system dialog; they name the folder instead.
    if (process.env.WORKSYNC_TEST_COPY_FOLDER)
      return process.env.WORKSYNC_TEST_COPY_FOLDER;
    const win =
      BrowserWindow.getFocusedWindow() ??
      getMainWindow() ??
      BrowserWindow.getAllWindows()[0];
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose where to save your copies',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  writeCopy: async (sourceId, chosen, folder) => {
    const r = needWriter().write(sourceId, chosen, folder);
    writtenCopies.add(r.file);
    return r;
  },
  makeReport: async (options) => {
    const st = need();
    const project = st.getProject(options.projectId);
    const people = st.listPeople(project.id);
    options = {
      ...options,
      dateFormat: project.dateFormat,
      translations: translationMap(
        st.listTasks().filter((t) => t.projectId === project.id),
        st.listOwnerTranslations(project.id),
        project.originalLanguages[0] ?? 'ja',
      ),
    };
    // Assignees in the report's language, from the people list.
    const tasks = reportTasks(st.listTasks(), options).map((t) => ({
      ...t,
      assignee: assigneeText(people, t, options.language),
    }));
    const data = await buildReport(project, tasks, options, today());
    const name = reportFileName(project, options, today());
    const folder = path.join(app.getPath('documents'), 'WorkSync', 'Reports');
    let file: string | null;
    // Automated tests cannot click through the system dialog; they name the folder instead.
    if (process.env.WORKSYNC_TEST_REPORT_FOLDER)
      file = path.join(process.env.WORKSYNC_TEST_REPORT_FOLDER, name);
    else {
      fs.mkdirSync(folder, { recursive: true });
      const win =
        BrowserWindow.getFocusedWindow() ??
        getMainWindow() ??
        BrowserWindow.getAllWindows()[0];
      const r = await dialog.showSaveDialog(win, {
        title: 'Save the report',
        defaultPath: path.join(folder, name),
        filters: [
          options.format === 'xlsx'
            ? { name: 'Excel workbook', extensions: ['xlsx'] }
            : { name: 'Word document', extensions: ['docx'] },
        ],
      });
      file = r.canceled ? null : (r.filePath ?? null);
    }
    if (!file) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    writtenCopies.add(file);
    return { file, tasks: tasks.length };
  },
  openCopy: async (file, inFolder) => {
    if (!writtenCopies.has(file))
      throw new Error(
        'Only files WorkSync saved in this session can be opened from here.',
      );
    if (inFolder) shell.showItemInFolder(file);
    else {
      const err = await shell.openPath(file);
      if (err) throw new Error(err);
    }
  },
  openPublished: async (projectId) => {
    const folder = need().getProject(projectId).publishFolder;
    if (!folder) throw new Error('This project has not been published yet.');
    const err = await shell.openPath(path.join(folder, PAGE_FILE));
    if (err) throw new Error(err);
  },
  openSourceFile: async (id) => {
    const src = needLinks().sources.get(id);
    const err = await shell.openPath(src.currentFile);
    if (err) throw new Error(err);
  },
};

/** Registers every IPC handler. Call once, before any window is created. */
function storageInfo(): StorageInfo {
  const folder = backupFolder();
  return {
    dataFolder,
    backupFolder: folder,
    defaultBackupFolder: folder === defaultBackups(),
    backupWarning: sharedFolderWarning(folder),
    logFolder: logFolder() ?? path.join(dataFolder, 'logs'),
    backups: listBackups(folder),
  };
}

/** A backup may be restored only from the backup folder or a file the owner picked. */
function allowedBackup(file: string): string {
  const inFolder =
    path.dirname(path.resolve(file)) === path.resolve(backupFolder());
  if (!inFolder && !chosenBackups.has(file))
    throw new Error('Choose the backup again.');
  return file;
}

/** Called every hour: writes the day's backup once the date changes. */
export function backupTick(): void {
  if (!db) return;
  try {
    if (backupDaily(db, backupFolder(), today()))
      log('info', `Daily backup made in ${backupFolder()}`);
  } catch (error) {
    log('warn', `Daily backup failed: ${String(error)}`);
  }
}

const shownNotes = new Set<Notification>();

/** Paths Everything found in this session; only these open from a search. */
const found = new Set<string>();
const exists = (p: string) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
const kindOf = (p: string, fallback: EntryKind): EntryKind => {
  try {
    return fs.statSync(p).isDirectory() ? 'folder' : 'file';
  } catch {
    return fallback;
  }
};

/**
 * Opens a Catalog path. An app starts in its own folder, as FileManagement
 * does; anything else opens with its usual program.
 */
async function openPath(p: string, kind: EntryKind): Promise<void> {
  if (!exists(p))
    throw new Error(`${p} was not found. It may have been moved or deleted.`);
  if (kind === 'file' && process.platform === 'win32' && /\.exe$/i.test(p)) {
    spawn(p, [], {
      cwd: path.dirname(p),
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
}

/** Asks the window to show a page, bringing it to the front. */
export function openInWindow(target: OpenTarget): void {
  showMainWindow();
  getMainWindow()?.webContents.send(OPEN_EVENT, target);
}

/**
 * Shows the reminders of My tasks that are due now, each slot once (the rules
 * are in shared/myTasks). Runs every few minutes while WorkSync runs.
 */
export function remindMyTasks(now = new Date()): number {
  if (!mine || !store || !store.getSettings().reminders) return 0;
  if (!Notification.isSupported()) return 0;
  let shown = 0;
  for (const t of mine.listMyTasks()) {
    const key = reminderKey(t, now);
    if (!key || key === t.lastReminderKey) continue;
    const lang = resolveUiLanguage(
      store.getSettings().uiLanguage,
      app.getLocale(),
    );
    const text = reminderText(t, toIsoDate(now), (s, v) =>
      translate(lang, s, v),
    );
    const n = new Notification({ title: text.title, body: text.body });
    // Kept until it is closed, so its click still reaches the window.
    shownNotes.add(n);
    n.on('click', () => {
      shownNotes.delete(n);
      openInWindow({ page: 'myTasks', id: t.id });
    });
    n.on('close', () => shownNotes.delete(n));
    n.show();
    mine.setReminderKey(t.id, key);
    shown++;
  }
  if (shown) log('info', `Showed ${shown} reminder${shown === 1 ? '' : 's'}`);
  return shown;
}

/** The app-wide settings, opening the data on first use; defaults if it can't open. */
export function appSettings(): AppSettings {
  open();
  return store?.getSettings() ?? DEFAULT_SETTINGS;
}

export function registerIpcHandlers(): void {
  for (const method of API_METHODS) {
    const fn = handlers[method] as (...args: unknown[]) => Promise<unknown>;
    ipcMain.handle(channel(method), async (_event, ...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (error) {
        // A plain Error is the app refusing something, such as a duplicate name; anything else is a fault.
        const refused = error instanceof Error && error.constructor === Error;
        log(
          refused ? 'info' : 'error',
          `${refused ? 'Refused ' : ''}${method}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // The log keeps English; the window gets the message in the app language.
        if (error instanceof Error) {
          const lang = resolveUiLanguage(
            store?.getSettings().uiLanguage ?? 'system',
            app.getLocale(),
          );
          const text = translateMessage(lang, error.message);
          if (text !== error.message) throw new Error(text);
        }
        throw error;
      }
    });
  }
}

/**
 * Publishes the projects that publish when the app closes and have changes
 * not published yet. A project that cannot publish now, for example because
 * the shared drive is not connected, is logged and skipped.
 */
export function publishOnClose(): number {
  if (!store || !publisher) return 0;
  let n = 0;
  for (const p of store.listProjects()) {
    if (!p.publishOnClose || !p.publishFolder) continue;
    try {
      if (!publisher.status(p.id).unpublished) continue;
      publisher.publish(p.id);
      n++;
      log('info', 'Published a project as WorkSync closed');
    } catch (error) {
      log('warn', `Publish on close failed: ${String(error)}`);
    }
  }
  return n;
}

/** Closes the database cleanly when the app quits. */
export function closeStore(): void {
  db?.close();
  db = null;
  store = null;
}
