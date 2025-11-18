import { Plugin, normalizePath, TFile } from "obsidian";
import { MAX_LOG_LINES, DIAGNOSTIC_LOG_EXPORT_PREFIX } from "./constants";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
}

export class DiagnosticsLogger {
  private entries: LogEntry[] = [];

  constructor(private max = MAX_LOG_LINES) {}

  info(message: string) {
    this.append("info", message);
  }

  warn(message: string) {
    this.append("warn", message);
  }

  error(message: string) {
    this.append("error", message);
  }

  append(level: LogLevel, message: string) {
    const masked = maskSensitive(message);
    this.entries.push({ level, message: masked, timestamp: Date.now() });
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }
  }

  getRecent(limit = this.max): LogEntry[] {
    return this.entries.slice(-limit);
  }

  toString(): string {
    return this.entries
      .map((entry) => `${new Date(entry.timestamp).toISOString()} [${entry.level.toUpperCase()}] ${entry.message}`)
      .join("\n");
  }

  async exportToFile(plugin: Plugin): Promise<TFile | null> {
    const folder = normalizePath(`.obsidian/plugins/${plugin.manifest.id}`);
    const filename = `${DIAGNOSTIC_LOG_EXPORT_PREFIX}-${Date.now()}.log`;
    const target = `${folder}/${filename}`;
    try {
      if (!(await plugin.app.vault.adapter.exists(folder))) {
        await plugin.app.vault.adapter.mkdir(folder);
      }
      await plugin.app.vault.adapter.write(target, this.toString());
      this.info(`Exported diagnostics to ${target}`);
      return plugin.app.vault.getAbstractFileByPath(target) as TFile | null;
    } catch (err) {
      console.error(err);
      this.error(`Failed to export diagnostics: ${(err as Error).message}`);
      return null;
    }
  }
}

export function maskSensitive(input: string): string {
  return input.replace(/sid=[^;\s]+/gi, "sid=***");
}
