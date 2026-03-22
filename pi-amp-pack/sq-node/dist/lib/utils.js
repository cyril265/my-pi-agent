import { randomInt } from "node:crypto";
import { VALID_SOURCE_TYPES } from "../core/types.js";
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
export function nowIso8601() {
    return new Date().toISOString();
}
export function generateId(existingIds) {
    while (true) {
        let id = "";
        for (let index = 0; index < 3; index += 1) {
            id += ID_CHARS[randomInt(0, ID_CHARS.length)];
        }
        if (!existingIds.has(id)) {
            return id;
        }
    }
}
export function parsePriorityValue(input) {
    const trimmed = input.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
        throw new Error(`Invalid priority: ${input}. Valid: 0-4`);
    }
    return parsed;
}
export function validateSourceType(type) {
    if (!VALID_SOURCE_TYPES.includes(type)) {
        throw new Error(`Invalid source type: ${type}. Valid: ${VALID_SOURCE_TYPES.join(", ")}`);
    }
}
export function parseJsonObject(input, optionName) {
    let value;
    try {
        value = JSON.parse(input);
    }
    catch (error) {
        throw new Error(`Invalid JSON for ${optionName}: ${error.message}`);
    }
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new Error(`${optionName} must be a JSON object`);
    }
    return value;
}
export function parseBlockedBy(input) {
    if (input === undefined) {
        return [];
    }
    return input
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}
export function deepMerge(current, patch) {
    const output = { ...current };
    for (const [key, patchValue] of Object.entries(patch)) {
        const currentValue = output[key];
        if (isPlainObject(currentValue) && isPlainObject(patchValue)) {
            output[key] = deepMerge(currentValue, patchValue);
            continue;
        }
        output[key] = patchValue;
    }
    return output;
}
function isPlainObject(value) {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}
