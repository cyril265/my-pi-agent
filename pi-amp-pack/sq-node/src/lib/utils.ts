import { randomInt } from "node:crypto";
import { VALID_SOURCE_TYPES } from "../core/types.js";

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function nowIso8601(): string {
  return new Date().toISOString();
}

export function generateId(existingIds: Set<string>): string {
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

export function parsePriorityValue(input: string): number {
  const trimmed = input.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
    throw new Error(`Invalid priority: ${input}. Valid: 0-4`);
  }
  return parsed;
}

export function validateSourceType(
  type: string,
): asserts type is (typeof VALID_SOURCE_TYPES)[number] {
  if (!VALID_SOURCE_TYPES.includes(type as (typeof VALID_SOURCE_TYPES)[number])) {
    throw new Error(
      `Invalid source type: ${type}. Valid: ${VALID_SOURCE_TYPES.join(", ")}`,
    );
  }
}

export function parseJsonObject(input: string, optionName: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new Error(`Invalid JSON for ${optionName}: ${(error as Error).message}`);
  }

  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${optionName} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

export function parseBlockedBy(input: string | undefined): string[] {
  if (input === undefined) {
    return [];
  }

  return input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function deepMerge(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...current };

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
