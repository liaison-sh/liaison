// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { describeDbError, isTransientDbError, retryOnTransientDbError } from "./transient-db-error"

// postgres.js wraps the driver error as `Failed query: <sql>` and hangs the real
// PostgresError off `.cause` (with the SQL state on `.code`). Mirror that shape.
function failedQuery(cause: { code?: string; message: string }): Error {
  const e = new Error(`Failed query: INSERT INTO app_projects.tasks ...`) as Error & {
    cause?: unknown
  }
  e.cause = Object.assign(new Error(cause.message), cause.code ? { code: cause.code } : {})
  return e
}

describe("isTransientDbError", () => {
  it("detects serialization_failure (40001) via the cause chain", () => {
    expect(
      isTransientDbError(failedQuery({ code: "40001", message: "could not serialize access" })),
    ).toBe(true)
  })

  it("detects deadlock_detected (40P01)", () => {
    expect(isTransientDbError(failedQuery({ code: "40P01", message: "deadlock detected" }))).toBe(
      true,
    )
  })

  it("detects connection-class errors (08006)", () => {
    expect(isTransientDbError(failedQuery({ code: "08006", message: "connection failure" }))).toBe(
      true,
    )
  })

  it("detects a transient signature by MESSAGE when no SQL state is present (connection-layer error)", () => {
    expect(isTransientDbError(new Error("write CONNECTION_ENDED: connection ended"))).toBe(true)
    expect(isTransientDbError(failedQuery({ message: "deadlock detected" }))).toBe(true)
  })

  it("does NOT classify connection-POOL exhaustion as transient (capacity bug, not to be masked)", () => {
    expect(
      isTransientDbError(failedQuery({ code: "53300", message: "too many clients already" })),
    ).toBe(false)
    expect(isTransientDbError(new Error("db pool acquire timed out"))).toBe(false)
    expect(isTransientDbError(new Error("remaining connection slots are reserved"))).toBe(false)
  })

  it("does NOT classify a normal constraint violation (23505) or a generic error as transient", () => {
    expect(isTransientDbError(failedQuery({ code: "23505", message: "duplicate key value" }))).toBe(
      false,
    )
    expect(isTransientDbError(new Error("something unrelated"))).toBe(false)
    expect(isTransientDbError(null)).toBe(false)
  })

  it("bails out of a chain that contains BOTH a transient code AND pool exhaustion → not retryable", () => {
    // Pool exhaustion seen first in the chain wins (don't mask capacity).
    const e = new Error("db pool acquire timed out") as Error & { cause?: unknown }
    e.cause = Object.assign(new Error("deadlock detected"), { code: "40P01" })
    expect(isTransientDbError(e)).toBe(false)
  })
})

describe("describeDbError", () => {
  it("pulls the SQL-state code + message out of the postgres.js 'Failed query' wrapper", () => {
    const d = describeDbError(failedQuery({ code: "40P01", message: "deadlock detected" }))
    expect(d.code).toBe("40P01")
    expect(d.message).toBe("deadlock detected")
  })
})

describe("retryOnTransientDbError", () => {
  const noDelay = () => 0

  it("re-runs the operation after a deadlock (40P01) and returns its result", async () => {
    let calls = 0
    const retried: Array<{ attempt: number; code: string | null }> = []
    const result = await retryOnTransientDbError(
      async () => {
        calls++
        if (calls === 1) throw failedQuery({ code: "40P01", message: "deadlock detected" })
        return "written"
      },
      { retries: 3, delayMs: noDelay, onRetry: (info) => retried.push(info) },
    )
    expect(result).toBe("written")
    expect(calls).toBe(2)
    expect(retried).toEqual([expect.objectContaining({ attempt: 1, code: "40P01" })])
  })

  it("retries a serialization failure (40001) too", async () => {
    let calls = 0
    await retryOnTransientDbError(
      async () => {
        calls++
        if (calls < 3) throw failedQuery({ code: "40001", message: "could not serialize access" })
      },
      { retries: 3, delayMs: noDelay },
    )
    expect(calls).toBe(3)
  })

  it("rethrows the last transient error once the retries are spent", async () => {
    let calls = 0
    const err = failedQuery({ code: "40P01", message: "deadlock detected" })
    await expect(
      retryOnTransientDbError(
        async () => {
          calls++
          throw err
        },
        { retries: 2, delayMs: noDelay },
      ),
    ).rejects.toBe(err)
    expect(calls).toBe(3)
  })

  it("never retries a non-transient error", async () => {
    let calls = 0
    await expect(
      retryOnTransientDbError(
        async () => {
          calls++
          throw failedQuery({ code: "23505", message: "duplicate key value" })
        },
        { retries: 3, delayMs: noDelay },
      ),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it("waits the delay the caller computes for each attempt", async () => {
    const asked: number[] = []
    let calls = 0
    await retryOnTransientDbError(
      async () => {
        calls++
        if (calls < 3) throw failedQuery({ code: "40P01", message: "deadlock detected" })
      },
      {
        retries: 3,
        delayMs: (attempt) => {
          asked.push(attempt)
          return 1
        },
      },
    )
    expect(asked).toEqual([1, 2])
  })
})
