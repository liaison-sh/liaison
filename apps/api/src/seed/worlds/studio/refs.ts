// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * The studio's idempotency keys, in a module with no imports: the world's live beats read them
 * while the seed layer may still be loading, so they cannot sit in the layer itself.
 */

/** A task's or a deal's idempotency key. */
export const studioTaskRef = (key: string) => `demo:studio:task:${key}`

/**
 * The sales pipeline's project name: the seed names it, and the sales routine's prompt cites it
 * for `projects__create` (a name the model shortened to "Sales" matched no project).
 */
export const STUDIO_PIPELINE_NAME = "Sales pipeline"
