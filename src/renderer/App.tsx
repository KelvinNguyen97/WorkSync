import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Startup } from '../shared/ipc';
import {
  BUILT_VIEWS,
  inFocus,
  matchesSearch,
  type Project,
  type Task,
} from '../shared/model';
import { AppProvider, useApp } from './appState';
import {
  ConfirmDelete,
  ProjectDialog,
  TaskDialog,
  ViewsDialog,
  viewIcon,
  viewName,
} from './dialogs';
import { Icon } from './Icon';
import { Modal, Toast } from './parts';
import { PriorityMenu, type MenuAnchor } from './PriorityMenu';
import { TaskPopup } from './TaskPopup';
import { BoardView, FocusView, initials, type ViewProps } from './views';
import { FilesView, ReviewDialog } from './files';
import { CalendarView, DashboardView, TimelineView } from './views2';
import { TasksView } from './tasksView';
import { PublishDialog, PublishedView, usePublishStatus } from './publish';
import { WriteDialog, usePendingCount } from './writeCopy';
import { ReportDialog } from './reports';
import { SettingsDialog } from './settings';
import { FilterButton, FilterNotice } from './filterBar';
import {
  NO_FILTER,
  matchesFilter,
  type ViewFilter,
} from '../shared/viewFilter';

const FILTER_KEY = 'worksync.filter';
import { PeopleDialog } from './people';
import { LinkWizard } from './LinkWizard';
import { AiDialog, GlossaryDialog, type AiSession } from './ai';
import type { SourceFile } from '../shared/sources';
import type { MyTask } from '../shared/myTasks';
import { MyTasksView } from './mine';
import { NotesView } from './notes';
import { CatalogView } from './catalog';
import type { CatalogEntry } from '../shared/catalog';
import type { Note } from '../shared/notes';
import { tr } from './i18n';

type Route =
  | { view: 'focus'; scope: 'all' | string }
  | { view: 'mine'; page: 'tasks' | 'notes' | 'catalog' }
  | { view: 'projectNotes'; projectId: string }
  | {
      view:
        | 'board'
        | 'tasks'
        | 'files'
        | 'timeline'
        | 'calendar'
        | 'dashboard'
        | 'published';
      projectId: string;
    };

type Dialog =
  | { kind: 'newProject' }
  | { kind: 'editProject'; project: Project }
  | { kind: 'views'; projectId: string }
  | { kind: 'newTask'; projectId: string }
  | { kind: 'editTask'; task: Task }
  | { kind: 'deleteTask'; task: Task }
  | { kind: 'link'; projectId: string }
  | { kind: 'review'; source: SourceFile }
  | {
      kind: 'ai';
      projectId: string;
      startAt: 'choose' | 'paste';
      preselect?: string[];
    }
  | { kind: 'glossary'; projectId: string }
  | { kind: 'people'; projectId: string }
  | { kind: 'publish'; projectId: string }
  | { kind: 'write' }
  | { kind: 'settings' }
  | {
      kind: 'importClash';
      info: NonNullable<
        Awaited<ReturnType<typeof window.worksync.chooseImport>>
      >;
    }
  | { kind: 'report'; projectId: string; taskIds?: string[] };

export function App() {
  const [startup, setStartup] = useState<Startup | null>(null);
  useEffect(() => {
    void window.worksync.start().then(setStartup);
  }, []);
  if (!startup) return <div className="boot">{tr('Opening WorkSync…')}</div>;
  if (!startup.ok) {
    return (
      <div className="boot">
        <div className="panel boot-error">
          <h1>{tr('WorkSync could not open its data')}</h1>
          <p>{startup.message}</p>
          <p className="muted">
            {tr('Data folder:')} {startup.dataFolder}
          </p>
        </div>
      </div>
    );
  }
  return (
    <AppProvider initial={startup}>
      <Shell dataFolder={startup.dataFolder} warning={startup.warning} />
    </AppProvider>
  );
}

function Shell({
  dataFolder,
  warning,
}: {
  dataFolder: string;
  warning: string | null;
}) {
  const {
    projects,
    tasks,
    today,
    project,
    originalFirst,
    setOriginalFirst,
    attempt,
    reloadAll,
    toast,
    sources,
    people,
  } = useApp();
  const [route, setRoute] = useState<Route>({ view: 'focus', scope: 'all' });
  const [active, setActive] = useState<string | null>(projects[0]?.id ?? null);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLElement>(null);
  const [headEl, setHeadEl] = useState<HTMLDivElement | null>(null);
  const [myTasks, setMyTasksState] = useState<MyTask[]>([]);
  const setMyTasks = useCallback(
    (f: (list: MyTask[]) => MyTask[]) => setMyTasksState(f),
    [],
  );
  const [myFocus, setMyFocus] = useState<string | null>(null);
  const [catalog, setCatalogState] = useState<CatalogEntry[]>([]);
  const setCatalog = useCallback(
    (f: (list: CatalogEntry[]) => CatalogEntry[]) => setCatalogState(f),
    [],
  );
  const [notes, setNotesState] = useState<Note[]>([]);
  const setNotes = useCallback(
    (f: (list: Note[]) => Note[]) => setNotesState(f),
    [],
  );
  useEffect(() => {
    void window.worksync.listMyTasks().then(setMyTasksState, () => {});
    void window.worksync.listNotes().then(setNotesState, () => {});
    void window.worksync.listCatalog().then(setCatalogState, () => {});
  }, []);
  // A deleted project leaves its notes without a project.
  useEffect(() => {
    void window.worksync.listNotes().then(setNotesState, () => {});
  }, [projects.length]);
  const [aiSession, setAiSession] = useState<AiSession | null>(null);
  const [dataWarning, setDataWarning] = useState(warning);
  const [filter, setFilterState] = useState<ViewFilter>(() => {
    try {
      return {
        ...NO_FILTER,
        ...JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}'),
      };
    } catch {
      return NO_FILTER;
    }
  });
  const setFilter = (f: ViewFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    } catch {
      // Remembering the filter is only a convenience.
    }
  };
  const [filterOpen, setFilterOpen] = useState(false);

  // Keep the route valid when a view is turned off or a project changes.
  useEffect(() => {
    if (route.view === 'projectNotes') {
      if (!project(route.projectId)) setRoute({ view: 'mine', page: 'notes' });
    } else if (
      route.view !== 'focus' &&
      route.view !== 'mine' &&
      !project(route.projectId)?.views[route.view]
    )
      setRoute({ view: 'focus', scope: route.projectId });
  }, [route, project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if (e.key === 'Escape' && !dialog && !menu && openId) {
        setOpenId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, menu, openId]);

  const go = (r: Route) => {
    setRoute(r);
    setSideOpen(false);
    if (viewRef.current) viewRef.current.scrollTop = 0;
    setScrolled(false);
  };

  // A reminder or the tray asks for a page.
  useEffect(
    () =>
      window.worksync.onOpen((target) => {
        if (target.page === 'catalog')
          setRoute({ view: 'mine', page: 'catalog' });
        if (target.page === 'myTasks') {
          setRoute({ view: 'mine', page: 'tasks' });
          setMyFocus(target.id ?? null);
          void window.worksync.listMyTasks().then(setMyTasksState, () => {});
        }
      }),
    [],
  );

  const openMenu = useCallback(
    (task: Task, opener: HTMLElement, at?: { x: number; y: number }) =>
      setMenu({ task, opener, at }),
    [],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  // Each view renders its header into the fixed area above the scrolling content.
  const passes = useCallback(
    (t: Task) => matchesFilter(t, filter, people),
    [filter, people],
  );
  const match = useCallback(
    (t: Task) => passes(t) && matchesSearch(t, query, people),
    [passes, query, people],
  );
  const props: ViewProps = {
    query,
    match,
    passes,
    openTask: setOpenId,
    openMenu,
    header: (title, subtitle, right) =>
      headEl &&
      createPortal(
        <div className="vh">
          <div>
            <h1>{title}</h1>
            <div className="sub">{subtitle}</div>
          </div>
          {right}
        </div>,
        headEl,
      ),
  };

  // Import: pick the file, and ask first when a project here has the same name.
  const importCopy = async () => {
    const info = await attempt(() => window.worksync.chooseImport());
    if (!info) return;
    if (info.sameName.length) setDialog({ kind: 'importClash', info });
    else await finishImport(info.file, null);
  };
  const finishImport = async (file: string, replace: string | null) => {
    const r = await attempt(() => window.worksync.importProject(file, replace));
    if (!r) return;
    setDialog(null);
    await reloadAll();
    setActive(r.projectId);
    go({ view: 'focus', scope: r.projectId });
    toast(
      [
        tr(
          replace
            ? 'Replaced {name} with {n} tasks.'
            : 'Imported {name} with {n} tasks.',
          {
            name: r.name,
            n: r.tasks,
          },
        ),
        replace ? tr('The old one is in the backups.') : '',
        r.missingFiles
          ? tr(
              '{n} linked files are not at the same place on this PC: use Find the file under Files.',
              { n: r.missingFiles },
            )
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  };

  const addSample = async () => {
    const id = await attempt(() => window.worksync.addSampleProject());
    if (id) {
      await reloadAll();
      setActive(id);
      go({ view: 'focus', scope: id });
      toast(tr('Added the sample project. Delete or keep it as you like.'));
    }
  };

  const mine = route.view === 'mine' || route.view === 'projectNotes';
  const currentProjectId =
    route.view === 'projectNotes'
      ? route.projectId
      : route.view === 'mine'
        ? active
        : route.view !== 'focus'
          ? route.projectId
          : route.scope !== 'all'
            ? route.scope
            : active;
  const body =
    route.view === 'projectNotes' ? (
      <NotesView
        key={route.projectId}
        notes={notes}
        setNotes={setNotes}
        projectId={route.projectId}
        query={query}
        head={headEl}
      />
    ) : route.view === 'mine' && route.page === 'catalog' ? (
      <CatalogView
        entries={catalog}
        setEntries={setCatalog}
        query={query}
        head={headEl}
      />
    ) : route.view === 'mine' && route.page === 'notes' ? (
      <NotesView
        notes={notes}
        setNotes={setNotes}
        query={query}
        head={headEl}
      />
    ) : route.view === 'mine' ? (
      <MyTasksView
        tasks={myTasks}
        setTasks={setMyTasks}
        query={query}
        head={headEl}
        focusId={myFocus}
      />
    ) : !projects.length ? (
      <Welcome
        onNew={() => setDialog({ kind: 'newProject' })}
        onSample={() => void addSample()}
      />
    ) : route.view === 'board' ? (
      <BoardView projectId={route.projectId} props={props} />
    ) : route.view === 'tasks' ? (
      <TasksView
        projectId={route.projectId}
        props={props}
        onCopyForAi={(ids) =>
          setDialog({
            kind: 'ai',
            projectId: route.projectId,
            startAt: 'choose',
            preselect: ids,
          })
        }
        onReport={(ids) =>
          setDialog({
            kind: 'report',
            projectId: route.projectId,
            taskIds: ids,
          })
        }
      />
    ) : route.view === 'timeline' ? (
      <TimelineView projectId={route.projectId} props={props} />
    ) : route.view === 'calendar' ? (
      <CalendarView projectId={route.projectId} props={props} />
    ) : route.view === 'dashboard' ? (
      <DashboardView projectId={route.projectId} props={props} />
    ) : route.view === 'published' ? (
      <PublishedView
        projectId={route.projectId}
        props={props}
        onPublish={() =>
          setDialog({ kind: 'publish', projectId: route.projectId })
        }
      />
    ) : route.view === 'files' ? (
      <FilesView
        projectId={route.projectId}
        props={props}
        onLink={() => setDialog({ kind: 'link', projectId: route.projectId })}
        onReview={(source) => setDialog({ kind: 'review', source })}
      />
    ) : (
      <FocusView
        scope={route.view === 'focus' ? route.scope : route.projectId}
        props={props}
        onNewTask={() =>
          currentProjectId &&
          setDialog({ kind: 'newTask', projectId: currentProjectId })
        }
      />
    );

  const changedSources = sources.filter((s) => s.state === 'changed');
  const [pubStatus] = usePublishStatus(currentProjectId);
  const pendingWrites = usePendingCount();
  const baseName = (f: string) => f.split(/[\\/]/).pop() ?? f;

  const focusCount = (scope: string | 'all') =>
    tasks.filter(
      (t) =>
        (scope === 'all' || t.projectId === scope) &&
        inFocus(t, today, project(t.projectId)?.dueSoonDays ?? 7),
    ).length;

  return (
    <div className="window" id="app">
      <div className="shell">
        <nav
          className={`sidebar ${sideOpen ? 'on' : ''}`}
          aria-label={tr('Projects and views')}
        >
          <div>
            <div className="nav-label">{tr('Today')}</div>
            <div className="nav">
              <button
                className="nav-item"
                aria-current={
                  route.view === 'focus' && route.scope === 'all'
                    ? 'page'
                    : undefined
                }
                onClick={() => go({ view: 'focus', scope: 'all' })}
              >
                <Icon name="focus" />
                <span className="grow">{tr('Focus, all projects')}</span>
                <span className="count">{focusCount('all')}</span>
              </button>
            </div>
          </div>
          <div>
            <div className="nav-label">{tr('Mine')}</div>
            <div className="nav">
              <button
                className="nav-item"
                aria-current={
                  route.view === 'mine' && route.page === 'tasks'
                    ? 'page'
                    : undefined
                }
                onClick={() => go({ view: 'mine', page: 'tasks' })}
              >
                <Icon name="todo" />
                <span className="grow">{tr('My tasks')}</span>
                <span className="count">{myTasks.length}</span>
              </button>
              <button
                className="nav-item"
                aria-current={
                  route.view === 'mine' && route.page === 'notes'
                    ? 'page'
                    : undefined
                }
                onClick={() => go({ view: 'mine', page: 'notes' })}
              >
                <Icon name="note" />
                <span className="grow">{tr('Notes')}</span>
                <span className="count">{notes.length}</span>
              </button>
              <button
                className="nav-item"
                aria-current={
                  route.view === 'mine' && route.page === 'catalog'
                    ? 'page'
                    : undefined
                }
                onClick={() => go({ view: 'mine', page: 'catalog' })}
              >
                <Icon name="grid" />
                <span className="grow">{tr('Catalog')}</span>
                <span className="count">{catalog.length}</span>
              </button>
            </div>
          </div>
          <div>
            <div className="nav-label">{tr('Projects')}</div>
            <div className="nav">
              {projects.map((p) => {
                const isActive = p.id === active;
                return (
                  <div className="proj" key={p.id}>
                    <button
                      className={`proj-btn ${isActive ? 'active' : ''}`}
                      aria-expanded={isActive}
                      onClick={() => setActive(isActive ? null : p.id)}
                    >
                      <span className="mono-tile">{initials(p.name)}</span>
                      <span style={{ minWidth: 0 }}>
                        <span className="proj-name">{p.name}</span>
                        <span className="proj-lang">
                          {p.originalLanguages
                            .map((l) => l.toUpperCase())
                            .join(' · ')}{' '}
                          → {p.workingLanguage.toUpperCase()}
                        </span>
                      </span>
                      <span className="count">{focusCount(p.id)}</span>
                    </button>
                    {isActive && (
                      <div className="subnav">
                        {BUILT_VIEWS.filter((k) => p.views[k]).map((k) => (
                          <button
                            key={k}
                            className="nav-item"
                            aria-current={
                              (k === 'focus' &&
                                route.view === 'focus' &&
                                route.scope === p.id) ||
                              (k !== 'focus' &&
                                route.view === k &&
                                route.projectId === p.id)
                                ? 'page'
                                : undefined
                            }
                            onClick={() =>
                              go(
                                k === 'focus'
                                  ? { view: 'focus', scope: p.id }
                                  : {
                                      view: k as Exclude<
                                        Route['view'],
                                        'focus' | 'mine'
                                      >,
                                      projectId: p.id,
                                    },
                              )
                            }
                          >
                            <Icon name={viewIcon(k)} />
                            <span className="grow">{viewName(k)}</span>
                          </button>
                        ))}
                        <button
                          className="nav-item"
                          aria-current={
                            route.view === 'projectNotes' &&
                            route.projectId === p.id
                              ? 'page'
                              : undefined
                          }
                          onClick={() =>
                            go({ view: 'projectNotes', projectId: p.id })
                          }
                        >
                          <Icon name="note" />
                          <span className="grow">{tr('Notes')}</span>
                          <span className="count">
                            {notes.filter((n) => n.projectId === p.id).length ||
                              ''}
                          </span>
                        </button>
                        <button
                          className="nav-item custom"
                          onClick={() =>
                            setDialog({ kind: 'newTask', projectId: p.id })
                          }
                        >
                          <Icon name="plus" />
                          <span className="grow">{tr('New task')}</span>
                        </button>
                        <button
                          className="nav-item custom"
                          onClick={() =>
                            setDialog({ kind: 'views', projectId: p.id })
                          }
                        >
                          <Icon name="sliders" />
                          <span className="grow">{tr('Choose views')}</span>
                        </button>
                        <button
                          className="nav-item custom"
                          onClick={() =>
                            setDialog({ kind: 'people', projectId: p.id })
                          }
                        >
                          <Icon name="user" />
                          <span className="grow">{tr('People')}</span>
                        </button>
                        <button
                          className="nav-item custom"
                          onClick={() =>
                            setDialog({ kind: 'glossary', projectId: p.id })
                          }
                        >
                          <Icon name="note" />
                          <span className="grow">{tr('Glossary')}</span>
                        </button>
                        <button
                          className="nav-item custom"
                          onClick={() =>
                            setDialog({ kind: 'report', projectId: p.id })
                          }
                        >
                          <Icon name="file" />
                          <span className="grow">{tr('Make a report')}</span>
                        </button>
                        <button
                          className="nav-item custom"
                          onClick={() =>
                            setDialog({ kind: 'editProject', project: p })
                          }
                        >
                          <Icon name="edit" />
                          <span className="grow">{tr('Project settings')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              <button
                className="nav-item custom"
                onClick={() => setDialog({ kind: 'newProject' })}
              >
                <Icon name="plus" />
                <span className="grow">{tr('New project')}</span>
              </button>
              <button
                className="nav-item custom"
                title={tr(
                  'Add a project from a .worksync file someone gave you',
                )}
                onClick={() => void importCopy()}
              >
                <Icon name="upload" />
                <span className="grow">{tr('Import a project')}</span>
              </button>
            </div>
          </div>
          <button
            className="nav-item custom side-settings"
            onClick={() => setDialog({ kind: 'settings' })}
          >
            <Icon name="sliders" />
            <span className="grow">{tr('Settings')}</span>
          </button>
          <div className="side-foot">
            <span>
              <Icon name="lock" />
              {tr('Data stays on this PC')}
            </span>
            <span className="path" title={dataFolder}>
              <Icon name="folder" />
              <span className="grow-ellipsis">{dataFolder}</span>
            </span>
          </div>
        </nav>
        <div className="main">
          <header className="topbar">
            <button
              className="icon-btn menu-btn"
              aria-label={tr('Open the sidebar')}
              onClick={() => setSideOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <label className="search" htmlFor="q">
              <Icon name="search" />
              <input
                id="q"
                ref={search}
                type="search"
                placeholder={
                  route.view === 'mine' && route.page === 'tasks'
                    ? tr('Search my tasks')
                    : route.view === 'mine' && route.page === 'catalog'
                      ? tr('Search the Catalog: name, path, tags or note')
                      : mine
                        ? tr('Search notes: title, text or tags')
                        : tr('Search by number, label, title or person')
                }
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <span className="kbd">{tr('Ctrl K')}</span>
            </label>
            {!mine && (
              <>
                <FilterButton
                  filter={filter}
                  setFilter={setFilter}
                  tasks={tasks.filter(
                    (t) =>
                      t.fileState !== 'removed' &&
                      (!currentProjectId || t.projectId === currentProjectId),
                  )}
                  open={filterOpen}
                  setOpen={setFilterOpen}
                />
                <button
                  className="btn compact"
                  aria-pressed={originalFirst}
                  aria-label={tr('Original first')}
                  title={tr(
                    'Show the customer’s original text first, for meetings',
                  )}
                  onClick={() => setOriginalFirst(!originalFirst)}
                >
                  <Icon name="swap" />
                  <span className="lbl">{tr('Original first')}</span>
                </button>
                <button
                  aria-label={tr('Copy for AI')}
                  className="btn"
                  disabled={!currentProjectId}
                  title={tr('Build a request for the Gemini web app')}
                  onClick={() =>
                    currentProjectId &&
                    setDialog({
                      kind: 'ai',
                      projectId:
                        aiSession?.projectId === currentProjectId
                          ? aiSession.projectId
                          : currentProjectId,
                      startAt: 'choose',
                    })
                  }
                >
                  <Icon name="spark" />
                  <span className="lbl">{tr('Copy for AI')}</span>
                </button>
                <button
                  className="btn compact"
                  aria-label={tr('Paste from AI')}
                  disabled={!aiSession}
                  title={
                    aiSession
                      ? tr('Paste Gemini’s answer')
                      : tr('Use Copy for AI first')
                  }
                  onClick={() =>
                    aiSession &&
                    setDialog({
                      kind: 'ai',
                      projectId: aiSession.projectId,
                      startAt: 'paste',
                    })
                  }
                >
                  <Icon name="copy" />
                  <span className="lbl">{tr('Paste from AI')}</span>
                  {aiSession &&
                    aiSession.batches.length - aiSession.done.length > 0 && (
                      <span className="badge">
                        {aiSession.batches.length - aiSession.done.length}
                      </span>
                    )}
                </button>
                {sources.length > 0 && (
                  <button
                    aria-label={tr('Write to copy')}
                    className="btn"
                    title={
                      pendingWrites
                        ? `${pendingWrites} changes not yet written to your copy`
                        : tr('Write changes to your copy of a customer file')
                    }
                    onClick={() => setDialog({ kind: 'write' })}
                  >
                    <Icon name="save" />
                    <span className="lbl">{tr('Write to copy')}</span>
                    {pendingWrites > 0 && (
                      <span className="badge">{pendingWrites}</span>
                    )}
                  </button>
                )}
                <button
                  aria-label={tr('Publish')}
                  className="btn"
                  disabled={!currentProjectId}
                  title={
                    pubStatus?.unpublished
                      ? `${pubStatus.unpublished} changes not published yet`
                      : tr('Publish to the shared folder')
                  }
                  onClick={() =>
                    currentProjectId &&
                    setDialog({ kind: 'publish', projectId: currentProjectId })
                  }
                >
                  <Icon name="upload" />
                  <span className="lbl">{tr('Publish')}</span>
                  {pubStatus?.folder && pubStatus.unpublished > 0 && (
                    <span className="badge">{pubStatus.unpublished}</span>
                  )}
                </button>
                <button
                  aria-label={tr('New task')}
                  className="btn primary"
                  disabled={!currentProjectId}
                  title={
                    currentProjectId
                      ? `Add a task to ${project(currentProjectId)?.name}`
                      : tr('Create a project first')
                  }
                  onClick={() =>
                    currentProjectId &&
                    setDialog({ kind: 'newTask', projectId: currentProjectId })
                  }
                >
                  <Icon name="plus" />
                  <span className="lbl">{tr('New task')}</span>
                </button>
              </>
            )}
          </header>
          <div className="notices">
            <FilterNotice
              filter={filter}
              setFilter={setFilter}
              onEdit={() => setFilterOpen(true)}
            />
            {dataWarning && (
              <div className="notice warn" role="alert">
                <Icon name="alert" />
                <span className="notice-text">{dataWarning}</span>
                <span className="notice-actions">
                  <button
                    className="btn sm"
                    onClick={() => setDataWarning(null)}
                  >
                    {tr('Not now')}
                  </button>
                </span>
              </div>
            )}
            {pubStatus && pubStatus.tampered.length > 0 && currentProjectId && (
              <div className="notice warn" role="status">
                <Icon name="alert" />
                <span className="notice-text">
                  <b>
                    {tr('The published')} {pubStatus.tampered.join(' and ')}{' '}
                    changed
                  </b>{' '}
                  {tr(
                    '· someone edited or deleted it in the shared folder after you published',
                  )}
                </span>
                <span className="notice-actions">
                  <button
                    className="btn sm accent-outline"
                    onClick={() =>
                      setDialog({
                        kind: 'publish',
                        projectId: currentProjectId,
                      })
                    }
                  >
                    {tr('Publish again')}
                  </button>
                </span>
              </div>
            )}
            {changedSources.length > 0 && (
              <div className="notice" role="status">
                <Icon name="refresh" />
                <span className="notice-text">
                  <b>
                    {changedSources.length === 1
                      ? `${baseName(changedSources[0].currentFile)} changed`
                      : `${changedSources.length} linked files changed`}
                  </b>
                  {' · '}
                  {changedSources
                    .map((s) => project(s.projectId)?.name)
                    .filter((v, i, a) => v && a.indexOf(v) === i)
                    .join(', ')}
                </span>
                <span className="notice-actions">
                  <button
                    className="btn sm accent-outline"
                    onClick={() =>
                      setDialog({ kind: 'review', source: changedSources[0] })
                    }
                  >
                    {tr('Review changes')}
                  </button>
                </span>
              </div>
            )}
          </div>
          <div
            className={`vhead ${scrolled ? 'scrolled' : ''}`}
            ref={setHeadEl}
          />
          <main
            className={`view ${mine ? 'fill' : ''}`}
            ref={viewRef}
            tabIndex={-1}
            onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
          >
            <div className={`v-${route.view}`}>{body}</div>
          </main>
        </div>
        <div
          className={`scrim ${sideOpen ? 'on' : ''}`}
          onClick={() => setSideOpen(false)}
        />
      </div>

      {openId && (
        <TaskPopup
          taskId={openId}
          onClose={() => setOpenId(null)}
          onEdit={(task) => setDialog({ kind: 'editTask', task })}
          onDelete={(task) => setDialog({ kind: 'deleteTask', task })}
          openMenu={openMenu}
        />
      )}
      {menu && (
        <PriorityMenu
          anchor={{
            ...menu,
            task: tasks.find((t) => t.id === menu.task.id) ?? menu.task,
          }}
          onClose={closeMenu}
        />
      )}
      {dialog?.kind === 'newProject' && (
        <ProjectDialog
          onClose={() => setDialog(null)}
          onSaved={(p) => {
            setActive(p.id);
            go({ view: 'focus', scope: p.id });
            // Next comes the first source file; closing the wizard leaves tasks to be added by hand.
            setDialog({ kind: 'link', projectId: p.id });
          }}
        />
      )}
      {dialog?.kind === 'editProject' && (
        <ProjectDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
          onDeleted={() => {
            const gone = dialog.project.id;
            setDialog(null);
            setOpenId(null);
            setActive(projects.find((p) => p.id !== gone)?.id ?? null);
            go({ view: 'focus', scope: 'all' });
          }}
        />
      )}
      {dialog?.kind === 'views' && project(dialog.projectId) && (
        <ViewsDialog
          project={project(dialog.projectId)!}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'newTask' && (
        <TaskDialog
          projectId={dialog.projectId}
          onClose={() => setDialog(null)}
          onSaved={(t) => {
            setDialog(null);
            setOpenId(t.id);
          }}
        />
      )}
      {dialog?.kind === 'editTask' && (
        <TaskDialog
          projectId={dialog.task.projectId}
          task={dialog.task}
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'link' && project(dialog.projectId) && (
        <LinkWizard
          project={project(dialog.projectId)!}
          onClose={() => setDialog(null)}
          onLinked={() => {
            setDialog(null);
            go({ view: 'focus', scope: dialog.projectId });
          }}
        />
      )}
      {dialog?.kind === 'ai' && project(dialog.projectId) && (
        <AiDialog
          project={project(dialog.projectId)!}
          session={aiSession?.projectId === dialog.projectId ? aiSession : null}
          setSession={setAiSession}
          startAt={dialog.startAt}
          preselect={dialog.preselect}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'importClash' && (
        <ImportClash
          info={dialog.info}
          onCopy={() => void finishImport(dialog.info.file, null)}
          onReplace={(id) => void finishImport(dialog.info.file, id)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'settings' && (
        <SettingsDialog onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'write' && (
        <WriteDialog onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'report' && project(dialog.projectId) && (
        <ReportDialog
          project={project(dialog.projectId)!}
          taskIds={dialog.taskIds}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'publish' && project(dialog.projectId) && (
        <PublishDialog
          project={project(dialog.projectId)!}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'people' && project(dialog.projectId) && (
        <PeopleDialog
          project={project(dialog.projectId)!}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'glossary' && project(dialog.projectId) && (
        <GlossaryDialog
          project={project(dialog.projectId)!}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'review' && (
        <ReviewDialog source={dialog.source} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'deleteTask' && (
        <ConfirmDelete
          task={dialog.task}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            setOpenId(null);
          }}
        />
      )}
      <Toast />
    </div>
  );
}

function Welcome({
  onNew,
  onSample,
}: {
  onNew: () => void;
  onSample: () => void;
}) {
  return (
    <div className="welcome">
      <h1>{tr('Welcome to WorkSync')}</h1>
      <p>
        {tr(
          'Start with a project for one customer. Link the customer’s Excel file to bring in its tasks, or add tasks by hand.',
        )}
      </p>
      <div
        style={{
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        <button className="btn primary" onClick={onNew}>
          <Icon name="plus" />
          {tr('New project')}
        </button>
        <button className="btn" onClick={onSample}>
          <Icon name="spark" />
          {tr('Try the sample project')}
        </button>
      </div>
    </div>
  );
}

/**
 * Importing a project whose name is already used here: make a copy beside
 * it, or replace the existing project with the imported one.
 */
function ImportClash({
  info,
  onCopy,
  onReplace,
  onClose,
}: {
  info: NonNullable<Awaited<ReturnType<typeof window.worksync.chooseImport>>>;
  onCopy: () => void;
  onReplace: (projectId: string) => void;
  onClose: () => void;
}) {
  const { projects } = useApp();
  const [target, setTarget] = useState(info.sameName[0].id);
  const [busy, setBusy] = useState(false);
  const old = info.sameName.find((p) => p.id === target)!;
  const exported = info.exportedAt
    ? new Date(info.exportedAt).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  // The name a copy would get, as Windows names copies.
  const taken = new Set(projects.map((p) => p.name.trim().toLowerCase()));
  const root = info.name.replace(/\s*\(\d+\)$/, '');
  let n = 1;
  while (taken.has(`${root} (${n})`.toLowerCase())) n++;
  const copyName = `${root} (${n})`;
  return (
    <Modal
      title={`A project called ${info.name} already exists`}
      subtitle={tr(
        'Keep both, or replace yours with the one you are importing.',
      )}
      onClose={onClose}
      narrow
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onCopy();
            }}
          >
            {tr('Import as a copy')}
          </button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onReplace(old.id);
            }}
          >
            {tr('Replace')} {old.name}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="clash">
          <div>
            <small>{tr('Here now')}</small>
            {info.sameName.length > 1 ? (
              <select
                className="inp sm"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                aria-label={tr('Project to replace')}
              >
                {info.sameName.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <b>{old.name}</b>
            )}
            <span>
              {old.tasks} task{old.tasks === 1 ? '' : 's'}
            </span>
          </div>
          <div>
            <small>{tr('In the file')}</small>
            <b>{info.name}</b>
            <span>
              {info.tasks} task{info.tasks === 1 ? '' : 's'}
              {exported ? ` · exported ${exported}` : ''}
            </span>
          </div>
        </div>
        <p className="muted step-help">
          <b>{tr('Import as a copy')}</b> {tr('adds it as')} {copyName}
          {tr(', and yours stays as it is.')}
        </p>
        <p className="muted step-help">
          <b>
            {tr('Replace')} {old.name}
          </b>{' '}
          {tr(
            'deletes yours, with its tasks, notes and history, and puts the imported one in its place. WorkSync backs up first, so you can get yours back from Settings.',
          )}
        </p>
      </div>
    </Modal>
  );
}
