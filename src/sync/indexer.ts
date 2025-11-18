import { App, TFile } from "obsidian";
import { buildMatcher } from "../utils/exclusions";
import { toPosixPath } from "../utils/paths";
import { IndexEntry, RemoteEntry } from "../settings";
import { DriveClient, DriveItem } from "../api/client";

export interface IndexerOptions {
  exclusions: string[];
  hashFiles?: boolean;
}

export class Indexer {
  private matcher: (path: string) => boolean;

  constructor(private app: App, exclusions: string[]) {
    this.matcher = buildMatcher(exclusions);
  }

  async localIndex(hashFiles: boolean): Promise<IndexEntry[]> {
    const files = this.app.vault.getFiles();
    const entries: IndexEntry[] = [];
    for (const file of files) {
      const normalized = toPosixPath(file.path);
      if (this.matcher(normalized)) continue;
      const base: IndexEntry = {
        path: normalized,
        size: file.stat.size,
        mtime: file.stat.mtime,
      };
      if (hashFiles) {
        base.hash = await this.hashFile(file);
      }
      entries.push(base);
    }
    return entries;
  }

  async remoteIndex(client: DriveClient, root: string, hashRequired: boolean): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = [];
    const stack: string[] = [root];
    while (stack.length) {
      const current = stack.pop();
      if (!current) break;
      const items = await client.list(current, { includeFiles: true });
      for (const item of items) {
        const normalized = toPosixPath(item.path);
        if (this.matcher(normalized)) continue;
        if (item.type === "dir") {
          stack.push(normalized);
          continue;
        }
        const relative = normalized.startsWith(root) ? normalized.slice(root.length).replace(/^\//, "") : normalized;
        const entry: RemoteEntry = {
          path: relative,
          size: item.size ?? 0,
          mtime: item.modified_time ?? item.change_time ?? Date.now(),
          hash: hashRequired ? item.hash : undefined,
          fileId: item.file_id,
          version: item.version,
          etag: item.etag,
        };
        entries.push(entry);
      }
    }
    return entries;
  }

  private async hashFile(file: TFile): Promise<string> {
    const arrayBuffer = await this.app.vault.readBinary(file);
    const crypto = globalThis.crypto || (globalThis as unknown as { webcrypto?: Crypto }).webcrypto;
    if (!crypto?.subtle) return "";
    const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
