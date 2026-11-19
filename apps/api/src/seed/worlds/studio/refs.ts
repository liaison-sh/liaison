/**
 * The studio's idempotency keys, in a module with no imports: the world's live beats read them
 * while the seed layer may still be loading, so they cannot sit in the layer itself.
 */

/** A task's or a deal's idempotency key. */
export const studioTaskRef = (key: string) => `demo:studio:task:${key}`
