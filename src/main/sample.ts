import {
  addDays,
  type Level,
  type Status,
  type TaskInput,
} from '../shared/model';
import type { Store } from './store';

interface SampleTask {
  id: string;
  ja: string;
  en: string;
  pri: Level;
  st: Status;
  labels: string[];
  sum?: string;
  /** Days from today. */
  start?: number;
  end?: number;
  hb?: string;
  now?: string;
  next?: string;
  nextIn?: number;
  diff?: string;
  pin?: boolean;
  dja?: string;
  den?: string;
}

/** A made-up project in the shape of a typical Japanese WBS, so every view has something to show. */
const TASKS: SampleTask[] = [
  {
    id: '012',
    ja: 'ログイン画面のタイムアウト',
    en: 'Login screen times out',
    pri: 'U',
    st: 'In progress',
    labels: ['Auth', 'Release 2.1'],
    sum: 'Users are logged out after 5 minutes instead of 30. Blocks the customer acceptance test.',
    start: -6,
    end: 2,
    hb: 'Yamada (our team)',
    now: 'Reproducing the timeout on the staging server',
    next: 'Fix the session setting and redeploy',
    nextIn: 1,
    diff: 'Staging logs need the customer’s approval to read',
    pin: true,
    dja: 'ログイン後5分で自動ログアウトされる。設定値は30分のはず。受入テストを妨げているため至急対応が必要。',
    den: 'Users are logged out automatically 5 minutes after logging in. The setting should be 30 minutes. It blocks the acceptance test, so it needs an urgent fix.',
  },
  {
    id: '018',
    ja: '出荷データCSV取込時の文字化け',
    en: 'Garbled text when importing shipping CSV',
    pri: 'U',
    st: 'In review',
    labels: ['Import', 'CSV'],
    sum: 'Shift-JIS files from the warehouse are read as UTF-8.',
    start: -9,
    end: -2,
    hb: 'Tanaka (customer)',
    now: 'Checking the fix with real shipping files',
    next: 'Customer confirms the fix',
    nextIn: 2,
  },
  {
    id: '022',
    ja: '夜間バッチ処理が途中で停止する',
    en: 'Nightly batch stops halfway',
    pri: 'U',
    st: 'On hold',
    labels: ['Batch', 'Infra'],
    sum: 'The batch runs out of memory on month-end data.',
    start: -10,
    end: 9,
    hb: 'Sato (our team)',
    now: 'Waiting for approval to add memory to the batch server',
    next: 'Approval from the customer’s IT team',
    nextIn: -3,
    diff: 'Server change needs a change request',
  },
  {
    id: '007',
    ja: '権限マスタの設計レビュー',
    en: 'Design review of the permission master',
    pri: 'H',
    st: 'In review',
    labels: ['Permissions', 'Design'],
    sum: 'Customer reviews who can approve orders.',
    start: -8,
    end: 3,
    hb: 'You and Suzuki (customer)',
    now: 'Customer is reviewing the role table',
    pin: true,
  },
  {
    id: '021',
    ja: '納品書PDFのレイアウト崩れ',
    en: 'Delivery note PDF layout breaks',
    pri: 'H',
    st: 'In progress',
    labels: ['PDF', 'Forms'],
    sum: 'Long product names push the total off the page.',
    start: -3,
    end: 7,
    hb: 'Nguyen (our team)',
    now: 'Testing line wrapping for long product names',
    diff: 'No sample with the longest product names',
  },
  {
    id: '027',
    ja: 'パスワード再設定メールが届かない',
    en: 'Password reset email does not arrive',
    pri: 'H',
    st: 'On hold',
    labels: ['Mail', 'Infra'],
    sum: 'Mail from the new server is blocked by the customer’s spam filter.',
    start: -5,
    end: 5,
    hb: 'Customer IT',
    now: 'Checking the mail filter rules',
  },
  {
    id: '014',
    ja: '在庫照会の応答速度改善',
    en: 'Speed up the stock lookup',
    pri: 'N',
    st: 'In progress',
    labels: ['Performance'],
    sum: 'Stock search takes 8 seconds. The target is under 2 seconds.',
    start: -12,
    end: 12,
    hb: 'Sato (our team)',
    now: 'Adding an index and testing with production-size data',
    next: 'Performance test report',
    nextIn: 8,
  },
  {
    id: '025',
    ja: '本番環境のSSL証明書更新',
    en: 'Renew the production SSL certificate',
    pri: 'N',
    st: 'Not started',
    labels: ['Infra', 'Contract'],
    sum: 'The certificate expires on the 20th. Renewal needs a purchase order from the customer.',
    start: -1,
    end: 9,
    hb: 'You',
    now: 'Waiting to start',
    next: 'Ask the customer for the purchase order',
    nextIn: 1,
  },
  {
    id: '031',
    ja: 'ダッシュボードのグラフ表示',
    en: 'Charts on the dashboard',
    pri: 'N',
    st: 'In progress',
    labels: ['Dashboard', 'Release 2.2'],
    sum: 'Show daily shipments as a chart on the home screen.',
    start: -5,
    end: 15,
    hb: 'Nguyen (our team)',
    now: 'Building the chart component',
  },
  {
    id: '033',
    ja: '多言語対応（英語表示）',
    en: '',
    pri: 'N',
    st: 'Not started',
    labels: ['i18n', 'Release 2.2'],
    start: 13,
    end: 24,
  },
  {
    id: '030',
    ja: 'API仕様書の英訳',
    en: 'Translate the API specification into English',
    pri: 'L',
    st: 'Not started',
    labels: ['Docs'],
    sum: 'For the offshore team. Only the order and stock APIs are needed first.',
    start: 13,
    end: 22,
  },
  {
    id: '009',
    ja: '結合テスト計画書の作成',
    en: 'Write the integration test plan',
    pri: 'H',
    st: 'Done',
    labels: ['Test'],
    start: -14,
    end: -4,
  },
];

const blank: TaskInput = {
  customerId: '',
  titleOriginal: '',
  titleTranslation: '',
  descriptionOriginal: '',
  descriptionTranslation: '',
  summary: '',
  notes: '',
  status: 'Not started',
  priority: 'N',
  labels: [],
  assignee: '',
  category: '',
  remarks: '',
  plannedStart: null,
  plannedEnd: null,
  actualStart: null,
  actualEnd: null,
  nextAction: '',
  nextActionDate: null,
};

/** Adds the sample project, with dates around today. */
export function addSampleProject(store: Store, today: string): string {
  const p = store.createProject({
    name: 'Sample: Logistics Portal Renewal',
    customer: 'Hoshizora Logistics (sample)',
    originalLanguages: ['ja', 'en'],
    workingLanguage: 'en',
  });
  for (const s of TASKS) {
    const d = (n?: number) => (n === undefined ? null : addDays(today, n));
    const t = store.createTask(p.id, {
      ...blank,
      customerId: s.id,
      titleOriginal: s.ja,
      titleTranslation: s.en,
      descriptionOriginal: s.dja ?? '',
      descriptionTranslation: s.den ?? '',
      summary: s.sum ?? '',
      status: s.st,
      priority: s.pri,
      labels: s.labels,
      plannedStart: d(s.start),
      plannedEnd: d(s.end),
      actualStart: s.st === 'Not started' ? null : d(s.start),
      actualEnd: s.st === 'Done' ? d(s.end) : null,
    });
    if (s.hb || s.now || s.next) {
      store.addSituationUpdate(t.id, {
        handledBy: s.hb ?? '',
        doingNow: s.now ?? '',
        nextStep: s.next ?? '',
        nextDate: s.nextIn === undefined ? null : addDays(today, s.nextIn),
        newDifficulty: s.diff ? { text: s.diff, resolver: '' } : undefined,
      });
    }
    if (s.pin) store.setPinned(t.id, true);
  }
  return p.id;
}
