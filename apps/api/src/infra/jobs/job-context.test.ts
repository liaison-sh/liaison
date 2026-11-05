// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App job DB-context dispatch (job-context.ts). Pins the fix for the
// quarter-hour social statement timeouts: a `session`-mode job must run with
// NO ambient transaction (nothing pinned, nothing locked across the handler's
// network I/O), while an `atomic`/`ambient` job keeps the whole-run transaction.
import { describe, expect, it } from "bun:test"
import type { ActorContext } from "~/db/rls"
import { dispatchAppJobWithContext, type JobContextDeps } from "~/infra/jobs/job-context"

const systemCtx: ActorContext = {
  actorType: "system",
  orgId: "org-1",
  purpose: "job",
  scopes: ["social:*"],
}

function fakeDeps() {
  const calls: string[] = []
  const deps: JobContextDeps = {
    withRlsContext: async (ctx, fn, opts) => {
      calls.push(`withRlsContext:${ctx.orgId}:${opts?.pool ?? "main"}`)
      return fn({ tag: "live-tx" } as never)
    },
    createRlsSession: (ctx, opts) => {
      calls.push(
        `createRlsSession:${ctx.orgId}:${(opts as { pool?: string } | undefined)?.pool ?? "main"}`,
      )
      return {
        ctx,
        opts,
        run: async (fn) => {
          calls.push("session.run")
          return fn({ tag: "per-call-tx" } as never)
        },
      }
    },
  }
  return { deps, calls }
}

describe("dispatchAppJobWithContext", () => {
  it("session mode: hands the handler an RlsSession and opens NO ambient transaction", async () => {
    const { deps, calls } = fakeDeps()
    let received: Record<string, unknown> | null = null
    await dispatchAppJobWithContext(
      async (payload) => {
        received = payload
      },
      { orgId: "org-1", cursor: "c1" },
      systemCtx,
      "session",
      deps,
    )
    expect(received).not.toBeNull()
    const p = received as unknown as Record<string, unknown>
    expect(p.orgId).toBe("org-1")
    expect(p.cursor).toBe("c1")
    expect(p._tx).toBeUndefined()
    expect(typeof (p._session as { run: unknown }).run).toBe("function")
    // The session rides the background jobs pool; the whole-run wrapper never ran.
    expect(calls).toEqual(["createRlsSession:org-1:jobs"])
    // Each bridge call would open its own short transaction through the session.
    const out = await (
      p._session as { run: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }
    ).run(async (tx) => (tx as { tag: string }).tag)
    expect(out).toBe("per-call-tx")
    expect(calls).toEqual(["createRlsSession:org-1:jobs", "session.run"])
  })

  it("ambient mode (atomic jobs): one whole-run RLS transaction on the jobs pool, handed over as _tx", async () => {
    const { deps, calls } = fakeDeps()
    let received: Record<string, unknown> | null = null
    await dispatchAppJobWithContext(
      async (payload) => {
        received = payload
      },
      { orgId: "org-1" },
      systemCtx,
      "ambient",
      deps,
    )
    const p = received as unknown as Record<string, unknown>
    expect((p._tx as { tag: string }).tag).toBe("live-tx")
    expect(p._session).toBeUndefined()
    expect(calls).toEqual(["withRlsContext:org-1:jobs"])
  })

  it("a handler throw propagates in both modes (BullMQ retry semantics untouched)", async () => {
    const { deps } = fakeDeps()
    for (const mode of ["session", "ambient"] as const) {
      await expect(
        dispatchAppJobWithContext(
          async () => {
            throw new Error(`boom-${mode}`)
          },
          { orgId: "org-1" },
          systemCtx,
          mode,
          deps,
        ),
      ).rejects.toThrow(`boom-${mode}`)
    }
  })
})
