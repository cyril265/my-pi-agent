export interface ResolveQueuePathOptions {
    cwd?: string;
    queuePathOverride?: string;
    env?: NodeJS.ProcessEnv;
}
export declare function resolveQueuePath(options?: ResolveQueuePathOptions): string;
