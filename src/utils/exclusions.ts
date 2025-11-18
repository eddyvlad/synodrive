import { minimatch } from "minimatch";

export function buildMatcher(patterns: string[]): (path: string) => boolean {
  const cleaned = patterns.filter((p) => p.trim().length > 0).map((p) => p.toLowerCase());
  return (path: string) => {
    const lower = path.toLowerCase();
    return cleaned.some((pattern) => minimatch(lower, pattern, { nocase: true, dot: true }));
  };
}
