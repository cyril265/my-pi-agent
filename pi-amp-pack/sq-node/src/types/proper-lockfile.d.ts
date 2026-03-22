declare module "proper-lockfile" {
  export interface LockOptions {
    realpath?: boolean;
    retries?:
      | number
      | {
          retries?: number;
          minTimeout?: number;
          maxTimeout?: number;
        };
  }

  export type ReleaseFn = () => Promise<void>;

  export function lock(path: string, options?: LockOptions): Promise<ReleaseFn>;

  const lockfile: {
    lock: typeof lock;
  };

  export default lockfile;
}
