export declare const VALID_STATUSES: readonly ["pending", "in_progress", "closed"];
export declare const VALID_DISPLAY_STATUSES: readonly ["pending", "blocked", "in_progress", "closed"];
export declare const VALID_SOURCE_TYPES: readonly ["diff", "file", "text", "directory"];
export type PersistedStatus = (typeof VALID_STATUSES)[number];
export type DisplayStatus = (typeof VALID_DISPLAY_STATUSES)[number];
export type SourceType = (typeof VALID_SOURCE_TYPES)[number];
export interface Source {
    type: SourceType;
    path?: string;
    content?: string;
}
export interface Item {
    id: string;
    title?: string;
    description?: string;
    status: PersistedStatus | DisplayStatus;
    priority?: number;
    sources: Source[];
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    blocked_by?: string[];
    errors?: unknown[];
}
export interface NewItem {
    sources: Source[];
    title?: string;
    description?: string;
    priority?: number;
    metadata: Record<string, unknown>;
    blocked_by: string[];
}
export interface UpdateAttrs {
    status?: PersistedStatus;
    title?: string;
    description?: string;
    priority?: number | null;
    metadata?: Record<string, unknown>;
    blocked_by?: string[];
    sources?: Source[];
}
