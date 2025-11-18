import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Obsidian from "obsidian";
import { DiagnosticsLogger } from "../src/logger";
import { DriveClient } from "../src/api/client";

describe("DriveClient retries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("retries on 429 and respects Retry-After", async () => {
    vi.useFakeTimers();
    const requestUrl = vi
      .spyOn(Obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 429,
        headers: { "Retry-After": "1", "content-type": "application/json" },
        json: { success: false },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/json" },
        json: { success: true, data: { items: [] } },
      } as any);

    const client = new DriveClient("https://example.com", new DiagnosticsLogger(), { timeoutSeconds: 1, maxRetries: 3 });
    client.setSid("abc");
    const promise = client.list("/mydrive", { includeFiles: false });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual([]);
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it("rejects non-HTTPS base URLs", () => {
    expect(() => new DriveClient("http://example.com", new DiagnosticsLogger())).toThrow();
  });
});
