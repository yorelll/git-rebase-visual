import { runGit } from "./gitRunner";

export interface UndoRecord {
  id: string;
  operation: string;
  beforeRef: string;
  beforeTip: string;
  afterTip?: string;
  branch?: string;
  affectedHashes: string[];
  affectedSteps: number;
  createdAt: string;
  status: "pending" | "completed" | "aborted" | "undone";
}

/** Minimal persistence surface shared by VS Code's workspace/global mementos. */
export interface UndoMemento {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export const UNDO_WORKSPACE_KEY = "gitRebaseVisual.undoJournal.workspace";
export const UNDO_GLOBAL_KEY = "gitRebaseVisual.undoJournal.global";
const MAX_RECORDS = 30;

export function undoRef(id: string): string {
  return `refs/gitRebaseVisual/undo/${id}`;
}

export function newUndoId(now = Date.now()): string {
  return `${now}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * A private-ref-backed journal. Every record is deliberately written to both
 * scopes: workspace state is local to the checkout while global state lets a
 * user recover its history after closing/reopening that workspace.
 */
export class UndoJournal {
  constructor(
    private readonly workspace: UndoMemento,
    private readonly global: UndoMemento
  ) {}

  records(): UndoRecord[] {
    const workspaceRecords = this.workspace.get<UndoRecord[]>(UNDO_WORKSPACE_KEY, []) ?? [];
    const globalRecords = this.global.get<UndoRecord[]>(UNDO_GLOBAL_KEY, []) ?? [];
    const byId = new Map<string, UndoRecord>();
    for (const record of [...globalRecords, ...workspaceRecords]) {
      byId.set(record.id, record);
    }
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  latestCompleted(): UndoRecord | undefined {
    return this.records().find((record) => record.status === "completed");
  }

  async start(
    cwd: string,
    input: Omit<UndoRecord, "id" | "beforeRef" | "createdAt" | "status">
  ): Promise<UndoRecord> {
    const id = newUndoId();
    const record: UndoRecord = {
      ...input,
      id,
      beforeRef: undoRef(id),
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    // `update-ref` is an intentional private safety checkpoint. Never use
    // ORIG_HEAD: unrelated Git commands are allowed to change it.
    const result = await runGit(["update-ref", record.beforeRef, record.beforeTip], { cwd });
    if (result.code !== 0) {
      throw new Error(`无法建立 Undo 安全引用：${result.stderr.trim()}`);
    }
    await this.save(record);
    return record;
  }

  async complete(record: UndoRecord, afterTip: string | undefined): Promise<UndoRecord> {
    const next: UndoRecord = { ...record, afterTip, status: "completed" };
    await this.save(next);
    return next;
  }

  async mark(record: UndoRecord, status: UndoRecord["status"]): Promise<void> {
    await this.save({ ...record, status });
  }

  private async save(record: UndoRecord): Promise<void> {
    const merge = (records: UndoRecord[]) => [record, ...records.filter((item) => item.id !== record.id)].slice(0, MAX_RECORDS);
    await Promise.all([
      this.workspace.update(UNDO_WORKSPACE_KEY, merge(this.workspace.get<UndoRecord[]>(UNDO_WORKSPACE_KEY, []) ?? [])),
      this.global.update(UNDO_GLOBAL_KEY, merge(this.global.get<UndoRecord[]>(UNDO_GLOBAL_KEY, []) ?? [])),
    ]);
  }
}

export interface UndoPreflight {
  ok: boolean;
  reason?: string;
}

/** Pure decision helper, intentionally testable without VS Code. */
export function undoPreflight(input: {
  rebaseInProgress: boolean;
  currentBranch?: string;
  expectedBranch?: string;
  head?: string;
  expectedAfterTip?: string;
  dirty: boolean;
  refExists: boolean;
}): UndoPreflight {
  if (input.rebaseInProgress) return { ok: false, reason: "变基进行中，不能撤销。请先 Continue 或 Abort。" };
  if (!input.refExists) return { ok: false, reason: "Undo 安全引用已不存在，不能安全撤销。" };
  if (!input.expectedAfterTip || input.head !== input.expectedAfterTip) return { ok: false, reason: "HEAD 已变化，不能撤销到过期的操作。" };
  if (input.expectedBranch && input.currentBranch !== input.expectedBranch) return { ok: false, reason: "当前分支不是该操作完成时的分支，不能撤销。" };
  if (input.dirty) return { ok: false, reason: "工作区或暂存区有改动。请先 stash/提交，或取消撤销。" };
  return { ok: true };
}
