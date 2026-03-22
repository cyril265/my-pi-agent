import { deepMerge } from "./lib/utils.js";
export function mergeMetadata(current, patch) {
    return deepMerge(current, patch);
}
