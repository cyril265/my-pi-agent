import { deepMerge } from "./lib/utils.js";

export function mergeMetadata(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return deepMerge(current, patch);
}
