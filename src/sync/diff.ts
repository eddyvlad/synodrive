import { DELETE_SAFETY_CAP, RENAME_WINDOW_MS } from "../constants";
import { IndexEntry, RemoteEntry, SyncMode } from "../settings";
import { formatConflictTimestamp } from "../utils/time";

export type OperationType =
  | "upload"
  | "download"
  | "deleteRemote"
  | "deleteLocal"
  | "renameRemote"
  | "renameLocal"
  | "conflictCopy";

export interface DiffOperation {
  type: OperationType;
  path: string;
  targetPath?: string;
  entry?: IndexEntry | RemoteEntry;
  reason?: string;
}

export interface DiffResult {
  operations: DiffOperation[];
  skippedDeletes: boolean;
  conflicts: ConflictRecord[];
  summary: Record<string, number>;
}

export interface ConflictRecord {
  path: string;
  conflictCopyPath: string;
  reason: string;
}

export interface DiffOptions {
  mode: SyncMode;
  deletionCap?: number;
  renameWindowMs?: number;
}

function isChanged(local: IndexEntry, remote: RemoteEntry): { localChanged: boolean; remoteChanged: boolean } {
  const sizeDiff = local.size !== remote.size;
  const timeDiff = Math.abs(local.mtime - remote.mtime) > 1000;
  const hashDiff = local.hash && remote.hash ? local.hash !== remote.hash : false;
  const localNewer = local.mtime > remote.mtime + 1000;
  const remoteNewer = remote.mtime > local.mtime + 1000;
  return {
    localChanged: sizeDiff || hashDiff || localNewer,
    remoteChanged: sizeDiff || hashDiff || remoteNewer,
  };
}

function findRenamePair(
  removed: RemoteEntry[],
  added: IndexEntry[],
  windowMs: number,
): Array<{ from: RemoteEntry; to: IndexEntry }> {
  const pairs: Array<{ from: RemoteEntry; to: IndexEntry }> = [];
  const remaining = [...added];
  for (const source of removed) {
    const matchIndex = remaining.findIndex((candidate) => {
      const sizeMatch = candidate.size === source.size;
      const timeMatch = Math.abs(candidate.mtime - source.mtime) <= windowMs;
      if (!sizeMatch || !timeMatch) return false;
      if (candidate.hash && source.hash) {
        return candidate.hash === source.hash;
      }
      return true;
    });
    if (matchIndex >= 0) {
      const match = remaining.splice(matchIndex, 1)[0];
      pairs.push({ from: source, to: match });
    }
  }
  return pairs;
}

export function buildConflictCopyName(path: string, now = new Date()): string {
  const idx = path.lastIndexOf(".");
  const ts = formatConflictTimestamp(now);
  if (idx === -1 || idx === 0) return `${path} (conflict ${ts})`;
  const base = path.substring(0, idx);
  const ext = path.substring(idx);
  return `${base} (conflict ${ts})${ext}`;
}

export function computeDiff(
  localIndex: IndexEntry[],
  remoteIndex: RemoteEntry[],
  opts: DiffOptions,
): DiffResult {
  const operations: DiffOperation[] = [];
  const conflicts: ConflictRecord[] = [];
  const summary: Record<string, number> = {};
  const deletionCap = opts.deletionCap ?? DELETE_SAFETY_CAP;
  const renameWindowMs = opts.renameWindowMs ?? RENAME_WINDOW_MS;

  const remoteMap = new Map(remoteIndex.map((r) => [r.path, r]));
  const localMap = new Map(localIndex.map((l) => [l.path, l]));

  const localOnly: IndexEntry[] = [];
  const remoteOnly: RemoteEntry[] = [];

  for (const local of localIndex) {
    const remote = remoteMap.get(local.path);
    if (!remote) {
      localOnly.push(local);
      continue;
    }
    const { localChanged, remoteChanged } = isChanged(local, remote);
    if (localChanged && remoteChanged) {
      const conflictPath = buildConflictCopyName(local.path);
      conflicts.push({ path: local.path, conflictCopyPath: conflictPath, reason: "Both sides changed" });
      operations.push({ type: "conflictCopy", path: local.path, targetPath: conflictPath, entry: local });
      if (opts.mode === "two-way") {
        operations.push({ type: "download", path: local.path, entry: remote, reason: "Remote newer" });
      } else {
        operations.push({ type: "upload", path: local.path, entry: local, reason: "One-way prefers local" });
      }
      continue;
    }
    if (localChanged) {
      operations.push({ type: "upload", path: local.path, entry: local });
    } else if (remoteChanged && opts.mode === "two-way") {
      operations.push({ type: "download", path: local.path, entry: remote });
    }
  }

  for (const remote of remoteIndex) {
    if (!localMap.has(remote.path)) {
      remoteOnly.push(remote);
    }
  }

  // Additions
  for (const entry of localOnly) {
    operations.push({ type: "upload", path: entry.path, entry });
  }

  for (const remote of remoteOnly) {
    if (opts.mode === "two-way") {
      operations.push({ type: "download", path: remote.path, entry: remote });
    }
  }

  // Deletes two-way only
  if (opts.mode === "two-way") {
    for (const remote of remoteOnly) {
      if (!localOnly.find((l) => l.path === remote.path)) {
        operations.push({ type: "deleteLocal", path: remote.path, entry: remote });
      }
    }
    for (const local of localOnly) {
      if (!remoteOnly.find((r) => r.path === local.path)) {
        operations.push({ type: "deleteRemote", path: local.path, entry: local });
      }
    }
  }

  // Rename detection (best-effort)
  const renamePairs = findRenamePair(remoteOnly, localOnly, renameWindowMs);
  for (const pair of renamePairs) {
    const direction = pair.to.mtime >= pair.from.mtime ? "renameRemote" : "renameLocal";
    operations.push({
      type: direction,
      path: direction === "renameRemote" ? pair.from.path : pair.to.path,
      targetPath: direction === "renameRemote" ? pair.to.path : pair.from.path,
      entry: direction === "renameRemote" ? pair.from : pair.to,
      reason: "Rename detected",
    });
  }

  // Safety cap on deletions
  const deleteCount = operations.filter((op) => op.type === "deleteLocal" || op.type === "deleteRemote").length;
  let skippedDeletes = false;
  if (deleteCount > deletionCap) {
    skippedDeletes = true;
    for (let i = operations.length - 1; i >= 0; i -= 1) {
      if (operations[i].type === "deleteLocal" || operations[i].type === "deleteRemote") {
        operations.splice(i, 1);
      }
    }
  }

  for (const op of operations) {
    summary[op.type] = (summary[op.type] || 0) + 1;
  }

  return { operations, skippedDeletes, conflicts, summary };
}
