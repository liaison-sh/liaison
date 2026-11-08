// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Worker ids a profile may use: `workerIdOffset` to `workerIdOffset +
 * PROFILE_WORKER_SLOTS - 1`, one per worker slot (`parallelIndex`).
 *
 * The id picks the worker's ports, and inside a run namespace the ports wrap
 * at 100 ids (packages/test-helpers/src/test-namespace.ts, `workerPorts`). Two
 * profiles whose ranges meet modulo 100 share ports, and a worker that boots
 * first kills whatever listens on its ports (`createWorkerEnv`): the other
 * file's live server, mid-test. So every profile's range is its own modulo 100,
 * clear of the API runner's workers (0-4) and the shared lanes (10-14);
 * `worker-ids.test.ts` checks it.
 */
export const PROFILE_WORKER_SLOTS = 5
