import { App, Notice, TFile } from "obsidian";
import { DriveClient } from "../api/client";
import { DiagnosticsLogger } from "../logger";
import { Indexer } from "./indexer";
import { computeDiff, DiffResult, buildConflictCopyName, DiffOperation } from "./diff";
import { IndexEntry, RemoteEntry, SynodriveSettings } from "../settings";
import { toPosixPath } from "../utils/paths";
import { buildMatcher } from "../utils/exclusions";

export interface SyncParams {
  quickPaths?: string[];
  mode?: "manual" | "background" | "event";
}

export class SyncEngine {
  private indexer: Indexer;
  private matcher: (path: string) => boolean;

  constructor(
    private app: App,
    private settings: SynodriveSettings,
    private client: DriveClient,
    private logger: DiagnosticsLogger,
  ) {
    this.indexer = new Indexer(app, settings.exclusions);
    this.matcher = buildMatcher(settings.exclusions);
  }

  updateSettings(settings: SynodriveSettings) {
    this.settings = settings;
    this.indexer = new Indexer(this.app, settings.exclusions);
    this.matcher = buildMatcher(settings.exclusions);
    this.client.setBaseUrl(settings.serverBaseUrl);
  }

  async sync(params?: SyncParams): Promise<DiffResult | null> {
    if (!this.settings.remoteRoot) {
      new Notice("Select a remote root first");
      return null;
    }
    if (!this.client.isAuthenticated()) {
      new Notice("Connect to Synology Drive to sync");
      return null;
    }

    const start = performance.now();
    if (params?.quickPaths?.length) {
      this.logger.info(`Starting quick sync (${params.mode ?? "event"}) for ${params.quickPaths.length} items`);
    } else {
      this.logger.info(`Starting sync (${params?.mode ?? "manual"})`);
    }
    const hashNeeded = false; // enable later when detecting ambiguous renames
    const [localIndex, remoteIndex] = await Promise.all([
      this.indexer.localIndex(hashNeeded),
      this.indexer.remoteIndex(this.client, this.settings.remoteRoot, hashNeeded),
    ]);

    const diff = computeDiff(localIndex, remoteIndex, {
      mode: this.settings.syncMode,
    });

    await this.applyOperations(diff, localIndex, remoteIndex);

    const duration = performance.now() - start;
    this.logger.info(`Sync finished in ${Math.round(duration)} ms`);
    this.settings.lastSyncReport = {
      ranAt: Date.now(),
      durationMs: duration,
      summary: diff.summary,
    };
    return diff;
  }

  private async applyOperations(diff: DiffResult, localIndex: IndexEntry[], remoteIndex: RemoteEntry[]) {
    const operations = diff.operations;
    let cursor = 0;
    const concurrency = Math.max(1, this.settings.maxConcurrency || 1);

    const worker = async () => {
      while (cursor < operations.length) {
        const op = operations[cursor];
        cursor += 1;
        try {
          await this.executeOperation(op, localIndex, remoteIndex);
        } catch (err) {
          this.logger.error(`Failed to handle ${op.type} for ${op.path}: ${(err as Error).message}`);
        }
      }
    };

    const tasks = Array.from({ length: concurrency }, worker);
    await Promise.all(tasks);
  }

  private async executeOperation(op: DiffOperation, localIndex: IndexEntry[], remoteIndex: RemoteEntry[]) {
    switch (op.type) {
      case "upload":
        await this.upload(op.path, localIndex.find((e) => e.path === op.path));
        break;
      case "download":
        await this.download(op.path, remoteIndex.find((e) => e.path === op.path));
        break;
      case "deleteLocal":
        await this.deleteLocal(op.path);
        break;
      case "deleteRemote":
        await this.deleteRemote(op.path);
        break;
      case "renameRemote":
        if (op.targetPath)
          await this.client.move(
            `${this.settings.remoteRoot}/${op.path}`,
            `${this.settings.remoteRoot}/${op.targetPath}`,
          );
        break;
      case "renameLocal":
        if (op.targetPath) await this.renameLocal(op.path, op.targetPath);
        break;
      case "conflictCopy":
        if (op.targetPath) await this.createConflictCopy(op.path, op.targetPath);
        break;
      default:
        break;
    }
  }

  private async upload(path: string, entry?: IndexEntry) {
    if (!entry) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const data = await this.app.vault.readBinary(file);
    const remotePath = `${this.settings.remoteRoot}/${entry.path}`;
    await this.ensureRemoteFolders(remotePath);
    await this.client.uploadFile(remotePath, data);
    this.logger.info(`Uploaded ${path}`);
  }

  private async download(path: string, entry?: RemoteEntry) {
    if (!entry?.fileId && !entry?.path) return;
    const data = entry.fileId ? await this.client.downloadFile(entry.fileId) : new ArrayBuffer(0);
    const target = toPosixPath(path);
    await this.ensureFolder(target);
    await this.app.vault.adapter.writeBinary(target, data);
    this.logger.info(`Downloaded ${path}`);
  }

  private async deleteLocal(path: string) {
    if (this.matcher(path)) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.delete(file);
      this.logger.info(`Deleted local ${path}`);
    }
  }

  private async deleteRemote(path: string) {
    const remotePath = `${this.settings.remoteRoot}/${path}`;
    await this.client.deletePath(remotePath);
    this.logger.info(`Deleted remote ${path}`);
  }

  private async renameLocal(oldPath: string, newPath: string) {
    const file = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(file instanceof TFile)) return;
    await this.app.vault.rename(file, newPath);
    this.logger.info(`Renamed local ${oldPath} -> ${newPath}`);
  }

  private async createConflictCopy(path: string, conflictPath?: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const target = conflictPath ?? buildConflictCopyName(path);
    await this.ensureFolder(target);
    await this.app.vault.create(target, content);
    this.logger.warn(`Conflict copy written to ${target}`);
  }

  private async ensureFolder(path: string) {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      if (!part) continue;
      current = `${current}/${part}`;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  private async ensureRemoteFolders(remotePath: string) {
    const parts = remotePath.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      if (!part) continue;
      current = `${current}/${part}`;
      await this.client.createFolder(current);
    }
  }
}
