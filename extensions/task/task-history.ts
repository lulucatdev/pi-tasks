interface TaskRunIdentity {
  id: string;
  batchId?: string;
  startedAt: number;
  tasks: Array<{ id: string }>;
}

interface RunnableTaskSpec {
  name?: string;
  task: string;
  cwd?: string;
}

interface RunnableTaskRun {
  params?: {
    tasks: RunnableTaskSpec[];
  };
  tasks: Array<{ id: string }>;
}

export function taskRunsAreEquivalent(
  left: Pick<TaskRunIdentity, "batchId" | "startedAt" | "tasks">,
  right: Pick<TaskRunIdentity, "batchId" | "startedAt" | "tasks">,
): boolean {
  if (left.batchId && right.batchId) {
    return left.batchId === right.batchId;
  }
  if (left.startedAt !== right.startedAt) return false;
  if (left.tasks.length !== right.tasks.length) return false;
  return left.tasks.every((task, index) => task.id === right.tasks[index]?.id);
}

function hasRunnableParams(run: RunnableTaskRun): boolean {
  return Array.isArray(run.params?.tasks) && run.params.tasks.length > 0;
}

function deriveRunnableParams(run: RunnableTaskRun): RunnableTaskRun["params"] | undefined {
  const tasks = run.tasks.map((task) => {
    if (typeof task !== "object" || task === null) return null;
    if (!("task" in task) || typeof task.task !== "string" || task.task.trim().length === 0) return null;

    const spec: RunnableTaskSpec = { task: task.task };
    if ("name" in task && typeof task.name === "string" && task.name.trim().length > 0) spec.name = task.name;
    if ("cwd" in task && typeof task.cwd === "string" && task.cwd.length > 0) spec.cwd = task.cwd;
    return spec;
  });

  if (tasks.some((task) => task === null)) return undefined;
  return { tasks: tasks as RunnableTaskSpec[] };
}

function ensureRunnableParams<TRun extends TaskRunIdentity & RunnableTaskRun>(run: TRun): TRun {
  if (hasRunnableParams(run)) return run;
  const params = deriveRunnableParams(run);
  if (!params) return run;
  return { ...run, params };
}

export function mergeTaskRunHistoryPreferAudit<TRun extends TaskRunIdentity & RunnableTaskRun>(
  restoredRuns: Iterable<TRun>,
  auditRuns: Iterable<TRun>,
): TRun[] {
  const merged = new Map<string, TRun>();

  for (const run of restoredRuns) {
    merged.set(run.id, ensureRunnableParams(run));
  }

  for (const auditRun of auditRuns) {
    let equivalentRun: TRun | undefined;
    for (const existing of merged.values()) {
      if (!taskRunsAreEquivalent(existing, auditRun)) continue;
      equivalentRun = existing;
      merged.delete(existing.id);
      break;
    }

    const combinedRun = equivalentRun ? ({ ...equivalentRun, ...auditRun } as TRun) : auditRun;
    merged.set(auditRun.id, ensureRunnableParams(combinedRun));
  }

  return Array.from(merged.values());
}
