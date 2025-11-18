import { normalizePath, requestUrl } from "obsidian";
import { DiagnosticsLogger } from "../logger";
import { delay } from "../utils/time";
import { withinMyDrive } from "../utils/paths";

export interface ClientOptions {
  timeoutSeconds: number;
  maxRetries: number;
  chunkMb: number;
  debug?: boolean;
}

export interface DriveItem {
  name: string;
  path: string;
  type: "file" | "dir";
  file_id?: string;
  size?: number;
  modified_time?: number;
  change_time?: number;
  hash?: string;
  version?: number;
  etag?: string;
  parent_id?: string;
  display_path?: string;
}

export interface ListOptions {
  includeFiles?: boolean;
}

interface LoginResponse {
  success: boolean;
  data?: { sid: string; did: string };
  error?: { code: number };
}

export class DriveClient {
  private sid: string | null = null;
  private baseUrl: string;
  private options: ClientOptions;

  constructor(baseUrl: string, private logger: DiagnosticsLogger, opts?: Partial<ClientOptions>) {
    this.baseUrl = sanitizeBaseUrl(baseUrl);
    this.options = {
      timeoutSeconds: opts?.timeoutSeconds ?? 30,
      maxRetries: opts?.maxRetries ?? 4,
      chunkMb: opts?.chunkMb ?? 8,
      debug: opts?.debug ?? false,
    };
  }

  setBaseUrl(baseUrl: string) {
    this.baseUrl = sanitizeBaseUrl(baseUrl);
  }

  setSid(sid: string | null) {
    this.sid = sid;
  }

  setDebug(debug: boolean) {
    this.options.debug = debug;
  }

  isAuthenticated(): boolean {
    return Boolean(this.sid);
  }

  async login(params: { serverBaseUrl: string; username: string; password: string; otp?: string }): Promise<string> {
    this.baseUrl = sanitizeBaseUrl(params.serverBaseUrl);
    const body = {
      format: "sid",
      account: params.username,
      passwd: params.password,
      otp_code: params.otp || undefined,
    };
    const response = await this.request<LoginResponse>("/api/SynologyDrive/default/v1/login", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      skipAuth: true,
    });
    if (!response.success || !response.data?.sid) {
      throw new Error("Login failed");
    }
    this.sid = response.data.sid;
    return response.data.sid;
  }

  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      await this.request("/api/SynologyDrive/default/v1/logout", {
        method: "POST",
        body: JSON.stringify({ _sid: this.sid }),
        headers: { "Content-Type": "application/json" },
        skipAuth: true,
      });
    } catch (err) {
      this.logger.warn(`Logout failed: ${(err as Error).message}`);
    } finally {
      this.sid = null;
    }
  }

  async validate(): Promise<boolean> {
    if (!this.sid) return false;
    try {
      await this.list("/mydrive", { includeFiles: false });
      return true;
    } catch (err) {
      this.logger.warn(`Session validation failed: ${(err as Error).message}`);
      return false;
    }
  }

  async list(path: string, opts?: ListOptions): Promise<DriveItem[]> {
    const normalized = normalizePath(path.startsWith("/") ? path : `/${path}`);
    const body = {
      path: normalized,
      filter: opts?.includeFiles ? undefined : { type: ["dir"] },
      additional: ["hash"],
      sort_by: "name",
      sort_direction: "asc",
    };
    const response = await this.request<{ success: boolean; data?: { items: DriveItem[] } }>(
      "/api/SynologyDrive/default/v1/files/list",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );
    if (!response.success || !response.data) throw new Error("Failed to list directory");
    return response.data.items.map((item) => ({
      ...item,
      path: normalizePath(item.display_path ?? item.path ?? `${normalized}/${item.name}`),
      type: item.type === "dir" ? "dir" : "file",
    }));
  }

  async createFolder(path: string): Promise<void> {
    if (!withinMyDrive(path)) throw new Error("Only /mydrive paths are allowed");
    const body = { type: "folder", path: normalizePath(path), conflict_action: "stop" };
    try {
      await this.request("/api/SynologyDrive/default/v1/files", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = (err as Error).message || "";
      if (/exists/i.test(msg)) {
        this.logger.info(`Folder already exists at ${path}, continuing`);
        return;
      }
      throw err;
    }
  }

  async move(oldPath: string, newPath: string): Promise<void> {
    await this.request("/api/SynologyDrive/default/v1/files/move", {
      method: "POST",
      body: JSON.stringify({
        path: normalizePath(oldPath),
        destination: normalizePath(newPath),
        overwrite: true,
      }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async deletePath(path: string): Promise<void> {
    await this.request("/api/SynologyDrive/default/v1/files/delete", {
      method: "POST",
      body: JSON.stringify({ path: normalizePath(path) }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async uploadFile(targetPath: string, data: ArrayBuffer | Blob): Promise<void> {
    const totalSize = data instanceof Blob ? data.size : data.byteLength;
    const chunkBytes = this.options.chunkMb * 1024 * 1024;
    const asBlob = data instanceof Blob ? data : new Blob([data]);
    if (totalSize <= chunkBytes) {
      await this.uploadChunk(targetPath, asBlob);
      return;
    }
    let offset = 0;
    while (offset < totalSize) {
      const chunk = asBlob.slice(offset, offset + chunkBytes);
      offset += chunkBytes;
      await this.uploadChunk(targetPath, chunk);
    }
  }

  private async uploadChunk(targetPath: string, blob: Blob): Promise<void> {
    const form = new FormData();
    form.append("path", normalizePath(targetPath));
    form.append("file", blob);
    form.append("conflict_action", "overwrite");
    await this.request("/api/SynologyDrive/default/v1/files/upload", {
      method: "PUT",
      body: form,
    });
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const body = { files: [{ id: fileId }], force_download: true };
    const response = await this.request<ArrayBuffer>("/api/SynologyDrive/default/v1/files/download", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      expectJson: false,
    });
    return response;
  }

  private async request<T>(
    path: string,
    options: RequestInit & { skipAuth?: boolean; expectJson?: boolean; body?: string | ArrayBuffer | FormData } = {},
  ): Promise<T> {
    if (!options.skipAuth && !this.sid) {
      throw new Error("Not authenticated");
    }
    if (!this.baseUrl) {
      throw new Error("Server URL is not configured");
    }
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (options.headers) {
      if (Array.isArray(options.headers)) {
        for (const [key, value] of options.headers) headers[key] = value;
      } else if (options.headers instanceof Headers) {
        options.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else {
        Object.assign(headers, options.headers as Record<string, string>);
      }
    }
    if (!options.skipAuth && this.sid) {
      headers.cookie = `id=${this.sid}`;
    }

    let attempt = 0;
    let lastError: Error | null = null;
    const maxAttempts = this.options.maxRetries;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        if (this.options.debug) {
          // eslint-disable-next-line no-console
          console.log("[Synodrive] request", {
            url,
            method: options.method ?? "GET",
            headers,
            bodyPreview: options.body instanceof FormData ? "[form-data]" : options.body,
          });
        }
        const response = await requestUrl({
          url,
          method: options.method ?? "GET",
          headers,
          body: options.body as any,
          contentType: headers["Content-Type"],
          throw: false,
        });
        if (this.options.debug) {
          // eslint-disable-next-line no-console
          console.log("[Synodrive] response", {
            url,
            status: response.status,
            headers: response.headers,
            bodyPreview:
              typeof response.json === "string"
                ? response.json
                : response.arrayBuffer
                ? `[binary ${typeof response.arrayBuffer}]`
                : response.json,
          });
        }

        if (response.status === 401) {
          throw new Error("Unauthorized");
        }

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers["Retry-After"] || response.headers["retry-after"] || 0);
          const backoff = Math.min(30_000, Math.pow(2, attempt) * 500 + Math.random() * 250);
          const wait = retryAfter ? retryAfter * 1000 : backoff;
          await delay(wait);
          continue;
        }

        if (options.expectJson === false) {
          return response.arrayBuffer as unknown as T;
        }
        const contentType = (response.headers["content-type"] || response.headers["Content-Type"] || "") as string;
        if (!contentType.toLowerCase().includes("json")) {
          throw new Error("Server returned non-JSON response; check HTTPS base URL and permissions.");
        }
        const json = response.json as T;
        return json;
      } catch (err) {
        lastError = err as Error;
        const backoff = Math.min(30_000, Math.pow(2, attempt) * 500 + Math.random() * 250);
        await delay(backoff);
      }
    }
    this.logger.error(`Request ${path} failed after ${maxAttempts} attempts: ${lastError?.message ?? "unknown"}`);
    throw lastError ?? new Error("Unknown error");
  }
}

export function sanitizeBaseUrl(raw: string): string {
  if (!raw) throw new Error("Missing server URL");
  const trimmed = raw.trim().replace(/\/$/, "");
  const url = new URL(trimmed);
  if (url.protocol !== "https:") {
    throw new Error("HTTPS is required");
  }
  return url.toString();
}
