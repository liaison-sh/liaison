// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One more try for a send whose answer the network lost (S26). Status 0 is a
// network error or a read timeout: the server may have stored the message
// and the answer never came back. The caller's body carries a correlationId
// the server deduplicates on, so sending the SAME body again is applied once.
// Any status from the server (a 4xx refusal, a 5xx) is an answer, never
// retried, except one: a 409 IDEMPOTENT_IN_FLIGHT says the first send is still
// committing on the server. That send is not failed; the same body is asked
// again a little later, and the server replays what it stored (or, when the
// first send failed before its commit, runs it once).
import { ApiError } from "~/lib/api-error"

export const LOST_SEND_RETRY_MS = 1_000
/** The wait before asking again about a send the server says is still committing. */
export const IN_FLIGHT_RETRY_MS = 2_000
/** Bounded: the server's pending key lives 60 s, and each ask waits up to 5 s there. */
export const MAX_IN_FLIGHT_RETRIES = 10

/** The server's code for a duplicate that found the first request still running. */
const IN_FLIGHT_CODE = "IDEMPOTENT_IN_FLIGHT"

function answerLost(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0
}

function stillInFlight(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === IN_FLIGHT_CODE
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function retryLostSend<T>(send: () => Promise<T>): Promise<T> {
  let lostRetried = false
  let inFlightRetries = 0
  for (;;) {
    try {
      return await send()
    } catch (error) {
      if (answerLost(error) && !lostRetried) {
        lostRetried = true
        await wait(LOST_SEND_RETRY_MS)
        continue
      }
      if (stillInFlight(error) && inFlightRetries < MAX_IN_FLIGHT_RETRIES) {
        inFlightRetries++
        await wait(IN_FLIGHT_RETRY_MS)
        continue
      }
      throw error
    }
  }
}
