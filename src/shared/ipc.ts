/**
 * Contract between the main process and the renderer.
 *
 * This file is imported by the main process, the preload script and the
 * renderer, so it must stay free of Node.js and Electron imports.
 * Add a method to `WorkSyncApi` first, then implement it in `src/main/ipc.ts`;
 * the preload script exposes every method listed in `API_METHODS`.
 */
import type {
  ActivityEntry,
  BulkChange,
  DateFormat,
  Level,
  Project,
  ProjectInput,
  SituationInput,
  Task,
  TableSettings,
  TaskInput,
  TaskLink,
  ViewKey,
} from './model';
import type { FileFormat } from './importRules';
import type { AppSettings, StorageInfo } from './settings';
import type { BoardSettings } from './board';
import type { OwnerAnswer, OwnerBatch, OwnerTranslation } from './ownerBatch';
import type { Batch, ReadAnswer } from './aiBatch';
import type { PendingChange, WritePlan, WriteResult } from './writes';
import type { ReportOptions } from './reports';
import type { MyTask, MyTaskInput } from './myTasks';
import type { Note, NoteInput } from './notes';
import type { AutoItem, MergeChoices, Question } from './merge';
import type { Release, ReleaseInput, ReleaseLists } from './releases';

/** What a merge would do, for the merge window. */
export interface MergePreview {
  token: string;
  projectName: string;
  /** Whose copy it is ('' when the file does not say). */
  fromName: string;
  exportedAt: string;
  /** When the two copies last exchanged a file; null before the first merge. */
  lastMergedAt: string | null;
  auto: AutoItem[];
  questions: Question[];
}
import type {
  CatalogEntry,
  CatalogEntryInput,
  EntryKind,
  EverythingAnswer,
  EverythingState,
} from './catalog';
import type {
  AiResult,
  GlossaryTerm,
  Person,
  ImportSummary,
  PublishStatus,
} from './model';
import type {
  SheetPreview,
  ApplySelection,
  FileInspection,
  FormatPreview,
  LinkInput,
  Review,
  SourceFile,
} from './sources';

export interface AppInfo {
  name: string;
  version: string;
  /** Value of `process.platform`, e.g. `win32`, `darwin` or `linux`. */
  platform: string;
  arch: string;
  electronVersion: string;
  /** True for a built app, false when running with `npm start`. */
  packaged: boolean;
}

/** What the window needs to start. */
export type Startup =
  | {
      ok: true;
      dataFolder: string;
      /** Today in the owner's local time, `YYYY-MM-DD`. */
      today: string;
      projects: Project[];
      tasks: Task[];
      sources: SourceFile[];
      settings: AppSettings;
      people: Person[];
      glossary: GlossaryTerm[];
      /** A warning about where the data folder is, such as in a synced folder. */
      warning: string | null;
    }
  | { ok: false; dataFolder: string; message: string };

export type ProjectPatch = Partial<ProjectInput> & {
  views?: Partial<Record<ViewKey, boolean>>;
  dueSoonDays?: number;
  dateFormat?: DateFormat;
  showNumbers?: boolean;
};

/** The API the preload script exposes to the renderer as `window.worksync`. */
export interface WorkSyncApi {
  getAppInfo(): Promise<AppInfo>;
  start(): Promise<Startup>;

  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  storageInfo(): Promise<StorageInfo>;
  /** Asks for a backup folder; null when cancelled. */
  chooseBackupFolder(): Promise<string | null>;
  backupNow(): Promise<StorageInfo>;
  /** Asks for a backup file kept elsewhere, such as on a USB drive. */
  chooseBackupFile(): Promise<string | null>;
  inspectBackup(file: string): Promise<{ projects: number; tasks: number }>;
  /** Backs up the current data, puts the backup in its place and restarts. */
  restoreBackup(file: string): Promise<void>;
  openFolder(which: 'data' | 'backups' | 'logs'): Promise<void>;

  createProject(input: ProjectInput): Promise<Project>;
  updateProject(id: string, patch: ProjectPatch): Promise<Project>;
  /** Saves a copy of the project as a .worksync file for another WorkSync user; null when cancelled. */
  exportProject(
    projectId: string,
    includeNotes: boolean,
  ): Promise<{ file: string } | null>;
  /**
   * Asks for a .worksync file and says what it holds, and which projects here
   * have the same name; null when cancelled.
   */
  chooseImport(): Promise<{
    file: string;
    name: string;
    exportedAt: string;
    tasks: number;
    sameName: { id: string; name: string; tasks: number }[];
    /** Projects here this file is a copy of: it can be merged into them. */
    mergeTargets: { id: string; name: string }[];
    /** Whose copy it is ('' in files from older versions). */
    fromName: string;
  } | null>;
  /** What merging the chosen file into a project would do. */
  previewMerge(file: string, projectId: string): Promise<MergePreview>;
  /** Merges, with the owner's answers; a backup is taken first. */
  applyMerge(
    token: string,
    choices: MergeChoices,
  ): Promise<{
    projectId: string;
    name: string;
    added: number;
    changed: number;
    removed: number;
  }>;
  /**
   * Adds the project from the chosen file: as a copy, or in place of a project
   * with the same name (that one is deleted, after a backup).
   */
  importProject(
    file: string,
    replaceProjectId: string | null,
  ): Promise<{
    projectId: string;
    name: string;
    tasks: number;
    sources: number;
    missingFiles: number;
  } | null>;
  /** Points a linked file at its new place, chosen by the owner. */
  relinkSource(sourceId: string): Promise<SourceFile | null>;
  /** Backs up the data, then deletes the project and everything WorkSync keeps for it. */
  deleteProject(id: string): Promise<{ tasks: number }>;
  /** Adds the sample project and returns its id. */
  addSampleProject(): Promise<string>;
  listTasks(): Promise<Task[]>;

  createTask(projectId: string, input: TaskInput): Promise<Task>;
  updateTask(id: string, patch: Partial<TaskInput>): Promise<Task>;
  setPriorityOverride(id: string, level: Level | null): Promise<Task>;
  setPinned(id: string, pinned: boolean): Promise<Task>;
  setTaskLinks(id: string, links: TaskLink[]): Promise<Task>;
  /** Opens a task's link: a web address in the browser, a path in its program, a program file in its folder. */
  openLink(target: string): Promise<void>;
  /** One change to several tasks, from the Tasks table. */
  bulkUpdate(ids: string[], change: BulkChange): Promise<Task[]>;
  setBoard(projectId: string, board: BoardSettings): Promise<Project>;
  setBoardColumn(taskId: string, columnId: string | null): Promise<Task>;
  setTableSettings(
    projectId: string,
    settings: TableSettings | null,
  ): Promise<Project>;
  addSituationUpdate(id: string, input: SituationInput): Promise<Task>;
  correctSituation(
    id: string,
    input: Omit<SituationInput, 'newDifficulty'>,
  ): Promise<Task>;
  editDifficulty(
    taskId: string,
    difficultyId: string,
    input: { text: string; resolver: string },
  ): Promise<Task>;
  deleteDifficulty(taskId: string, difficultyId: string): Promise<Task>;
  setDifficultyOpen(
    taskId: string,
    difficultyId: string,
    open: boolean,
  ): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  listActivity(taskId: string): Promise<ActivityEntry[]>;
  addNote(taskId: string, text: string): Promise<void>;

  /** Opens the system file dialog. Returns the chosen file, or null. */
  chooseFile(): Promise<string | null>;
  inspectFile(file: string): Promise<FileInspection>;
  previewFormat(file: string, format: FileFormat): Promise<FormatPreview>;
  linkFile(
    input: LinkInput,
  ): Promise<{ source: SourceFile; added: number; skipped: number }>;
  listSources(): Promise<SourceFile[]>;
  /** Checks every linked file now. */
  checkSources(): Promise<SourceFile[]>;
  reviewSource(id: string, byTitle: boolean): Promise<Review>;
  applySource(
    id: string,
    selection: ApplySelection,
  ): Promise<{ added: number; changed: number; removed: number }>;
  /** The first rows of a linked file's sheet, for changing which column holds what. */
  sourceSheet(sourceId: string): Promise<SheetPreview>;
  updateSourceFormat(id: string, format: FileFormat): Promise<SourceFile>;
  unlinkSource(id: string): Promise<void>;
  /** Opens the linked file in Excel, or whatever opens it on this PC. */
  openSourceFile(id: string): Promise<void>;

  listGlossary(projectId: string): Promise<GlossaryTerm[]>;
  saveGlossaryTerm(
    input: Omit<GlossaryTerm, 'id'> & { id?: string },
  ): Promise<GlossaryTerm>;
  deleteGlossaryTerm(id: string): Promise<void>;
  listOwnerTranslations(projectId: string): Promise<OwnerTranslation[]>;
  /** Requests to translate the owner's text of these tasks into the project's file language. */
  prepareOwnerBatches(
    projectId: string,
    taskIds: string[],
  ): Promise<OwnerBatch[]>;
  readOwnerAnswer(batch: OwnerBatch, answer: string): Promise<OwnerAnswer>;
  saveOwnerTranslations(list: OwnerTranslation[]): Promise<number>;
  /** Requests to translate these tasks' remarks into their file's language, before writing a copy. */
  prepareRemarksBatches(taskIds: string[]): Promise<OwnerBatch[]>;
  /** Puts the translated remarks in place of the ones that were translated. */
  applyRemarks(list: OwnerTranslation[]): Promise<number>;
  listPeople(): Promise<Person[]>;
  savePerson(input: Omit<Person, 'id'> & { id?: string }): Promise<Person>;
  deletePerson(id: string): Promise<void>;
  /** Every glossary term, for marking terms in task text. */
  listAllGlossary(): Promise<GlossaryTerm[]>;

  /** Builds the Gemini requests for the chosen tasks, split into batches. */
  prepareAiBatches(projectId: string, taskIds: string[]): Promise<Batch[]>;
  /** Reads a pasted answer and checks it against its batch. */
  readAiAnswer(batch: Pick<Batch, 'keys'>, answer: string): Promise<ReadAnswer>;
  /** Fills in what the owner accepted. */
  applyAiResults(results: AiResult[]): Promise<Task[]>;
  copyText(text: string): Promise<void>;
  lastImport(projectId: string): Promise<ImportSummary | null>;

  /** Opens the folder dialog and saves the project's publish folder. Returns null when cancelled. */
  choosePublishFolder(projectId: string): Promise<Project | null>;
  setPublishNotes(projectId: string, include: boolean): Promise<Project>;
  setPublishOnClose(projectId: string, on: boolean): Promise<Project>;
  publishStatus(projectId: string): Promise<PublishStatus>;
  /** Opens the page as it would be published, in its own window. */
  previewPublish(projectId: string): Promise<void>;
  publish(projectId: string): Promise<PublishStatus>;
  /** Opens the published page in the default browser. */
  openPublished(projectId: string): Promise<void>;

  /** The changes waiting to be written, per linked file. */
  writePlans(): Promise<WritePlan[]>;
  pendingCount(): Promise<number>;
  pendingForTask(taskId: string): Promise<PendingChange[]>;
  /** Opens the folder dialog for where copies are saved. Returns null when cancelled. */
  chooseCopyFolder(current: string): Promise<string | null>;
  /** Writes the chosen changes (`taskId:field`) into a new copy in the folder, and checks it. */
  writeCopy(
    sourceId: string,
    chosen: string[],
    folder: string,
  ): Promise<WriteResult>;
  /** Opens a copy WorkSync wrote, or shows it in its folder. */
  openCopy(file: string, inFolder: boolean): Promise<void>;

  /** Makes a report and asks where to save it. Returns the saved file, or null when cancelled. */
  makeReport(
    options: ReportOptions,
  ): Promise<{ file: string; tasks: number } | null>;

  /** My tasks: the owner's own to-dos. */
  listMyTasks(): Promise<MyTask[]>;
  /** Adds a task, or changes the one with this id. */
  saveMyTask(input: Partial<MyTaskInput>, id?: string): Promise<MyTask>;
  /** Completing deletes the task; it comes back for Undo. */
  completeMyTask(id: string): Promise<MyTask>;
  /** Puts back a task completed a moment ago. */
  restoreMyTask(task: MyTask): Promise<MyTask>;

  /** Notes: on their own or attached to a project. */
  listNotes(): Promise<Note[]>;
  /** Adds a note, or changes the one with this id; only the parts given change. */
  saveNote(input: Partial<NoteInput>, id?: string): Promise<Note>;
  /** Records that a note was opened, for Recent. */
  viewNote(id: string): Promise<Note>;
  deleteNote(id: string): Promise<Note>;
  /** Puts back a note deleted a moment ago. */
  restoreNote(note: Note): Promise<Note>;
  /** Opens a web address written in a note, in the browser. */
  openNoteLink(noteId: string, url: string): Promise<void>;
  /** Keeps an image pasted into a note (PNG, JPEG, GIF, WebP or BMP); returns its id. */
  addNoteImage(bytes: Uint8Array): Promise<string>;
  /** An image in a note. */
  getNoteImage(id: string): Promise<{ mime: string; data: Uint8Array }>;
  /** Asks where to save an image from a note, and saves it. False when cancelled. */
  saveNoteImage(id: string): Promise<boolean>;

  /** The system's icon for each path (an app's own icon, a document's app), as an image address; null where there is none. */
  getFileIcons(paths: string[]): Promise<Record<string, string | null>>;
  /** Software releases of a project, with their modules. */
  listReleases(projectId: string): Promise<Release[]>;
  /** Adds a release, or changes the one with this id. */
  saveRelease(
    projectId: string,
    input: ReleaseInput,
    id?: string,
  ): Promise<Release>;
  deleteRelease(id: string): Promise<Release>;
  /** The products, editions, destinations, categories and environments to pick from. */
  getReleaseLists(projectId: string): Promise<ReleaseLists>;
  saveReleaseLists(
    projectId: string,
    lists: ReleaseLists,
  ): Promise<ReleaseLists>;
  /** Saves the releases as an Excel workbook, after asking where; null when cancelled. */
  exportReleases(
    projectId: string,
    language: 'ja' | 'en',
  ): Promise<{ file: string } | null>;
  /** The Catalog, each entry checked for whether its path is still there. */
  listCatalog(): Promise<CatalogEntry[]>;
  /** Asks for files or folders and adds them; paths already there are skipped. Null when cancelled. */
  addToCatalog(
    kind: EntryKind,
  ): Promise<{ added: CatalogEntry[]; skipped: number } | null>;
  /** Adds a file or folder found by Everything. */
  addFoundToCatalog(path: string): Promise<CatalogEntry>;
  saveCatalogEntry(
    input: Partial<CatalogEntryInput>,
    id: string,
  ): Promise<CatalogEntry>;
  /** Removes it from the Catalog; the file or folder stays. */
  removeCatalogEntry(id: string): Promise<CatalogEntry>;
  restoreCatalogEntry(entry: CatalogEntry): Promise<CatalogEntry>;
  /** Opens it: starts an app in its own folder, opens a file or folder. */
  openCatalogEntry(id: string): Promise<CatalogEntry>;
  /** Shows it in Explorer (Finder on a Mac). */
  revealCatalogEntry(id: string): Promise<void>;
  /** Searches files on this PC with Everything (Windows). */
  searchEverything(query: string, limit?: number): Promise<EverythingAnswer>;
  everythingStatus(): Promise<EverythingState>;
  /** Opens, or shows in Explorer, a path Everything found in this session. */
  openFound(path: string, reveal: boolean): Promise<void>;
  /** Closes the quick-search box. */
  hideQuickSearch(): Promise<void>;

  /** Called whenever linked files change state. Returns a function that stops listening. */
  onSourcesChanged(listener: (sources: SourceFile[]) => void): () => void;
  /** Called when something outside the window asks to show a page, such as a reminder being clicked. */
  onOpen(listener: (target: OpenTarget) => void): () => void;
}

/** What a reminder, the tray or the shortcut asks the window to show. */
export type OpenTarget =
  | { page: 'myTasks'; id?: string }
  | { page: 'catalog' }
  | { page: 'quickShown' };

/** Sent by the main process when linked files change state. */
export const SOURCES_EVENT = 'worksync:sources-changed';
/** Sent by the main process to show a page in the window. */
export const OPEN_EVENT = 'worksync:open';

/** Every method of the API. Each is sent on the channel `worksync:<name>`. */
export const API_METHODS = [
  'getAppInfo',
  'listMyTasks',
  'saveMyTask',
  'completeMyTask',
  'restoreMyTask',
  'listNotes',
  'saveNote',
  'viewNote',
  'deleteNote',
  'restoreNote',
  'openNoteLink',
  'addNoteImage',
  'getNoteImage',
  'saveNoteImage',
  'getFileIcons',
  'listReleases',
  'saveRelease',
  'deleteRelease',
  'getReleaseLists',
  'saveReleaseLists',
  'exportReleases',
  'listCatalog',
  'addToCatalog',
  'addFoundToCatalog',
  'saveCatalogEntry',
  'removeCatalogEntry',
  'restoreCatalogEntry',
  'openCatalogEntry',
  'revealCatalogEntry',
  'searchEverything',
  'everythingStatus',
  'openFound',
  'hideQuickSearch',
  'start',
  'updateSettings',
  'storageInfo',
  'chooseBackupFolder',
  'backupNow',
  'chooseBackupFile',
  'inspectBackup',
  'restoreBackup',
  'openFolder',
  'createProject',
  'updateProject',
  'deleteProject',
  'exportProject',
  'chooseImport',
  'importProject',
  'previewMerge',
  'applyMerge',
  'relinkSource',
  'addSampleProject',
  'listTasks',
  'createTask',
  'updateTask',
  'setPriorityOverride',
  'setPinned',
  'setTaskLinks',
  'openLink',
  'bulkUpdate',
  'setTableSettings',
  'setBoard',
  'setBoardColumn',
  'addSituationUpdate',
  'setDifficultyOpen',
  'correctSituation',
  'editDifficulty',
  'deleteDifficulty',
  'deleteTask',
  'listActivity',
  'addNote',
  'chooseFile',
  'inspectFile',
  'previewFormat',
  'linkFile',
  'listSources',
  'checkSources',
  'reviewSource',
  'applySource',
  'sourceSheet',
  'updateSourceFormat',
  'unlinkSource',
  'openSourceFile',
  'listGlossary',
  'saveGlossaryTerm',
  'deleteGlossaryTerm',
  'listOwnerTranslations',
  'prepareOwnerBatches',
  'readOwnerAnswer',
  'saveOwnerTranslations',
  'prepareRemarksBatches',
  'applyRemarks',
  'listPeople',
  'savePerson',
  'deletePerson',
  'listAllGlossary',
  'prepareAiBatches',
  'readAiAnswer',
  'applyAiResults',
  'copyText',
  'lastImport',
  'choosePublishFolder',
  'setPublishNotes',
  'setPublishOnClose',
  'publishStatus',
  'previewPublish',
  'publish',
  'openPublished',
  'writePlans',
  'pendingCount',
  'pendingForTask',
  'chooseCopyFolder',
  'writeCopy',
  'openCopy',
  'makeReport',
] as const satisfies readonly Exclude<
  keyof WorkSyncApi,
  'onSourcesChanged' | 'onOpen'
>[];

export const channel = (method: (typeof API_METHODS)[number]): string =>
  `worksync:${method}`;
