import { useEffect, useState } from 'react';
import type { Project, PublishStatus } from '../shared/model';
import { useApp } from './appState';
import { Icon } from './Icon';
import { Modal } from './parts';
import type { ViewProps } from './views';
import { tr } from './i18n';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Reads a project's publish status, and again whenever its tasks change. */
export function usePublishStatus(
  projectId: string | null,
): [PublishStatus | null, () => Promise<void>] {
  const { tasks } = useApp();
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const load = async () => {
    if (!projectId) return setStatus(null);
    setStatus(await window.worksync.publishStatus(projectId));
  };
  useEffect(() => {
    void load();
    // Reload when the project or its tasks change.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tasks]);
  return [status, load];
}

function StatusLines({ status }: { status: PublishStatus }) {
  return (
    <div className="fields">
      <div className="field">
        <div className="k">
          <Icon name="folder" />
          {tr('Publish folder')}
        </div>
        <div className="v path">{status.folder ?? tr('Not chosen yet')}</div>
      </div>
      <div className="field">
        <div className="k">
          <Icon name="upload" />
          {tr('Last published')}
        </div>
        <div className="v">
          {status.lastAt ? when(status.lastAt) : tr('Never')}
          {status.lastAt && (
            <span className="muted">
              {' '}
              ·{' '}
              {status.unpublished
                ? `${status.unpublished} task${status.unpublished === 1 ? '' : 's'} changed since`
                : tr('nothing changed since')}
            </span>
          )}
        </div>
      </div>
      {status.tampered.length > 0 && (
        <div className="keepnote warn">
          <Icon name="alert" />
          <span>
            {tr('Someone changed or deleted the published')}{' '}
            {status.tampered.join(' and ')}{' '}
            {tr(
              'after the last publish. Viewers may be seeing the changed copy. Publishing again replaces it. Your own data is not affected.',
            )}
          </span>
        </div>
      )}
      {status.folderProblem && (
        <div className="keepnote warn">
          <Icon name="alert" />
          <span>{status.folderProblem}</span>
        </div>
      )}
    </div>
  );
}

/** Publish (spec 03): choose the folder once, preview, then write the page and the Excel export. */
export function PublishDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { attempt, toast, putProject } = useApp();
  const [status, reload] = usePublishStatus(project.id);
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    const p = await attempt(() =>
      window.worksync.choosePublishFolder(project.id),
    );
    if (p) {
      putProject(p);
      await reload();
    }
  };
  const notes = async (v: boolean) => {
    const p = await attempt(() =>
      window.worksync.setPublishNotes(project.id, v),
    );
    if (p) putProject(p);
  };
  const publish = async () => {
    setBusy(true);
    const s = await attempt(() => window.worksync.publish(project.id));
    setBusy(false);
    if (!s) return;
    await reload();
    toast(
      tr('Published to the shared folder: the page and the Excel export.'),
      {
        label: 'Open the page',
        run: () =>
          void attempt(() => window.worksync.openPublished(project.id)),
      },
    );
    onClose();
  };
  return (
    <Modal
      title={tr('Publish')}
      subtitle={`${project.name} · a read-only copy your manager opens from the shared folder`}
      onClose={onClose}
      narrow
      footer={
        <>
          <button
            className="btn"
            onClick={() =>
              void attempt(() => window.worksync.previewPublish(project.id))
            }
          >
            <Icon name="globe" />
            {tr('Preview')}
          </button>
          {status && !status.folder && (
            <span className="muted foot-why">
              {tr('Choose the folder first')}
            </span>
          )}
          <button
            className="btn primary"
            disabled={busy || !status?.folder || !!status.folderProblem}
            title={
              status && !status.folder
                ? tr('Choose the folder first')
                : undefined
            }
            onClick={() => void publish()}
          >
            <Icon name="upload" />
            {tr('Publish')}
          </button>
        </>
      }
    >
      {status && <StatusLines status={status} />}
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <button className="btn sm" onClick={() => void choose()}>
          <Icon name="folder" />
          {status?.folder ? tr('Change the folder') : tr('Choose the folder')}
        </button>
        <label className="check pub-notes">
          <input
            type="checkbox"
            checked={project.publishNotes}
            onChange={(e) => void notes(e.target.checked)}
          />{' '}
          {tr('Include my notes')}
        </label>
        <label className="check pub-notes">
          <input
            type="checkbox"
            checked={project.publishOnClose}
            onChange={async (e) => {
              const p = await attempt(() =>
                window.worksync.setPublishOnClose(project.id, e.target.checked),
              );
              if (p) putProject(p);
            }}
          />{' '}
          {tr('Publish when WorkSync closes')}
        </label>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {tr(
          'WorkSync writes index.html, tasks.xlsx and a fingerprint file to the folder. Your next actions are never included, and notes only if you tick the box. Anyone who can open the shared folder can read these files, so publish only what the customer’s confidentiality rules allow inside the company.',
        )}
      </p>
    </Modal>
  );
}

/** The Published page view: what the manager sees, and when it was last published. */
export function PublishedView({
  projectId,
  props,
  onPublish,
}: {
  projectId: string;
  props: ViewProps;
  onPublish: () => void;
}) {
  const { project, attempt } = useApp();
  const p = project(projectId)!;
  const [status] = usePublishStatus(projectId);
  return (
    <>
      {props.header(
        tr('Published page'),
        tr(
          '{name} · what your manager sees in the shared folder, read-only and opening in any browser',
          { name: p.name },
        ),
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            onClick={() =>
              void attempt(() => window.worksync.previewPublish(projectId))
            }
          >
            <Icon name="globe" />
            <span className="lbl">{tr('Preview')}</span>
          </button>
          <button className="btn primary" onClick={onPublish}>
            <Icon name="upload" />
            <span className="lbl">{tr('Publish')}</span>
          </button>
        </div>,
      )}
      <div className="panel" style={{ maxWidth: 760 }}>
        {status ? (
          <StatusLines status={status} />
        ) : (
          <p className="muted">{tr('Reading…')}</p>
        )}
        {status?.lastAt && (
          <button
            className="btn sm"
            style={{ marginTop: 12 }}
            onClick={() =>
              void attempt(() => window.worksync.openPublished(projectId))
            }
          >
            {tr('Open the published page')}
          </button>
        )}
      </div>
      <div className="legend">
        <span>
          <Icon name="shield" />
          {tr(
            'The page shows each task’s brief, with search by number, label or title, and the dashboard. It leaves out your next actions and, unless you choose, your notes.',
          )}
        </span>
      </div>
    </>
  );
}
