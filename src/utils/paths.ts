import { normalizePath } from "obsidian";

export function toPosixPath(path: string): string {
  return normalizePath(path.replace(/\\/g, "/"));
}

export function withinMyDrive(path: string): boolean {
  const normalized = toPosixPath(path).toLowerCase();
  return normalized === "/mydrive" || normalized.startsWith("/mydrive/");
}
