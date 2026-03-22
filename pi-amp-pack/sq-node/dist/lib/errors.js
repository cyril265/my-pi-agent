export class SqError extends Error {
}
export function ensure(condition, message) {
    if (!condition) {
        throw new SqError(message);
    }
}
