import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  LEVEL_NAME,
  fileDate,
  shownPriority,
  toIsoDate,
  type PublishStatus,
  assigneeText,
} from '../shared/model';
import { buildIndexPage, buildPage, type SituationEntry } from './publishPage';
import { writeTargetProblem } from './fileLinks';
import type { Sources } from './sources';
import type { Store } from './store';
import { sha256 } from './workbook';

export const PAGE_FILE = 'index.html';
export const EXPORT_FILE = 'tasks.xlsx';
export const FINGERPRINT_FILE = 'worksync-publish.json';

/** Writes a file next to its target first, then moves it into place, so readers never see half a file. */
function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Publishing (spec 05): the page, the Excel export and a fingerprint file in
 * the project's folder on the shared drive. The owner's data never depends on
 * these files; the next publish replaces them.
 */
export class Publisher {
  constructor(
    private readonly store: Store,
    private readonly sources: Sources,
    private readonly previewDir: string,
  ) {}

  /** A reason a folder must not be used for publishing, or null. */
  folderProblem(folder: string): string | null {
    return writeTargetProblem(
      folder,
      this.sources.list(),
      'a folder on the company shared drive',
    );
  }

  status(projectId: string): PublishStatus {
    const p = this.store.getProject(projectId);
    const last = this.store.lastPublish(projectId);
    const tampered: string[] = [];
    if (last) {
      for (const [name, fp] of Object.entries(last.files)) {
        try {
          if (sha256(fs.readFileSync(path.join(last.folder, name))) !== fp)
            tampered.push(name);
        } catch {
          tampered.push(name);
        }
      }
    }
    return {
      folder: p.publishFolder,
      lastAt: last?.at ?? null,
      unpublished: this.store.changedSince(projectId, last?.at ?? null),
      tampered,
      folderProblem: p.publishFolder
        ? this.folderProblem(p.publishFolder)
        : null,
    };
  }

  private build(
    projectId: string,
    publishedAt: string,
  ): { page: string; workbook: Buffer } {
    const project = this.store.getProject(projectId);
    const tasks = this.store
      .listTasks()
      .filter((t) => t.projectId === projectId && t.fileState !== 'removed');
    const updates: Record<string, SituationEntry[]> = {};
    for (const t of tasks)
      updates[t.id] = this.store.listSituationUpdates(t.id, 3);
    const today = toIsoDate(new Date(publishedAt));
    const page = buildPage({
      project,
      tasks,
      updates,
      publishedAt,
      today,
      includeNotes: project.publishNotes,
    });

    const people = this.store.listPeople(project.id);
    // The Excel export: the task list, for people who prefer Excel.
    const head = [
      'No.',
      'Title',
      'Original title',
      'Status',
      'Priority',
      'Assignee',
      'Handled by',
      'Doing now',
      'Next step',
      'Next step date',
      'Planned start',
      'Planned end',
      'Actual start',
      'Actual end',
      'Summary',
      'Labels',
      'Open difficulties',
    ];
    const rows = tasks.map((t) => [
      t.customerId,
      t.titleTranslation || t.titleOriginal,
      t.titleTranslation ? t.titleOriginal : '',
      t.status,
      LEVEL_NAME[shownPriority(t)],
      assigneeText(people, t, 'both'),
      t.situation.handledBy,
      t.situation.doingNow,
      t.situation.nextStep,
      fileDate(t.situation.nextDate),
      fileDate(t.plannedStart),
      fileDate(t.plannedEnd),
      fileDate(t.actualStart),
      fileDate(t.actualEnd),
      t.summary,
      t.labels.join(', '),
      t.difficulties
        .filter((d) => d.open)
        .map((d) => d.text)
        .join('; '),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    ws['!cols'] = [
      8, 40, 40, 12, 9, 14, 18, 36, 11, 30, 12, 12, 12, 12, 12, 48, 20, 36,
    ].map((wch) => ({ wch }));
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: rows.length, c: head.length - 1 },
      }),
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tasks');
    wb.Props = { Title: `${project.name} tasks`, Author: 'WorkSync' };
    const workbook = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    return { page, workbook };
  }

  /** Writes the page to a preview folder in the app's data, never to the shared drive. */
  preview(projectId: string): string {
    const { page } = this.build(projectId, new Date().toISOString());
    const dir = path.join(this.previewDir, projectId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, PAGE_FILE);
    writeAtomic(file, page);
    return file;
  }

  publish(projectId: string): PublishStatus {
    const p = this.store.getProject(projectId);
    if (!p.publishFolder) throw new Error('Choose the publish folder first.');
    const problem = this.folderProblem(p.publishFolder);
    if (problem) throw new Error(problem);
    const folder = p.publishFolder;
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (e) {
      throw new Error(
        `The publish folder cannot be reached: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const publishedAt = new Date().toISOString();
    const { page, workbook } = this.build(projectId, publishedAt);
    const files: Record<string, string> = {
      [PAGE_FILE]: sha256(Buffer.from(page)),
      [EXPORT_FILE]: sha256(workbook),
    };
    writeAtomic(path.join(folder, PAGE_FILE), page);
    writeAtomic(path.join(folder, EXPORT_FILE), workbook);
    writeAtomic(
      path.join(folder, FINGERPRINT_FILE),
      JSON.stringify(
        { app: 'WorkSync', project: p.name, publishedAt, files },
        null,
        2,
      ),
    );
    this.store.recordPublish(projectId, folder, files);
    this.writeParentIndex(folder);
    return this.status(projectId);
  }

  /**
   * When several projects publish to folders under the same parent, an index
   * page there links to each. An index.html WorkSync did not write is left alone.
   */
  private writeParentIndex(folder: string): void {
    const parent = path.dirname(folder);
    const siblings = this.store
      .latestPublishes()
      .filter((x) => path.dirname(x.folder) === parent);
    if (siblings.length < 2) return;
    const target = path.join(parent, PAGE_FILE);
    try {
      if (
        fs.existsSync(target) &&
        !fs
          .readFileSync(target, 'utf8')
          .includes('<meta name="generator" content="WorkSync">')
      )
        return;
      writeAtomic(
        target,
        buildIndexPage(
          siblings.map((s) => ({
            name: s.name,
            folder: path.basename(s.folder),
            publishedAt: s.at,
          })),
        ),
      );
    } catch {
      // The parent folder is optional; publishing the project already succeeded.
    }
  }
}
