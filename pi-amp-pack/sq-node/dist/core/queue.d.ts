import type { Item, NewItem, UpdateAttrs } from "./types.js";
export declare class Queue {
    readonly filePath: string;
    constructor(filePath: string);
    push(newItem: NewItem): Promise<Item>;
    pushMany(newItems: NewItem[]): Promise<Item[]>;
    all(): Promise<Item[]>;
    find(id: string): Promise<Item | undefined>;
    openIds(): Promise<Set<string>>;
    allWithComputedStatus(): Promise<Item[]>;
    findWithComputedStatus(id: string): Promise<Item | undefined>;
    itemsWithComputedStatus(items: Item[]): Promise<Item[]>;
    itemWithComputedStatus(item: Item): Promise<Item>;
    ready(): Promise<Item[]>;
    update(id: string, attrs: UpdateAttrs): Promise<Item | undefined>;
    close(id: string): Promise<Item | undefined>;
    remove(id: string): Promise<Item | undefined>;
    private ensureDirectory;
    private withExclusiveLock;
    private readItemsUnlocked;
    private rewriteItemsUnlocked;
}
export declare function computedStatus(item: Item, openIds?: Set<string>): Item["status"];
export declare function withComputedStatus(item: Item, openIds?: Set<string>): Item;
export declare function isReady(item: Item, openIds?: Set<string>): boolean;
