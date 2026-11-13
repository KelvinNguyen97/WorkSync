import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  toIsoDate,
  type GlossaryTerm,
  type Person,
  type Project,
  type Task,
} from '../shared/model';
import type { SourceFile } from '../shared/sources';
import type { AppSettings } from '../shared/settings';
import { setTheme, setUiLanguage, tr, uiLanguage } from './i18n';
import { translateMessage } from '../shared/i18n';
import { useEffect } from 'react';

export interface ToastMessage {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  error?: boolean;
}

interface AppState {
  /** Today's date (YYYY-MM-DD), kept current while the app stays open. */
  today: string;
  /** The time, refreshed every minute, for "5 min ago" and similar. */
  now: number;
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  people: Person[];
  reloadPeople: () => Promise<void>;
  glossary: GlossaryTerm[];
  reloadGlossary: () => Promise<void>;
  projects: Project[];
  tasks: Task[];
  sources: SourceFile[];
  setSources: (s: SourceFile[]) => void;
  originalFirst: boolean;
  setOriginalFirst: (v: boolean) => void;
  project: (id: string) => Project | undefined;
  /** Replaces one task in the list after the main process changed it. */
  putTask: (t: Task) => void;
  removeTask: (id: string) => void;
  putProject: (p: Project) => void;
  reloadTasks: () => Promise<void>;
  reloadAll: () => Promise<void>;
  toast: (text: string, action?: ToastMessage['action']) => void;
  /** Runs a change and shows its error, if any, as a toast. */
  attempt: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  toastMessage: ToastMessage | null;
  dismissToast: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export function AppProvider({
  initial,
  children,
}: {
  initial: {
    today: string;
    projects: Project[];
    tasks: Task[];
    sources: SourceFile[];
    settings: AppSettings;
    people: Person[];
    glossary: GlossaryTerm[];
  };
  children: ReactNode;
}) {
  const [projects, setProjects] = useState(initial.projects);
  const [tasks, setTasks] = useState(initial.tasks);
  const [today, setToday] = useState(initial.today);
  // The clock moves on while the app stays open (past midnight, or after the
  // PC sleeps), so deadlines such as "Due in 2 days" and "Overdue" follow it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 60 * 1000);
    const onShow = () => {
      if (!document.hidden) tick();
    };
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', onShow);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, []);
  useEffect(() => {
    const d = toIsoDate(new Date(now));
    setToday((t) => (t === d ? t : d));
  }, [now]);
  const [sources, setSources] = useState(initial.sources);
  const [settings, setSettings] = useState(initial.settings);
  const [people, setPeople] = useState(initial.people);
  const [glossary, setGlossary] = useState(initial.glossary);
  // Linked files are checked in the main process; it tells the window when their states change.
  useEffect(() => {
    const stop = window.worksync.onSourcesChanged(setSources);
    void window.worksync.checkSources().then(setSources);
    return stop;
  }, []);
  const [originalFirst, setOriginalFirst] = useState(false);
  const [toastMessage, setToastMessage] = useState<ToastMessage | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const toastId = useRef(0);

  const show = useCallback((m: Omit<ToastMessage, 'id'>) => {
    window.clearTimeout(toastTimer.current);
    setToastMessage({ ...m, id: ++toastId.current });
    toastTimer.current = window.setTimeout(
      () => setToastMessage(null),
      m.action ? 6000 : 4200,
    );
  }, []);

  // The app language applies before anything renders with it.
  setUiLanguage(settings.uiLanguage);
  setTheme(settings.theme);

  const value = useMemo<AppState>(
    () => ({
      today,
      now,
      settings,
      setSettings,
      people,
      reloadPeople: async () => setPeople(await window.worksync.listPeople()),
      glossary,
      reloadGlossary: async () =>
        setGlossary(await window.worksync.listAllGlossary()),
      projects,
      tasks,
      sources,
      setSources,
      originalFirst,
      setOriginalFirst,
      project: (id) => projects.find((p) => p.id === id),
      putTask: (t) =>
        setTasks((all) =>
          all.some((x) => x.id === t.id)
            ? all.map((x) => (x.id === t.id ? t : x))
            : [...all, t],
        ),
      removeTask: (id) => setTasks((all) => all.filter((x) => x.id !== id)),
      putProject: (p) =>
        setProjects((all) =>
          all.some((x) => x.id === p.id)
            ? all.map((x) => (x.id === p.id ? p : x))
            : [...all, p],
        ),
      reloadTasks: async () => setTasks(await window.worksync.listTasks()),
      reloadAll: async () => {
        const s = await window.worksync.start();
        if (s.ok) {
          setProjects(s.projects);
          setTasks(s.tasks);
          setSources(s.sources);
          setSettings(s.settings);
          setPeople(s.people);
          setGlossary(s.glossary);
          setToday(s.today);
        }
      },
      // Messages and buttons in the app language (also those built in code).
      toast: (text, action) =>
        show({
          text: translateMessage(uiLanguage(), text),
          action: action && { ...action, label: tr(action.label) },
        }),
      attempt: async (fn) => {
        try {
          return await fn();
        } catch (error) {
          show({
            text: error instanceof Error ? error.message : String(error),
            error: true,
          });
          return undefined;
        }
      },
      toastMessage,
      dismissToast: () => setToastMessage(null),
    }),
    [
      today,
      now,
      settings,
      people,
      glossary,
      projects,
      tasks,
      sources,
      originalFirst,
      toastMessage,
      show,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
