/**
 * The requests the AI gets (doc 10). Copy for AI and the one-click jobs build
 * the same requests; a job also says what to fill in from each answer: what
 * the review screens tick by default.
 */
import { buildBatches, readAnswer } from '../shared/aiBatch';
import type { AiJob } from '../shared/ai';
import { buildSummaryBatches, readSummaryAnswer } from '../shared/discussions';
import type { LanguageCode } from '../shared/model';
import {
  buildOwnerBatches,
  readOwnerAnswer,
  untranslated,
  type OwnerTranslation,
} from '../shared/ownerBatch';
import type { Member } from '../shared/work';
import type { Plan } from './aiService';
import type { Discussions } from './discussions';
import type { Store } from './store';

export interface PlanDeps {
  store: Store;
  discussions: Discussions;
  members: (projectId: string) => Member[];
  /** The main language of a linked customer file. */
  fileLanguage: (sourceFileId: string) => LanguageCode | null;
}

/** The Copy for AI requests for tickets: translation and summary. */
export function aiBatchesFor(
  d: PlanDeps,
  projectId: string,
  taskIds: string[],
  maxChars?: number,
) {
  const st = d.store;
  const project = st.getProject(projectId);
  const tasks = taskIds
    .map((id) => st.getTask(id))
    .filter((t) => t.projectId === projectId);
  return buildBatches(
    tasks.map((t) => ({
      taskId: t.id,
      customerId: t.customerId,
      language: t.language,
      title: t.titleOriginal,
      description: t.descriptionOriginal,
      summary: t.summary,
    })),
    project.workingLanguage,
    st.listGlossary(projectId),
    maxChars,
  );
}

/** Requests to translate the owner's own text into the project's file language. */
export function ownerBatchesFor(
  d: PlanDeps,
  projectId: string,
  taskIds: string[],
  maxChars?: number,
) {
  const st = d.store;
  const project = st.getProject(projectId);
  const to = project.originalLanguages[0] ?? 'ja';
  const done = st.listOwnerTranslations(projectId);
  const items = taskIds
    .map((id) => st.getTask(id))
    .filter((t) => t.projectId === projectId)
    .map((task) => ({ task, parts: untranslated(task, done, to) }));
  return buildOwnerBatches(
    items,
    project.workingLanguage,
    to,
    st.listGlossary(projectId),
    maxChars,
  );
}

/** Requests to translate remarks into their file's language, before writing a copy. */
export function remarksBatchesFor(
  d: PlanDeps,
  taskIds: string[],
  maxChars?: number,
) {
  const st = d.store;
  const tasks = taskIds
    .map((id) => st.getTask(id))
    .filter((t) => t.remarks.trim());
  if (!tasks.length) return [];
  const project = st.getProject(tasks[0].projectId);
  // Remarks go into the file, so they are translated into the file's main language.
  const src = tasks[0].sourceFileId
    ? d.fileLanguage(tasks[0].sourceFileId)
    : null;
  const to = src ?? project.originalLanguages[0] ?? 'ja';
  return buildOwnerBatches(
    tasks
      .filter((t) => t.projectId === project.id)
      .map((task) => ({
        task,
        parts: [{ field: 'remarks', label: 'REMARKS', source: task.remarks }],
      })),
    project.workingLanguage,
    to,
    st.listGlossary(project.id),
    maxChars,
  );
}

/** Puts translated remarks in place, where the remarks are still the text translated. */
export function applyRemarksList(
  d: PlanDeps,
  list: OwnerTranslation[],
): number {
  const st = d.store;
  let n = 0;
  for (const x of list) {
    if (x.field !== 'remarks') continue;
    const t = st.getTask(x.taskId);
    if (t.remarks !== x.source || !x.text.trim()) continue;
    st.updateTask(t.id, { remarks: x.text.trim() });
    n++;
  }
  return n;
}

/** How a discussion is named in a Summarize request. */
const discussionKey = (d: { no: string; id: string }) =>
  d.no || `D-${d.id.slice(0, 6)}`;

/** The Summarize requests for these discussions. */
export function summaryBatchesFor(
  deps: PlanDeps,
  ids: string[],
  limit?: number,
) {
  const d = deps.discussions;
  const first = ids[0] ? d.get(ids[0]) : null;
  const project = first ? deps.store.getProject(first.projectId) : null;
  const members = first ? deps.members(first.projectId) : [];
  const items = d.summaryItems(
    ids,
    (id) => members.find((m) => m.id === id)?.name ?? 'Someone',
  );
  return buildSummaryBatches(items, project?.workingLanguage ?? 'en', limit);
}

/**
 * A one-click job as requests and what to do with each answer (doc 10). The
 * requests are the ones Copy for AI makes; what is filled in is what the
 * review screens tick by default.
 */
export function aiPlan(
  deps: PlanDeps,
  job: AiJob,
  maxChars: number,
  from: string,
): Plan {
  const st = deps.store;
  const uniq = (xs: string[]) => [...new Set(xs)];
  if (job.kind === 'translate') {
    const batches = aiBatchesFor(deps, job.projectId, job.taskIds, maxChars);
    return {
      steps: batches.map((b) => ({
        text: b.text,
        apply: (answer) => {
          const r = readAnswer(b, answer);
          const results = r.items
            .filter((i) => i.title)
            .map((i) => ({
              taskId: i.taskId,
              title: i.title,
              description: i.description,
              // Your own summary stays; an empty one is filled in.
              summary: st.getTask(i.taskId).summary ? undefined : i.summary,
            }));
          if (results.length) st.applyAiResults(results, from);
          return {
            applied: results.length,
            missing: r.missing.length + r.incomplete.length,
            readable: r.items.length > 0,
          };
        },
      })),
      taskIds: uniq(batches.flatMap((b) => Object.values(b.keys))),
      discussionIds: [],
      items: batches.reduce((n, b) => n + Object.keys(b.keys).length, 0),
    };
  }
  if (job.kind === 'notes' || job.kind === 'remarks') {
    const batches =
      job.kind === 'notes'
        ? ownerBatchesFor(deps, job.projectId, job.taskIds, maxChars)
        : remarksBatchesFor(deps, job.taskIds, maxChars);
    return {
      steps: batches.map((b) => ({
        text: b.text,
        apply: (answer) => {
          const r = readOwnerAnswer(b, answer);
          const n =
            job.kind === 'notes'
              ? (st.saveOwnerTranslations(r.translations),
                new Set(r.translations.map((t) => t.taskId)).size)
              : applyRemarksList(deps, r.translations);
          return {
            applied: n,
            missing: r.missing.length,
            readable: r.translations.length > 0,
          };
        },
      })),
      taskIds: uniq(
        batches.flatMap((b) => Object.values(b.keys).map((k) => k.taskId)),
      ),
      discussionIds: [],
      items: batches.reduce((n, b) => n + Object.keys(b.keys).length, 0),
    };
  }
  const d = deps.discussions;
  const list = job.discussionIds
    .map((id) => d.get(id))
    .filter((x) => x.linkedTaskId);
  const byKey = new Map(list.map((x) => [discussionKey(x), x]));
  const batches = summaryBatchesFor(
    deps,
    list.map((x) => x.id),
    maxChars,
  );
  return {
    steps: batches.map((b) => ({
      text: b.text,
      apply: (answer) => {
        const r = readSummaryAnswer(answer, b.keys);
        let n = 0;
        for (const a of r.answers) {
          const x = byKey.get(a.key);
          if (!x) continue;
          // The parts Summarize ticks by default; the status is never changed.
          d.applySummary(x.id, {
            ...(a.doingNow ? { doingNow: a.doingNow } : {}),
            ...(a.situation ? { situation: a.situation } : {}),
            ...(a.nextStep || a.nextDate
              ? {
                  ...(a.nextStep ? { nextStep: a.nextStep } : {}),
                  ...(a.nextDate !== undefined
                    ? { nextDate: a.nextDate }
                    : { nextDate: null }),
                }
              : {}),
            difficulties: a.difficulties,
            resolved: a.resolved,
            status: null,
          });
          n++;
        }
        return {
          applied: n,
          missing: r.missing.length,
          readable: r.answers.length > 0,
        };
      },
    })),
    taskIds: uniq(list.map((x) => x.linkedTaskId!)),
    discussionIds: list.map((x) => x.id),
    items: list.length,
  };
}
