import { normalizePath } from "obsidian";

export type SyncMode = "one-way-up" | "two-way";

export interface StoredSession {
  encryptedSid?: string;
  sidExpiresAt?: number | null;
  username?: string;
  serverBaseUrl?: string;
}

export interface SynodriveSettings {
  serverBaseUrl: string;
  username: string;
  remoteRoot: string;
  syncMode: SyncMode;
  exclusions: string[];
  intervalMinutes: number;
  maxConcurrency: number;
  chunkMb: number;
  timeoutSeconds: number;
  backgroundSync: boolean;
  debug: boolean;
  lastSyncReport?: SyncReport;
  session?: StoredSession;
  encryptionKey?: string;
  cachedLocalIndex?: IndexEntry[];
  cachedRemoteIndex?: RemoteEntry[];
}

export interface SyncReport {
  ranAt: number;
  durationMs: number;
  summary: Record<string, number>;
  errors?: string[];
}

export interface IndexEntry {
  path: string;
  size: number;
  mtime: number;
  hash?: string;
}

export interface RemoteEntry extends IndexEntry {
  fileId?: string;
  version?: number;
  etag?: string;
}

export const DEFAULT_EXCLUSIONS = [
  ".obsidian/**",
  ".git/**",
  "**/.ds_store",
  "**/thumbs.db",
  "**/desktop.ini",
  ".*",
];

export const DEFAULT_SETTINGS: SynodriveSettings = {
  serverBaseUrl: "https://nas.local",
  username: "",
  remoteRoot: "/mydrive",
  syncMode: "two-way",
  exclusions: DEFAULT_EXCLUSIONS,
  intervalMinutes: 15,
  maxConcurrency: 4,
  chunkMb: 8,
  timeoutSeconds: 30,
  backgroundSync: true,
  debug: false,
  session: undefined,
  encryptionKey: undefined,
  cachedLocalIndex: undefined,
  cachedRemoteIndex: undefined,
};

export function normalizeRemotePath(path: string): string {
  const cleaned = path.replace(/\\/g, "/");
  const normalized = cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  return normalizePath(normalized);
}
