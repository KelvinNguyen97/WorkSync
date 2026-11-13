import { useEffect, useState } from 'react';
import type { WritePlan, WriteResult } from '../shared/writes';
import { useApp } from './appState';
import { Icon } from './Icon';
import { Modal } from './parts';
import { OwnerTranslate } from './reports';
import { tr } from './i18n';

const dirOf = (file: string) => file.replace(/[\\/][^\\/]*$/, '');
const nameOf = (file: string) => file.split(/[\\/]/).pop() ?? file;

/**
 * Write to copy (spec 03): every change not yet written, grouped by source
 * file, with each cell that will change. The customer's file is never touched.
 */
export function WriteDialog({ onClose }: { onClose: () => void }) {
  const { attempt, toast, reloadTasks, tasks, project } = useApp();
  // The source whose remarks are being translated before writing.
  const [translating, setTranslating] = useState<string | null>(null);
  const [plans, setPlans] = useState<WritePlan[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [folder, setFolder] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, WriteResult>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const p = await attempt(() => window.worksync.writePlans());
    if (!p) return onClose();
    setPlans(p);
    setChosen(
      new Set(
        p.flatMap((x) =>
          x.changes
            .filter((c) => !c.problem)
            .map((c) => `${c.taskId}:${c.field}`),
        ),
      ),
    );
    setFolder((f) => f ?? (p[0] ? dirOf(p[0].suggestedFile) : null));
  };
  useEffect(() => {
    void load();
    // Load once when the dialog opens.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (k: string) => {
    const n = new Set(chosen);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setChosen(n);
  };

  const change = async () => {
    const f = await attempt(() =>
      window.worksync.chooseCopyFolder(folder ?? ''),
    );
    if (f) setFolder(f);
  };

  const save = async (plan: WritePlan) => {
    if (!folder) return;
    setBusy(plan.sourceId);
    const keys = plan.changes
      .map((c) => `${c.taskId}:${c.field}`)
      .filter((k) => chosen.has(k));
    const r = await attempt(() =>
      window.worksync.writeCopy(plan.sourceId, keys, folder),
    );
    setBusy(null);
    if (!r) return;
    setResults({ ...results, [plan.sourceId]: r });
    await reloadTasks();
    toast(
      `Saved ${nameOf(r.file)}. ${r.written} cell${r.written === 1 ? '' : 's'} changed, every other cell checked.`,
    );
  };

  const open = Object.keys(results).length > 0;
  return (
    <Modal
      title={tr('Write to copy')}
      subtitle={tr(
        'Only these cells change. The customer’s file in Box is never touched.',
      )}
      onClose={onClose}
      footer={
        <button className={`btn ${open ? 'primary' : ''}`} onClick={onClose}>
          {open ? tr('Done') : tr('Close')}
        </button>
      }
    >
      {!plans && <p className="muted">{tr('Checking the linked files…')}</p>}
      {plans && plans.length === 0 && !open && (
        <p className="muted">
          {tr(
            'No changes waiting. Changes you make in WorkSync to a task from a file, such as its status, dates, priority, assignee or remarks, are listed here until you write them to a copy.',
          )}
        </p>
      )}
      {plans && plans.length > 0 && (
        <div className="field">
          <div className="k">
            <Icon name="folder" />
            {tr('Save copies in')}
          </div>
          <div
            className="v"
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span className="path" style={{ flex: 1, minWidth: 0 }}>
              {folder}
            </span>
            <button className="btn sm" onClick={() => void change()}>
              {tr('Change')}
            </button>
          </div>
        </div>
      )}
      {plans?.map((plan) => {
        const r = results[plan.sourceId];
        const picked = plan.changes.filter((c) =>
          chosen.has(`${c.taskId}:${c.field}`),
        ).length;
        return (
          <section key={plan.sourceId} className="panel write-plan">
            <div className="panel-h">
              <h2>
                <Icon name="file" /> {plan.fileName}
              </h2>
              <span className="hint">sheet {plan.sheet}</span>
            </div>
            {r ? (
              <div className="write-done">
                <p>
                  <Icon name="check" /> {tr('Saved')} <b>{nameOf(r.file)}</b>:{' '}
                  {r.written} cell{r.written === 1 ? '' : 's'}{' '}
                  {tr('changed, and all')} {r.checkedCells.toLocaleString()}{' '}
                  {tr('cells checked against the file it was made from.')}
                </p>
                {r.skipped.length > 0 && (
                  <div className="keepnote warn">
                    <Icon name="alert" />
                    <span>
                      {tr('Left alone, so update them in Excel:')}{' '}
                      {r.skipped
                        .map(
                          (s) =>
                            `${s.cell}${s.customerId ? ` (No. ${s.customerId})` : ''}: ${s.reason}`,
                        )
                        .join(' · ')}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn sm"
                    onClick={() =>
                      void attempt(() =>
                        window.worksync.openCopy(r.file, false),
                      )
                    }
                  >
                    {tr('Open the copy')}
                  </button>
                  <button
                    className="btn sm"
                    onClick={() =>
                      void attempt(() => window.worksync.openCopy(r.file, true))
                    }
                  >
                    {tr('Show in folder')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {plan.blocked && (
                  <div className="keepnote warn">
                    <Icon name="alert" />
                    <span>{plan.blocked}</span>
                  </div>
                )}
                {(() => {
                  const ids = plan.changes
                    .filter((c) => c.languageWarning)
                    .map((c) => c.taskId);
                  const p = project(
                    tasks.find((t) => t.id === ids[0])?.projectId ?? '',
                  );
                  if (!ids.length || !p) return null;
                  return translating === plan.sourceId ? (
                    <OwnerTranslate
                      project={p}
                      taskIds={ids}
                      what="the remarks"
                      prepare={() => window.worksync.prepareRemarksBatches(ids)}
                      saveAll={(list) => window.worksync.applyRemarks(list)}
                      onDone={async () => {
                        setTranslating(null);
                        await reloadTasks();
                        await load();
                      }}
                    />
                  ) : (
                    <p className="report-note">
                      <Icon name="globe" />
                      <span>
                        {ids.length} remark
                        {ids.length === 1 ? tr(' is') : tr('s are')}{' '}
                        {tr(
                          'not in the file’s language. The customer reads them, so translate them first.',
                        )}
                      </span>
                      <button
                        className="btn sm accent-outline"
                        onClick={() => setTranslating(plan.sourceId)}
                      >
                        <Icon name="spark" />
                        {tr('Translate with Gemini')}
                      </button>
                    </p>
                  );
                })()}
                <div className="review-list">
                  {plan.changes.map((c) => {
                    const k = `${c.taskId}:${c.field}`;
                    return (
                      <label key={k} className="diff-row">
                        <input
                          type="checkbox"
                          checked={chosen.has(k)}
                          disabled={!!c.problem || !!plan.blocked}
                          onChange={() => toggle(k)}
                        />
                        <div style={{ minWidth: 0 }}>
                          <span className="tid">
                            {tr('No.')} {c.customerId} {tr('· cell')} {c.cell}
                          </span>
                          <div className="title" style={{ fontSize: 14 }}>
                            {c.title}
                          </div>
                          <div className="chg">
                            {c.label}:{' '}
                            <span className="old">
                              {c.from || tr('(empty)')}
                            </span>
                            <span className="arrow">→</span>
                            <span className="new">{c.to || tr('(empty)')}</span>
                          </div>
                          {c.problem && (
                            <div className="chg warn-text">{c.problem}</div>
                          )}
                          {c.languageWarning && (
                            <div className="chg warn-text">
                              {c.languageWarning}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    className="btn primary"
                    disabled={
                      !picked || !!plan.blocked || busy !== null || !folder
                    }
                    onClick={() => void save(plan)}
                  >
                    <Icon name="save" />
                    {busy === plan.sourceId
                      ? tr('Saving…')
                      : `Save a copy with ${picked} change${picked === 1 ? '' : 's'}`}
                  </button>
                </div>
              </>
            )}
          </section>
        );
      })}
    </Modal>
  );
}

/** How many changes wait to be written, refreshed when tasks change. */
export function usePendingCount(): number {
  const { tasks, sources } = useApp();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!sources.length) return setN(0);
    void window.worksync.pendingCount().then(setN, () => setN(0));
  }, [tasks, sources]);
  return n;
}
