import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { SqError } from "../lib/errors.js";
import { generateId, nowIso8601, validateSourceType } from "../lib/utils.js";
import type { Item, NewItem, Source, UpdateAttrs } from "./types.js";

export class Queue {
  constructor(public readonly filePath: string) {}

  async push(newItem: NewItem): Promise<Item> {
    const created = await this.pushMany([newItem]);
    return created[0];
  }

  async pushMany(newItems: NewItem[]): Promise<Item[]> {
    if (newItems.length === 0) {
      throw new SqError("At least one item is required");
    }

    for (const item of newItems) {
      validateNewItem(item);
    }

    return this.withExclusiveLock(async () => {
      const existing = await this.readItemsUnlocked();
      const existingIds = new Set(existing.map((item) => item.id));
      const timestamp = nowIso8601();
      const created: Item[] = [];

      for (const newItem of newItems) {
        const item: Item = {
          id: generateId(existingIds),
          title: newItem.title,
          description: newItem.description,
          status: "pending",
          priority: newItem.priority,
          sources: newItem.sources,
          metadata: newItem.metadata,
          created_at: timestamp,
          updated_at: timestamp,
          blocked_by: newItem.blocked_by.length > 0 ? newItem.blocked_by : undefined,
          errors: undefined,
        };
        existingIds.add(item.id);
        existing.push(item);
        created.push(item);
      }

      await this.rewriteItemsUnlocked(existing);
      return created;
    });
  }

  async all(): Promise<Item[]> {
    try {
      return await this.readItemsUnlocked();
    } catch {
      return [];
    }
  }

  async find(id: string): Promise<Item | undefined> {
    const items = await this.all();
    return items.find((item) => item.id === id);
  }

  async openIds(): Promise<Set<string>> {
    const items = await this.all();
    return openIdsForItems(items);
  }

  async allWithComputedStatus(): Promise<Item[]> {
    const items = await this.all();
    const openIds = openIdsForItems(items);
    return items.map((item) => withComputedStatus(item, openIds));
  }

  async findWithComputedStatus(id: string): Promise<Item | undefined> {
    const items = await this.all();
    const openIds = openIdsForItems(items);
    const item = items.find((entry) => entry.id === id);
    return item ? withComputedStatus(item, openIds) : undefined;
  }

  async itemsWithComputedStatus(items: Item[]): Promise<Item[]> {
    const openIds = await this.openIds();
    return items.map((item) => withComputedStatus(item, openIds));
  }

  async itemWithComputedStatus(item: Item): Promise<Item> {
    const openIds = await this.openIds();
    return withComputedStatus(item, openIds);
  }

  async ready(): Promise<Item[]> {
    const items = await this.all();
    const openIds = openIdsForItems(items);
    return items.filter((item) => isReady(item, openIds));
  }

  async update(id: string, attrs: UpdateAttrs): Promise<Item | undefined> {
    return this.withExclusiveLock(async () => {
      const items = await this.readItemsUnlocked();
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) {
        return undefined;
      }

      const item = { ...items[index] };
      const original = JSON.stringify(normalizeItem(items[index]));

      if (attrs.status !== undefined) {
        item.status = attrs.status;
      }
      if (attrs.title !== undefined) {
        item.title = attrs.title;
      }
      if (attrs.description !== undefined) {
        item.description = attrs.description;
      }
      if (attrs.priority !== undefined) {
        if (attrs.priority !== null && (attrs.priority < 0 || attrs.priority > 4)) {
          throw new SqError(`Invalid priority: ${attrs.priority}. Valid: 0-4`);
        }
        item.priority = attrs.priority ?? undefined;
      }
      if (attrs.metadata !== undefined) {
        item.metadata = attrs.metadata;
      }
      if (attrs.blocked_by !== undefined) {
        validateBlockedBy(id, attrs.blocked_by);
        item.blocked_by = attrs.blocked_by.length > 0 ? attrs.blocked_by : undefined;
      }
      if (attrs.sources !== undefined) {
        for (const source of attrs.sources) {
          validateSourceType(source.type);
        }
        item.sources = attrs.sources;
      }

      if (JSON.stringify(normalizeItem(item)) === original) {
        return items[index];
      }

      item.updated_at = nowIso8601();
      items[index] = item;
      await this.rewriteItemsUnlocked(items);
      return item;
    });
  }

  async close(id: string): Promise<Item | undefined> {
    return this.update(id, { status: "closed" });
  }

  async remove(id: string): Promise<Item | undefined> {
    return this.withExclusiveLock(async () => {
      const items = await this.readItemsUnlocked();
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) {
        return undefined;
      }

      const [removed] = items.splice(index, 1);
      await this.rewriteItemsUnlocked(items);
      return removed;
    });
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  private async withExclusiveLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const handle = await fs.open(this.filePath, "a+");
    await handle.close();

    const release = await lockfile.lock(this.filePath, {
      realpath: false,
      retries: {
        retries: 10,
        minTimeout: 20,
        maxTimeout: 100,
      },
    });

    try {
      return await callback();
    } finally {
      await release();
    }
  }

  private async readItemsUnlocked(): Promise<Item[]> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      return readItems(content, this.filePath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async rewriteItemsUnlocked(items: Item[]): Promise<void> {
    const lines = items.map((item) => JSON.stringify(normalizeItem(item)));
    const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    await fs.writeFile(this.filePath, content, "utf8");
  }
}

export function computedStatus(item: Item, openIds?: Set<string>): Item["status"] {
  if (item.status !== "pending") {
    return item.status;
  }

  const blockedBy = item.blocked_by ?? [];
  if (blockedBy.length === 0) {
    return item.status;
  }

  if (openIds === undefined) {
    return "blocked";
  }

  return blockedBy.some((id) => openIds.has(id)) ? "blocked" : "pending";
}

export function withComputedStatus(item: Item, openIds?: Set<string>): Item {
  return {
    ...item,
    status: computedStatus(item, openIds),
  };
}

export function isReady(item: Item, openIds?: Set<string>): boolean {
  if (item.status !== "pending") {
    return false;
  }
  const blockedBy = item.blocked_by ?? [];
  if (blockedBy.length === 0) {
    return true;
  }
  if (openIds === undefined) {
    return true;
  }
  return blockedBy.every((id) => !openIds.has(id));
}

function openIdsForItems(items: Item[]): Set<string> {
  return new Set(items.filter((item) => item.status !== "closed").map((item) => item.id));
}

function validateNewItem(item: NewItem): void {
  if (
    item.sources.length === 0 &&
    item.title === undefined &&
    item.description === undefined
  ) {
    throw new SqError("Item requires at least one source, title, or description");
  }

  if (item.priority !== undefined && (item.priority < 0 || item.priority > 4)) {
    throw new SqError(`Invalid priority: ${item.priority}. Valid: 0-4`);
  }

  validateBlockedBy(undefined, item.blocked_by);
  for (const source of item.sources) {
    validateSourceType(source.type);
  }
}

function validateBlockedBy(itemId: string | undefined, blockedBy: string[]): void {
  if (itemId !== undefined && blockedBy.some((blockerId) => blockerId === itemId)) {
    throw new SqError(`Item cannot block itself: ${itemId}`);
  }
}

function readItems(content: string, filePath: string): Item[] {
  const items: Item[] = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    try {
      items.push(parseItem(JSON.parse(line)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Warning: Skipping corrupt line ${index + 1} in ${filePath}: ${message}`);
    }
  }
  return items;
}

function parseItem(value: unknown): Item {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("item is not an object");
  }

  const item = value as Record<string, unknown>;
  const sources = Array.isArray(item.sources) ? item.sources.map(parseSource) : [];
  const metadata =
    item.metadata !== null &&
    typeof item.metadata === "object" &&
    !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, unknown>)
      : {};

  return normalizeItem({
    id: String(item.id),
    title: asOptionalString(item.title),
    description: asOptionalString(item.description),
    status: String(item.status) as Item["status"],
    priority: typeof item.priority === "number" ? item.priority : undefined,
    sources,
    metadata,
    created_at: String(item.created_at),
    updated_at: String(item.updated_at),
    blocked_by: Array.isArray(item.blocked_by)
      ? item.blocked_by.map((entry) => String(entry))
      : undefined,
    errors: Array.isArray(item.errors) ? item.errors : undefined,
  });
}

function parseSource(value: unknown): Source {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source is not an object");
  }

  const source = value as Record<string, unknown>;
  return {
    type: String(source.type) as Source["type"],
    path: asOptionalString(source.path),
    content: asOptionalString(source.content),
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeItem(item: Item): Item {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    status: item.status,
    priority: item.priority,
    sources: item.sources.map((source) => ({
      type: source.type,
      path: source.path,
      content: source.content,
    })),
    metadata: item.metadata ?? {},
    created_at: item.created_at,
    updated_at: item.updated_at,
    blocked_by: item.blocked_by && item.blocked_by.length > 0 ? item.blocked_by : undefined,
    errors: item.errors && item.errors.length > 0 ? item.errors : undefined,
  };
}
