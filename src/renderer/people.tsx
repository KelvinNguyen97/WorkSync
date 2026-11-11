import { useMemo, useState } from 'react';
import {
  LANGUAGES,
  personFor,
  type Person,
  type Project,
} from '../shared/model';
import { useApp } from './appState';
import { Icon } from './Icon';
import { confirmDelete, Modal } from './parts';
import { tr } from './i18n';

type Draft = Omit<Person, 'id' | 'projectId'> & { id?: string };
const EMPTY: Draft = {
  name: '',
  displayName: '',
  side: 'customer',
  spellings: [],
};

/**
 * The project's people list (spec 02): names as written in the files, the
 * display name in the working language, the side, and other spellings that
 * are the same person.
 */
export function PeopleDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { people: all, tasks, reloadPeople, attempt, toast } = useApp();
  const people = all.filter((p) => p.projectId === project.id);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [spellings, setSpellings] = useState('');
  const editing = !!draft.id;

  // Names in the project's tasks that no one in the list stands for yet.
  const unknown = useMemo(() => {
    const names = new Map<string, number>();
    for (const t of tasks)
      if (t.projectId === project.id && t.fileState !== 'removed')
        for (const n of t.assignee.split(/\s*[,、，/／]\s*/)) {
          const name = n.trim();
          if (name && !personFor(all, project.id, name))
            names.set(name, (names.get(name) ?? 0) + 1);
        }
    return [...names.entries()].sort((a, b) => b[1] - a[1]);
  }, [tasks, all, project.id]);

  const save = async () => {
    const p = await attempt(() =>
      window.worksync.savePerson({
        ...draft,
        projectId: project.id,
        spellings: spellings.split(/[,、，\n]/),
      }),
    );
    if (!p) return;
    await reloadPeople();
    toast(
      editing
        ? `Saved ${p.displayName || p.name}.`
        : `Added ${p.displayName || p.name}.`,
    );
    setDraft(EMPTY);
    setSpellings('');
  };
  const edit = (p: Person) => {
    setDraft(p);
    setSpellings(p.spellings.join(', '));
  };
  const remove = async (p: Person) => {
    if (
      !(await confirmDelete({
        title: tr('Delete {name} from the people list?', {
          name: p.displayName || p.name,
        }),
        text: tr(
          'Tasks are not changed: names in them stay as they are written.',
        ),
        yes: tr('Delete'),
      }))
    )
      return;
    await attempt(() => window.worksync.deletePerson(p.id));
    await reloadPeople();
    if (draft.id === p.id) {
      setDraft(EMPTY);
      setSpellings('');
    }
  };
  const working = LANGUAGES[project.workingLanguage];

  return (
    <Modal
      title={tr('People')}
      subtitle={`${project.name} · names in the files, shown in ${working}`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          {tr('Done')}
        </button>
      }
    >
      <form
        className="people-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          {tr('As written in the files')}
          <input
            className="inp"
            placeholder={tr('Such as 田中')}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          {tr('Shown as')}
          <input
            className="inp"
            placeholder={tr('In {lang}, such as Tanaka', { lang: tr(working) })}
            value={draft.displayName}
            onChange={(e) =>
              setDraft({ ...draft, displayName: e.target.value })
            }
          />
        </label>
        <label>
          {tr('Side')}
          <select
            className="inp"
            value={draft.side}
            onChange={(e) =>
              setDraft({ ...draft, side: e.target.value as Person['side'] })
            }
          >
            <option value="customer">{tr('Customer')}</option>
            <option value="ours">{tr('Our company')}</option>
          </select>
        </label>
        <label className="wide">
          {tr('Other spellings')}
          <input
            className="inp"
            placeholder={tr(
              'Such as 田中太郎, Tanaka-san, separated by commas',
            )}
            value={spellings}
            onChange={(e) => setSpellings(e.target.value)}
          />
        </label>
        <span className="people-actions">
          {editing && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(EMPTY);
                setSpellings('');
              }}
            >
              {tr('Cancel')}
            </button>
          )}
          <button className="btn" type="submit" disabled={!draft.name.trim()}>
            <Icon name={editing ? 'check' : 'plus'} />
            {editing ? tr('Save') : tr('Add')}
          </button>
        </span>
      </form>

      {unknown.length > 0 && (
        <div className="people-unknown">
          <span className="muted">
            {tr('In the tasks, not in the list yet:')}
          </span>
          {unknown.slice(0, 12).map(([name, n]) => (
            <button
              key={name}
              className="chip-btn"
              title={tr(n === 1 ? '1 task' : '{n} tasks', { n })}
              onClick={() => {
                setDraft({ ...EMPTY, name });
                setSpellings('');
              }}
            >
              <Icon name="plus" />
              {name}
            </button>
          ))}
        </div>
      )}

      {people.length > 0 ? (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>{tr('In the files')}</th>
                <th>{tr('Shown as')}</th>
                <th>{tr('Side')}</th>
                <th>{tr('Other spellings')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className={draft.id === p.id ? 'sel' : ''}>
                  <td>{p.name}</td>
                  <td>{p.displayName || <span className="muted">—</span>}</td>
                  <td>
                    {p.side === 'ours' ? tr('Our company') : tr('Customer')}
                  </td>
                  <td>{p.spellings.join(', ')}</td>
                  <td className="row-actions">
                    <button
                      className="icon-btn"
                      aria-label={tr('Edit {name}', { name: p.name })}
                      onClick={() => edit(p)}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={tr('Delete {name}', { name: p.name })}
                      onClick={() => void remove(p)}
                    >
                      <Icon name="trash" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">
          {tr(
            'No people yet. Add the names the files use, so assignees show in',
          )}{' '}
          {working} {tr('and different spellings count as one person.')}
        </p>
      )}
    </Modal>
  );
}
