import { Plugin } from "obsidian";
import { DiagnosticsLogger } from "../logger";
import { delay } from "../utils/time";
import { SynodriveSettings } from "../settings";

const STORAGE_KEY = "synodrive-session-key";

function getCrypto() {
  return globalThis.crypto || (globalThis as unknown as { webcrypto?: Crypto }).webcrypto;
}

function toBase64(bytes: ArrayBuffer): string {
  const uint8 = new Uint8Array(bytes);
  let binary = "";
  uint8.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  if (typeof btoa !== "undefined") {
    return btoa(binary);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return Buffer.from(binary, "binary").toString("base64");
}

function fromBase64(str: string): ArrayBuffer {
  const binary = typeof atob !== "undefined" ? atob(str) : Buffer.from(str, "base64").toString("binary");
  const uint8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    uint8[i] = binary.charCodeAt(i);
  }
  return uint8.buffer;
}

export class SecureSessionStore {
  constructor(
    private plugin: Plugin,
    private logger: DiagnosticsLogger,
    private getSettings: () => SynodriveSettings,
    private persist: (settings: SynodriveSettings) => Promise<void>,
  ) {}

  private async getOrCreateKey(): Promise<CryptoKey | null> {
    const crypto = getCrypto();
    if (!crypto?.subtle) return null;
    const storage = this.getStorage();
    const settings = this.getSettings();
    const existing = storage?.getItem(STORAGE_KEY) ?? settings.encryptionKey;
    if (existing) {
      return crypto.subtle.importKey("raw", fromBase64(existing), "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const raw = await crypto.subtle.exportKey("raw", key);
    const b64 = toBase64(raw);
    storage?.setItem(STORAGE_KEY, b64);
    settings.encryptionKey = b64;
    await this.persist(settings);
    return key;
  }

  private getStorage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage;
    } catch (_err) {
      return null;
    }
  }

  async encrypt(text: string): Promise<string> {
    const crypto = getCrypto();
    if (!crypto?.subtle) {
      this.logger.warn("Secure storage unavailable; storing SID without hardware encryption");
      return text;
    }
    const key = await this.getOrCreateKey();
    if (!key) return text;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    return `${toBase64(iv.buffer)}:${toBase64(cipher)}`;
  }

  async decrypt(payload?: string | null): Promise<string | null> {
    if (!payload) return null;
    const crypto = getCrypto();
    if (!crypto?.subtle || !payload.includes(":")) {
      return payload;
    }
    const [ivB64, dataB64] = payload.split(":");
    try {
      const key = await this.getOrCreateKey();
      if (!key) return payload;
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(fromBase64(ivB64)) }, key, fromBase64(dataB64));
      return new TextDecoder().decode(plain);
    } catch (err) {
      this.logger.error(`Failed to decrypt stored session: ${(err as Error).message}`);
      await delay(50);
      return null;
    }
  }
}
