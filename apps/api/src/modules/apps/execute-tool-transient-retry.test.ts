// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-180: the side-effect-safe transient-DB auto-retry mechanism. A tool that opts
// in (manifest `retryOnTransientDbError`) has a transient write-contention error
// (serialization/deadlock/connection blip) auto-retried with a fresh transaction —
// the aborted txn rolled back atomically, so re-issuing is correct, not a duplicate.
// On exhaustion / when disabled / for a non-transient error, the original error
// propagates (the existing `transient_db_error` retryable envelope is the fallback).
import { describe, expect, it } from "bun:test"
import { runWithTransientRetry } from "~/modules/apps/execute-tool"

// A postgres.js "Failed query" wrapper hanging the real PostgresError (SQL state
// 40001 serialization_failure) off `.cause` — the exact shape isTransientDbError walks.
function transientDbError(): Error {
  const wrapper = new Error("Failed query: insert into app_projects.tasks ...") as Error & {
    cause?: unknown
  }
  wrapper.cause = Object.assign(new Error("could not serialize access due to concurrent update"), {
    code: "40001",
  })
  return wrapper
}

// The same transient shape on a READ query (a SELECT serialization failure / connection
// blip), as `tasks_byProject` hits when a routine tick reads a second project's tasks under
// concurrent chaos-world load — the BL-275 one-project-only failure.
function transientReadDbError(): Error {
  const wrapper = new Error(
    "Failed query: select id, title from app_projects.tasks ...",
  ) as Error & {
    cause?: unknown
  }
  wrapper.cause = Object.assign(new Error("connection terminated unexpectedly"), {
    code: "08006", // connection_failure
  })
  return wrapper
}

describe("runWithTransientRetry (BL-180)", () => {
  it("auto-retries a transient DB error and returns the eventual success when enabled", async () => {
    let calls = 0
    const result = await runWithTransientRetry(
      async () => {
        calls++
        if (calls === 1) throw transientDbError()
        return "ok"
      },
      true,
      "projects__create",
    )
    expect(result).toBe("ok")
    expect(calls).toBe(2)
  })

  it("does NOT retry when the flag is disabled — the transient error propagates", async () => {
    let calls = 0
    await expect(
      runWithTransientRetry(
        async () => {
          calls++
          throw transientDbError()
        },
        false,
        "projects__create",
      ),
    ).rejects.toThrow("Failed query")
    expect(calls).toBe(1)
  })

  it("does NOT retry a NON-transient error even when enabled", async () => {
    let calls = 0
    await expect(
      runWithTransientRetry(
        async () => {
          calls++
          throw new Error("invalid input syntax for type uuid")
        },
        true,
        "projects__create",
      ),
    ).rejects.toThrow("invalid input syntax")
    expect(calls).toBe(1)
  })

  it("gives up after the bounded retries and throws the last transient error", async () => {
    let calls = 0
    await expect(
      runWithTransientRetry(
        async () => {
          calls++
          throw transientDbError()
        },
        true,
        "projects__create",
      ),
    ).rejects.toThrow("Failed query")
    // 1 initial attempt + 2 bounded retries (TRANSIENT_DB_MAX_RETRIES) = 3 calls.
    expect(calls).toBe(3)
  })

  it("auto-retries a transient blip on a READ tool and returns the rows when enabled (BL-275)", async () => {
    // The projects READ tools (tasks_byProject, tasks_byAssignee, search, get, …) now opt into
    // auto-retry: a read has nothing to commit, so re-issuing a transiently-failed SELECT is the
    // SAFEST possible retry (idempotent, no duplicate). Without it, a single blip surfaced as the
    // `transient_db_error` envelope and the weak agent ABANDONED the whole project it was reading
    // (the one-project-only stale-task-sweeper digest the runtime judge failed).
    let calls = 0
    const rows = await runWithTransientRetry(
      async () => {
        calls++
        if (calls === 1) throw transientReadDbError()
        return [{ id: "t1", title: "Stale — Gen-1 delamination defect report" }]
      },
      true,
      "projects__tasks_byProject",
    )
    expect(rows).toEqual([{ id: "t1", title: "Stale — Gen-1 delamination defect report" }])
    expect(calls).toBe(2)
  })

  it("FAILS-WITHOUT: a read blip with the flag OFF propagates the transient error (pre-BL-275)", async () => {
    // Pins the regression: with retry DISABLED (the pre-fix read-tool state), the same transient
    // read blip is NOT retried and reaches the agent — exactly the abandonment the manifest flag fixes.
    let calls = 0
    await expect(
      runWithTransientRetry(
        async () => {
          calls++
          throw transientReadDbError()
        },
        false,
        "projects__tasks_byProject",
      ),
    ).rejects.toThrow("Failed query")
    expect(calls).toBe(1)
  })

  it("does not retry pool-exhaustion (capacity bug, not transient — BL-131)", async () => {
    let calls = 0
    await expect(
      runWithTransientRetry(
        async () => {
          calls++
          throw new Error("remaining connection slots are reserved")
        },
        true,
        "projects__create",
      ),
    ).rejects.toThrow("remaining connection slots")
    expect(calls).toBe(1)
  })
})
