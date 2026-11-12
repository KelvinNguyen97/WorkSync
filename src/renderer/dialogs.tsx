import { useEffect, useState, type FormEvent } from 'react';
import {
  BUILT_VIEWS,
  DATE_FORMATS,
  formatDate,
  type DateFormat,
  LANGUAGES,
  LEVELS,
  LEVEL_NAME,
  STATUSES,
  detectLanguage,
  type LanguageCode,
  type Project,
  type Task,
  type TaskInput,
  type ViewKey,
} from '../shared/model';
import { useApp } from './appState';
import { Icon, type IconName } from './Icon';
import { Modal, useTaskLabel } from './parts';
import { tr } from './i18n';

const CODES = Object.keys(LANGUAGES) as LanguageCode[];

export function ProjectDialog({
  project,
  onClose,
  onSaved,
  onDeleted,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: (p: Project) => void;
  onDeleted?: () => void;
}) {
  const { putProject, attempt, toast, settings, tasks } = useApp();
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(project?.name ?? '');
  const [customer, setCustomer] = useState(project?.customer ?? '');
  const [orig, setOrig] = useState<LanguageCode[]>(
    project?.originalLanguages ?? ['ja'],
  );
  const [work, setWork] = useState<LanguageCode>(
    project?.workingLanguage ?? settings.workingLanguage,
  );
  // Kept as typed, so the field can be cleared and retyped; checked on saving.
  const [days, setDays] = useState(
    String(project?.dueSoonDays ?? settings.dueSoonDays),
  );
  const [dateFormat, setDateFormat] = useState<DateFormat>(
    project?.dateFormat ?? 'YYYY/MM/DD',
  );
  const [showNumbers, setShowNumbers] = useState(project?.showNumbers ?? true);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const input = {
      name,
      customer,
      originalLanguages: orig,
      workingLanguage: work,
    };
    const p = await attempt(() =>
      project
        ? window.worksync.updateProject(project.id, {
            ...input,
            dueSoonDays: Number(days),
            dateFormat,
            showNumbers,
          })
        : window.worksync.createProject(input),
    );
    if (p) {
      putProject(p);
      toast(
        project
          ? tr('Project saved.')
          : tr('Created {name}.', { name: p.name }),
      );
      onSaved(p);
    }
  };
  if (project && deleting)
    return (
      <DeleteProject
        project={project}
        tasks={tasks.filter((t) => t.projectId === project.id).length}
        onCancel={() => setDeleting(false)}
        onDeleted={() => onDeleted?.()}
      />
    );
  return (
    <Modal
      title={project ? tr('Project settings') : tr('New project')}
      subtitle={tr(
        'Languages are set per project, so projects in different languages sit side by side.',
      )}
      onClose={onClose}
      narrow
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button
            className="btn primary"
            form="projectForm"
            type="submit"
            disabled={!name.trim() || !orig.length}
            title={
              !orig.length
                ? tr('Choose at least one original language.')
                : !name.trim()
                  ? tr('A project needs a name.')
                  : undefined
            }
          >
            <Icon name="check" />
            {project ? tr('Save') : tr('Create project')}
          </button>
        </>
      }
    >
      <form id="projectForm" className="form" onSubmit={save}>
        <label>
          {tr('Name')}
          <input
            className="inp"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={tr('Such as Logistics Portal Renewal')}
          />
        </label>
        <label>
          {tr('Customer')}
          <input
            className="inp"
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>
            {tr('Original languages, the ones the customer writes in')}
          </legend>
          <div className="checks">
            {CODES.map((c) => (
              <label key={c} className="check">
                <input
                  type="checkbox"
                  checked={orig.includes(c)}
                  onChange={(e) =>
                    setOrig(
                      e.target.checked
                        ? [...orig, c]
                        : orig.filter((x) => x !== c),
                    )
                  }
                />
                {LANGUAGES[c]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="two">
          <label>
            {tr('Your working language')}
            <select
              className="inp"
              value={work}
              onChange={(e) => setWork(e.target.value as LanguageCode)}
            >
              {CODES.map((c) => (
                <option key={c} value={c}>
                  {LANGUAGES[c]}
                </option>
              ))}
            </select>
          </label>
          {project && (
            <label>
              {tr('Due soon, in days')}
              <input
                className="inp"
                type="number"
                min={1}
                max={60}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </label>
          )}
        </div>
        {project && (
          <label>
            {tr('Dates in reports')}
            <select
              className="inp"
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value as DateFormat)}
            >
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {formatDate('2026-11-03', f)}
                </option>
              ))}
            </select>
          </label>
        )}
        {project && (
          <label className="check">
            <input
              type="checkbox"
              checked={showNumbers}
              onChange={(e) => setShowNumbers(e.target.checked)}
            />{' '}
            {tr('Show task numbers (No.) in the views')}
            <span className="hint-text" style={{ display: 'block' }}>
              {tr(
                'Each task keeps its number as its identity, and search still finds it. Reviews, copies and reports always show it.',
              )}
            </span>
          </label>
        )}
        {project && <ExportCopy project={project} />}
        {project && onDeleted && (
          <div className="danger-zone">
            <span>
              <b>{tr('Delete this project')}</b>
              <small>
                {tr(
                  'Removes its tasks, history, glossary and people from WorkSync. Files on your PC and the shared drive stay.',
                )}
              </small>
            </span>
            <button
              type="button"
              className="btn sm danger"
              onClick={() => setDeleting(true)}
            >
              <Icon name="trash" />
              {tr('Delete project…')}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

/**
 * Confirms deleting a project: the owner types its name. WorkSync backs up
 * the data first, so it can be restored from Settings.
 */
function DeleteProject({
  project,
  tasks,
  onCancel,
  onDeleted,
}: {
  project: Project;
  tasks: number;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { attempt, toast, reloadAll } = useApp();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = typed.trim() === project.name.trim();
  const del = async () => {
    setBusy(true);
    const r = await attempt(() => window.worksync.deleteProject(project.id));
    setBusy(false);
    if (!r) return;
    await reloadAll();
    toast(
      `Deleted ${project.name} and its ${r.tasks} task${r.tasks === 1 ? '' : 's'}. A backup was made first; restore it from Settings if you need it back.`,
    );
    onDeleted();
  };
  return (
    <Modal
      title={tr('Delete this project?')}
      subtitle={project.name}
      onClose={onCancel}
      narrow
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {tr('Cancel')}
          </button>
          <button
            className="btn danger"
            disabled={!ok || busy}
            onClick={() => void del()}
          >
            <Icon name="trash" />
            {busy ? tr('Deleting…') : tr('Delete project')}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void del();
        }}
      >
        <p>
          {tr('This deletes')}{' '}
          <b>
            {tasks} task{tasks === 1 ? '' : 's'}
          </b>{' '}
          {tr(
            'with their summaries, situations, history and notes, and the project’s glossary, people, linked files and Tasks table settings.',
          )}
        </p>
        <p className="muted">
          {tr(
            'The project’s notes stay, under “No project” in Notes. The customer’s files, your written copies, reports and the published page stay where they are. WorkSync backs up your data first, so you can restore it from Settings.',
          )}
        </p>
        <label>
          {tr('Type the project name to confirm')}
          <input
            className="inp"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={project.name}
            autoFocus
            aria-label={tr('Project name')}
          />
        </label>
      </form>
    </Modal>
  );
}

const blank = (): TaskInput => ({
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
});

/** Adding a task by hand, or editing any task's fields. */
export function TaskDialog({
  projectId,
  task,
  onClose,
  onSaved,
}: {
  projectId: string;
  task?: Task;
  onClose: () => void;
  onSaved: (t: Task) => void;
}) {
  const { project, putTask, attempt, toast } = useApp();
  const label = useTaskLabel();
  const p = project(projectId)!;
  const [v, setV] = useState<TaskInput>(() =>
    task ? { ...blank(), ...pickInput(task) } : blank(),
  );
  const [labels, setLabels] = useState((task?.labels ?? []).join(', '));
  const set =
    <K extends keyof TaskInput>(k: K) =>
    (e: { target: { value: string } }) =>
      setV({
        ...v,
        [k]:
          (k.endsWith('Start') || k.endsWith('End') || k.endsWith('Date')) &&
          !e.target.value
            ? null
            : e.target.value,
      });
  // The language is detected from the title unless the owner chooses it.
  const [langChoice, setLangChoice] = useState<LanguageCode | null>(
    task?.languageSet ? task.language : null,
  );
  const detected = v.titleOriginal.trim()
    ? detectLanguage(v.titleOriginal, p.originalLanguages)
    : null;
  const lang = langChoice ?? detected;
  const langOptions = [
    ...new Set([...p.originalLanguages, p.workingLanguage]),
  ] as LanguageCode[];
  const needsTranslation = lang !== null && lang !== p.workingLanguage;
  // The customer's own text is never edited in the app; it changes when the file does.
  const fromFile = task?.source === 'file';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const input = {
      ...v,
      ...(langChoice
        ? { language: langChoice, languageSet: true }
        : task?.languageSet
          ? { languageSet: false }
          : {}),
      labels: labels
        .split(/[,、]/)
        .map((l) => l.trim())
        .filter(Boolean),
    };
    const t = await attempt(() =>
      task
        ? window.worksync.updateTask(task.id, input)
        : window.worksync.createTask(projectId, input),
    );
    if (t) {
      putTask(t);
      toast(tr(task ? 'Saved {task}.' : 'Added {task}.', { task: label(t) }));
      onSaved(t);
    }
  };

  return (
    <Modal
      title={task ? tr('Edit {name}', { name: label(task) }) : tr('New task')}
      subtitle={
        task
          ? p.name
          : tr(
              '{name} · added by hand, so it is never written to a customer file',
              { name: p.name },
            )
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn primary" form="taskForm" type="submit">
            <Icon name="check" />
            {task ? tr('Save') : tr('Add task')}
          </button>
        </>
      }
    >
      <form id="taskForm" className="form" onSubmit={save}>
        <div className="two narrow-first">
          <label>
            {tr('No.')}
            <input
              className="inp mono"
              value={v.customerId}
              onChange={set('customerId')}
              readOnly={fromFile}
              title={
                fromFile
                  ? tr(
                      'From the customer’s file, which matches the task by it. It changes when the file does.',
                    )
                  : undefined
              }
              placeholder={tr('Next number')}
            />
          </label>
          <label>
            <span>
              {tr('Original title')}
              <select
                className="lang-pick"
                aria-label={tr('Language of the title and description')}
                title={tr(
                  'Detected from the characters. Choose it when the guess is wrong.',
                )}
                value={langChoice ?? ''}
                onChange={(e) =>
                  setLangChoice((e.target.value || null) as LanguageCode | null)
                }
              >
                <option value="">
                  {detected ? `${LANGUAGES[detected]}, detected` : tr('Detect')}
                </option>
                {langOptions.map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGES[l]}
                  </option>
                ))}
              </select>
            </span>
            <input
              className="inp"
              value={v.titleOriginal}
              onChange={set('titleOriginal')}
              title={
                fromFile
                  ? tr(
                      'From the customer’s file. You can change it here; if the file changes it too, the review asks which to keep.',
                    )
                  : undefined
              }
              required
              placeholder={tr('As written by the customer')}
            />
          </label>
        </div>
        {needsTranslation && (
          <label>
            {tr('Title in')} {LANGUAGES[p.workingLanguage]}
            <input
              className="inp"
              value={v.titleTranslation}
              onChange={set('titleTranslation')}
              placeholder={tr('Leave empty if not translated yet')}
            />
          </label>
        )}
        <label>
          {tr('Summary, in your own words')}
          <textarea
            className="inp"
            rows={2}
            value={v.summary}
            onChange={set('summary')}
            placeholder={tr('What is this task really about?')}
          />
        </label>
        <div className="three">
          <label>
            {tr('Status')}
            <select className="inp" value={v.status} onChange={set('status')}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {tr(s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr('Priority')}
            <select
              className="inp"
              value={v.priority}
              onChange={set('priority')}
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {tr(LEVEL_NAME[l])}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr('Labels')}
            <input
              className="inp"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder={tr('Auth, Release 2.1')}
            />
          </label>
        </div>
        <div className="four">
          <label>
            {tr('Planned start')}
            <input
              className="inp"
              type="date"
              value={v.plannedStart ?? ''}
              onChange={set('plannedStart')}
            />
          </label>
          <label>
            {tr('Planned end')}
            <input
              className="inp"
              type="date"
              value={v.plannedEnd ?? ''}
              onChange={set('plannedEnd')}
            />
          </label>
          <label>
            {tr('Actual start')}
            <input
              className="inp"
              type="date"
              value={v.actualStart ?? ''}
              onChange={set('actualStart')}
            />
          </label>
          <label>
            {tr('Actual end')}
            <input
              className="inp"
              type="date"
              value={v.actualEnd ?? ''}
              onChange={set('actualEnd')}
            />
          </label>
        </div>
        <div className="three">
          <label>
            {tr('Assignee')}
            <input
              className="inp"
              value={v.assignee}
              onChange={set('assignee')}
            />
          </label>
          <label>
            {tr('Category')}
            <input
              className="inp"
              value={v.category}
              onChange={set('category')}
              placeholder={tr('Bug, request, question')}
            />
          </label>
          <label>
            {tr('Remarks')}
            <input
              className="inp"
              value={v.remarks}
              onChange={set('remarks')}
            />
          </label>
        </div>
        <label>
          {tr('Original description')}
          <textarea
            className="inp"
            rows={4}
            value={v.descriptionOriginal}
            onChange={set('descriptionOriginal')}
            readOnly={fromFile}
            placeholder={tr(
              'Paste the customer’s text. Blank lines separate paragraphs.',
            )}
          />
        </label>
        {needsTranslation && (
          <label>
            {tr('Description in')} {LANGUAGES[p.workingLanguage]}
            <textarea
              className="inp"
              rows={4}
              value={v.descriptionTranslation}
              onChange={set('descriptionTranslation')}
              placeholder={tr(
                'Keep the same paragraphs, so they line up side by side.',
              )}
            />
          </label>
        )}
        <fieldset>
          <legend>{tr('Only for you')}</legend>
          <div className="two">
            <label>
              {tr('Next action')}
              <input
                className="inp"
                value={v.nextAction}
                onChange={set('nextAction')}
                placeholder={tr('Your own to-do for this task')}
              />
            </label>
            <label>
              {tr('By')}
              <input
                className="inp"
                type="date"
                value={v.nextActionDate ?? ''}
                onChange={set('nextActionDate')}
              />
            </label>
          </div>
          <label>
            {tr('Notes')}
            <textarea
              className="inp"
              rows={3}
              value={v.notes}
              onChange={set('notes')}
              placeholder={tr(
                'Background: technical context, decisions and links',
              )}
            />
          </label>
        </fieldset>
      </form>
    </Modal>
  );
}

function pickInput(t: Task): TaskInput {
  const b = blank();
  return Object.fromEntries(
    Object.keys(b).map((k) => [k, t[k as keyof Task]]),
  ) as unknown as TaskInput;
}

const VIEW_INFO: Record<
  ViewKey,
  { name: string; icon: IconName; desc: string }
> = {
  focus: {
    name: 'Focus',
    icon: 'focus',
    desc: 'Tasks that need attention now. Always on.',
  },
  board: {
    name: 'Board',
    icon: 'board',
    desc: 'Columns by status. Drag to change a status.',
  },
  tasks: { name: 'Tasks', icon: 'menu', desc: 'A table of every task.' },
  timeline: {
    name: 'Timeline',
    icon: 'timeline',
    desc: 'Planned and actual dates as a Gantt chart.',
  },
  calendar: {
    name: 'Calendar',
    icon: 'calendar',
    desc: 'Tasks on their due dates.',
  },
  dashboard: {
    name: 'Dashboard',
    icon: 'gauge',
    desc: 'Counts, priorities and what waits on the customer.',
  },
  published: {
    name: 'Published page',
    icon: 'globe',
    desc: 'The read-only page your manager opens.',
  },
  files: {
    name: 'Files',
    icon: 'file',
    desc: 'Linked Excel files and their state.',
  },
};
export const viewName = (k: ViewKey) => tr(VIEW_INFO[k].name);
export const viewIcon = (k: ViewKey) => VIEW_INFO[k].icon;

export function ViewsDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { putProject, attempt, toast } = useApp();
  const toggle = async (k: ViewKey) => {
    const on = !project.views[k];
    const p = await attempt(() =>
      window.worksync.updateProject(project.id, { views: { [k]: on } }),
    );
    if (p) {
      putProject(p);
      toast(
        on
          ? `${viewName(k)} is shown again, with all its data.`
          : `${viewName(k)} hidden for this project. Its data is kept.`,
      );
    }
  };
  return (
    <Modal
      title={tr('Choose views')}
      subtitle={`Pick the views ${project.name} needs. Each project keeps its own choice.`}
      onClose={onClose}
      narrow
      footer={
        <button className="btn primary" onClick={onClose}>
          {tr('Done')}
        </button>
      }
    >
      <div>
        {(Object.keys(VIEW_INFO) as ViewKey[]).map((k) => {
          const built = BUILT_VIEWS.includes(k);
          const on = project.views[k];
          return (
            <div
              key={k}
              className={`vrow ${on ? 'on' : ''} ${built ? '' : 'later'}`}
            >
              <span className="vic">
                <Icon name={VIEW_INFO[k].icon} />
              </span>
              <span>
                <b>{tr(VIEW_INFO[k].name)}</b>
                <small>
                  {built
                    ? tr(VIEW_INFO[k].desc)
                    : `${tr(VIEW_INFO[k].desc)} Comes in a later build.`}
                </small>
              </span>
              <button
                className="switch"
                role="switch"
                aria-checked={on}
                aria-label={tr('Show {view}', { view: tr(VIEW_INFO[k].name) })}
                disabled={k === 'focus'}
                onClick={() => void toggle(k)}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>
      <div className="keepnote">
        <Icon name="shield" />
        <span>
          {tr(
            'Turning a view off only hides it from this project. Tasks, dates, situations and history stay exactly as they are.',
          )}
        </span>
      </div>
    </Modal>
  );
}

export function ConfirmDelete({
  task,
  onClose,
  onDeleted,
}: {
  task: Task;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { removeTask, attempt, toast } = useApp();
  const label = useTaskLabel();
  const del = async () => {
    const ok = await attempt(async () => {
      await window.worksync.deleteTask(task.id);
      return true;
    });
    if (ok) {
      removeTask(task.id);
      toast(`Deleted ${label(task)}.`);
      onDeleted();
    }
  };
  return (
    <Modal
      title={tr('Delete {task}?', { task: label(task) })}
      subtitle={tr(
        'The task, its situation updates and its history are deleted. This cannot be undone.',
      )}
      onClose={onClose}
      narrow
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {tr('Keep it')}
          </button>
          <button className="btn danger" onClick={() => void del()}>
            <Icon name="trash" />
            {tr('Delete task')}
          </button>
        </>
      }
    >
      <div className="field">
        <div className="v">{task.titleTranslation || task.titleOriginal}</div>
      </div>
      {task.source === 'file' && task.fileState === 'in_file' && (
        <p className="muted step-help">
          {tr(
            'The row stays in the customer’s file. WorkSync remembers that you deleted it, so the next review lists it unticked and it stays deleted unless you tick it.',
          )}
        </p>
      )}
    </Modal>
  );
}

/**
 * Saves a copy of the project for another WorkSync user. They import it as
 * their own project and can change it freely; later, either copy can be
 * merged back into the other.
 */
function ExportCopy({ project }: { project: Project }) {
  const { attempt, toast } = useApp();
  const [notes, setNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  // How many notes belong to the project, to say what goes along.
  const [noteCount, setNoteCount] = useState<number | null>(null);
  useEffect(() => {
    void window.worksync.listNotes().then(
      (all) =>
        setNoteCount(all.filter((n) => n.projectId === project.id).length),
      () => setNoteCount(null),
    );
  }, [project.id]);
  const save = async () => {
    setBusy(true);
    const r = await attempt(() =>
      window.worksync.exportProject(project.id, notes),
    );
    setBusy(false);
    if (r)
      toast(
        `Saved ${r.file.split(/[\\/]/).pop()}. Give it to the other person; they use Import a project.`,
      );
  };
  return (
    <div className="danger-zone export-zone">
      <span>
        <b>{tr('Give a copy to someone')}</b>
        <small>
          {tr(
            'A .worksync file with the tasks, situations, history, glossary, people and Board. To bring their changes back, they export their copy and you import it to merge.',
          )}
        </small>
        <label className="check" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            checked={notes}
            onChange={(e) => setNotes(e.target.checked)}
          />{' '}
          {tr('Include my notes, next actions and the project’s notes')}
        </label>
        {noteCount !== null && (
          <small className="export-notes">
            {noteCount === 0
              ? tr('This project has no notes yet.')
              : notes
                ? tr(
                    noteCount === 1
                      ? '1 project note goes along, with its images.'
                      : '{n} project notes go along, with their images.',
                    { n: noteCount },
                  )
                : tr(
                    noteCount === 1
                      ? 'The project’s 1 note stays here.'
                      : 'The project’s {n} notes stay here.',
                    { n: noteCount },
                  )}
          </small>
        )}
      </span>
      <button
        type="button"
        className="btn sm"
        disabled={busy}
        onClick={() => void save()}
      >
        <Icon name="save" />
        {busy ? tr('Saving…') : tr('Export a copy…')}
      </button>
    </div>
  );
}
