export class SqError extends Error {}

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new SqError(message);
  }
}
