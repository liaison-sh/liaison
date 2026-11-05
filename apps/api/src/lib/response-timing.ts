// SPDX-License-Identifier: FSL-1.1-ALv2
import { env } from "~/lib/env"

/**
 * Hold a response back until at least `AUTH_ENUMERATION_FLOOR_MS` after `startedAt`.
 *
 * An endpoint that answers every address identically but does more work for a real
 * account (a database write, a template render) still answers a few milliseconds
 * later, and a patient caller can measure that. Padding every answer to one floor
 * above the slowest honest path removes the difference. Mail delivery itself is not
 * awaited on these paths, so the floor only has to cover local work.
 */
export async function padToResponseFloor(
  startedAt: number,
  floorMs: number = env.AUTH_ENUMERATION_FLOOR_MS,
): Promise<void> {
  const remaining = floorMs - (performance.now() - startedAt)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
}
