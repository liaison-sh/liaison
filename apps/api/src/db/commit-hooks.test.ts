// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  afterCurrentCommit,
  afterCurrentCommitSucceeds,
  openCommitScope,
  runCommitHooksAfter,
  withinCommitScope,
} from "~/db/commit-hooks"

/** A fake transaction: queues both kinds of hook inside its scope, then commits or rolls back. */
async function transaction(commit: boolean, ran: string[]): Promise<void> {
  const scope = openCommitScope()
  const tx = withinCommitScope(scope, async () => {
    expect(afterCurrentCommit(() => ran.push("always"))).toBe(true)
    expect(afterCurrentCommitSucceeds(() => ran.push("on-commit"))).toBe(true)
    expect(ran).toEqual([])
    if (!commit) throw new Error("rollback")
  })
  runCommitHooksAfter(tx, scope)
  await tx.catch(() => {})
}

describe("commit hooks", () => {
  it("on commit, both kinds run once the transaction has settled", async () => {
    const ran: string[] = []
    await transaction(true, ran)
    expect(ran).toEqual(["always", "on-commit"])
  })

  it("on rollback, a commit-only hook is dropped", async () => {
    const ran: string[] = []
    await transaction(false, ran)
    expect(ran).toEqual(["always"])
  })

  it("outside a transaction scope nothing is queued", () => {
    expect(afterCurrentCommitSucceeds(() => {})).toBe(false)
  })
})
