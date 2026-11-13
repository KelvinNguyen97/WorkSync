import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { migrate } from './db';
import { buildPage, pageData } from './publishPage';
import {
  EXPORT_FILE,
  FINGERPRINT_FILE,
  PAGE_FILE,
  Publisher,
} from './publisher';
import { Sources } from './sources';
import { Store } from './store';

let dir: string;
let store: Store;
let sources: Sources;
let pub: Publisher;
let projectId: string;

const input = {
  customerId: '012',
  titleOriginal: 'ログイン画面のタイムアウト',
  titleTranslation: 'Login times out',
  descriptionOriginal: '',
  descriptionTranslation: '',
  summary: 'Sessions expire early.',
  notes: 'Private note',
  status: 'In progress' as const,
  priority: 'U' as const,
  labels: ['Auth'],
  assignee: '',
  category: '',
  remarks: '',
  plannedStart: null,
  plannedEnd: null,
  actualStart: null,
  actualEnd: null,
  nextAction: 'Call Suzuki',
  nextActionDate: null,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worksync-pub-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  store = new Store(db);
  sources = new Sources(db, store);
  pub = new Publisher(store, sources, path.join(dir, 'preview'));
  projectId = store.createProject({
    name: 'Portal',
    customer: 'Hoshizora',
    originalLanguages: ['ja'],
    workingLanguage: 'en',
  }).id;
  store.createTask(projectId, input);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the published page', () => {
  it('holds the briefs and leaves out notes and next actions unless chosen', () => {
    const html = buildPage({
      project: store.getProject(projectId),
      tasks: store.listTasks(),
      updates: {},
      publishedAt: '2026-11-03T05:20:00Z',
      today: '2026-11-03',
      includeNotes: false,
    });
    expect(html).toContain('Login times out');
    expect(html).toContain('Sessions expire early.');
    expect(html).not.toContain('Private note');
    expect(html).not.toContain('Call Suzuki');
    const withNotes = buildPage({
      project: store.getProject(projectId),
      tasks: store.listTasks(),
      updates: {},
      publishedAt: '2026-11-03T05:20:00Z',
      today: '2026-11-03',
      includeNotes: true,
    });
    expect(withNotes).toContain('Private note');
  });

  it('carries the owner’s Board columns, with each task in its column', () => {
    const t = store.listTasks()[0];
    store.updateTask(t.id, { status: 'In review' });
    store.setBoard(projectId, {
      hidden: ['On hold', 'Cancelled'],
      columns: [{ id: 'w', name: 'Waiting for test', status: 'In review' }],
    });
    store.setBoardColumn(t.id, 'w');
    const data = pageData({
      project: store.getProject(projectId),
      tasks: store.listTasks(),
      updates: {},
      publishedAt: '2026-11-03T05:20:00Z',
      today: '2026-11-03',
      includeNotes: false,
    });
    expect(data.board.map((c) => c.name)).toEqual([
      'Not started',
      'In progress',
      'Waiting for test',
      'In review',
      'Done',
    ]);
    expect(data.tasks[0].col).toBe('own:w');
  });

  it('cannot be broken by task text', () => {
    const t = store.listTasks()[0];
    const html = buildPage({
      project: store.getProject(projectId),
      tasks: [{ ...t, summary: '</script><script>alert(1)</script>' }],
      updates: {},
      publishedAt: '2026-11-03T05:20:00Z',
      today: '2026-11-03',
      includeNotes: false,
    });
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });
});

describe('Publisher', () => {
  it('publishes the page, the Excel export and fingerprints, and notices changes to them', () => {
    const folder = path.join(dir, 'share', 'Portal');
    store.setPublishOptions(projectId, { folder });
    expect(pub.status(projectId)).toMatchObject({
      lastAt: null,
      unpublished: 1,
      tampered: [],
    });
    const s = pub.publish(projectId);
    expect(s).toMatchObject({
      unpublished: 0,
      tampered: [],
      folderProblem: null,
    });
    expect(fs.readdirSync(folder).sort()).toEqual(
      [PAGE_FILE, EXPORT_FILE, FINGERPRINT_FILE].sort(),
    );
    const wb = XLSX.read(fs.readFileSync(path.join(folder, EXPORT_FILE)));
    expect(
      XLSX.utils
        .sheet_to_json<string[]>(wb.Sheets.Tasks, { header: 1 })[1]
        .slice(0, 4),
    ).toEqual([
      '012',
      'Login times out',
      'ログイン画面のタイムアウト',
      'In progress',
    ]);

    fs.appendFileSync(path.join(folder, PAGE_FILE), '<!-- edited -->');
    fs.rmSync(path.join(folder, EXPORT_FILE));
    expect(pub.status(projectId).tampered.sort()).toEqual(
      [EXPORT_FILE, PAGE_FILE].sort(),
    );
    pub.publish(projectId);
    expect(pub.status(projectId).tampered).toEqual([]);
  });

  it('refuses a folder inside Box or a linked file’s folder', () => {
    store.setPublishOptions(projectId, {
      folder: path.join(dir, 'Box', 'Hoshizora'),
    });
    expect(() => pub.publish(projectId)).toThrow('inside Box');
  });

  it('writes an index page for projects under the same parent, but never over the owner’s own', () => {
    const share = path.join(dir, 'share');
    const other = store.createProject({
      name: 'IoT',
      customer: '',
      originalLanguages: ['ja'],
      workingLanguage: 'en',
    }).id;
    store.setPublishOptions(projectId, { folder: path.join(share, 'Portal') });
    store.setPublishOptions(other, { folder: path.join(share, 'IoT') });
    pub.publish(projectId);
    expect(fs.existsSync(path.join(share, PAGE_FILE))).toBe(false);
    pub.publish(other);
    const index = fs.readFileSync(path.join(share, PAGE_FILE), 'utf8');
    expect(index).toContain('Portal/index.html');
    expect(index).toContain('IoT/index.html');

    fs.writeFileSync(
      path.join(share, PAGE_FILE),
      '<html>the team’s own page</html>',
    );
    pub.publish(projectId);
    expect(fs.readFileSync(path.join(share, PAGE_FILE), 'utf8')).toBe(
      '<html>the team’s own page</html>',
    );
  });

  it('writes previews into the app’s own folder', () => {
    const file = pub.preview(projectId);
    expect(file.startsWith(path.join(dir, 'preview'))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('Login times out');
  });
});
