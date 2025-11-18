import { describe, expect, it } from "vitest";
import { computeDiff, buildConflictCopyName } from "../src/sync/diff";
import { IndexEntry, RemoteEntry } from "../src/settings";

const now = Date.now();

const baseLocal = (path: string, mtime = now, size = 1): IndexEntry => ({ path, size, mtime });
const baseRemote = (path: string, mtime = now, size = 1): RemoteEntry => ({ path, size, mtime });

describe("computeDiff", () => {
  it("uploads new local files and downloads new remote files in two-way mode", () => {
    const local = [baseLocal("local.md")];
    const remote = [baseRemote("remote.md")];
    const diff = computeDiff(local, remote, { mode: "two-way" });
    const types = diff.operations.map((op) => op.type);
    expect(types).toContain("upload");
    expect(types).toContain("download");
  });

  it("ignores remote-only additions in one-way mode", () => {
    const diff = computeDiff([], [baseRemote("remote.md")], { mode: "one-way-up" });
    expect(diff.operations.find((op) => op.type === "download")).toBeUndefined();
  });

  it("propagates remote deletes in two-way mode", () => {
    const diff = computeDiff([], [baseRemote("ghost.md")], { mode: "two-way" });
    expect(diff.operations.some((op) => op.type === "deleteLocal")).toBe(true);
  });

  it("detects rename pairs", () => {
    const local = [baseLocal("beta.md", now, 10)];
    const remote = [baseRemote("alpha.md", now - 1000, 10)];
    const diff = computeDiff(local, remote, { mode: "two-way" });
    const rename = diff.operations.find((op) => op.type === "renameRemote");
    expect(rename?.path).toBe("alpha.md");
    expect(rename?.targetPath).toBe("beta.md");
  });

  it("creates conflict copies when both sides change", () => {
    const local = [baseLocal("note.md", now + 2000, 2)];
    const remote = [baseRemote("note.md", now, 3)];
    const diff = computeDiff(local, remote, { mode: "two-way" });
    const conflict = diff.operations.find((op) => op.type === "conflictCopy");
    const download = diff.operations.find((op) => op.type === "download");
    expect(conflict).toBeTruthy();
    expect(download).toBeTruthy();
    expect(conflict?.targetPath).toContain("conflict");
  });

  it("caps delete operations at safety threshold", () => {
    const local: IndexEntry[] = [];
    const remote: RemoteEntry[] = Array.from({ length: 25 }, (_v, i) => baseRemote(`file-${i}.md`, now, 1));
    const diff = computeDiff(local, remote, { mode: "two-way", deletionCap: 20 });
    expect(diff.skippedDeletes).toBe(true);
    expect(diff.operations.some((op) => op.type === "deleteLocal" || op.type === "deleteRemote")).toBe(false);
  });
});

describe("buildConflictCopyName", () => {
  it("formats conflict suffix", () => {
    const date = new Date("2024-01-02T03:04:05Z");
    expect(buildConflictCopyName("note.md", date)).toBe("note (conflict 2024-01-02-030405).md");
    expect(buildConflictCopyName("plain", date)).toBe("plain (conflict 2024-01-02-030405)");
  });
});
