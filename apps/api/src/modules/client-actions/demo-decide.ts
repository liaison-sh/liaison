// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo decide: a demo workspace's stand-in for a client's decision, beside
// the one decide (`decide.ts`) and never inside it. A demo's clients are
// fictional, so no person can open the link and answer; a guided scenario still
// needs the client's answer to reach the app that sent the link, through the
// app's own handler, exactly as a real one would.
//
// What it refuses: a workspace that is not a visitor demo (the reserved review
// workspace included), a box not in demo mode, a row whose target is not the one
// its caller names (the kernel names no app), a row that is not open, and a
// document whose fingerprint moved since the link was made. What it writes,
// under the row's lock: the decision, with the exact guarded WHERE of the one
// decide, `decided_via 'link'` (the value a demo's stand-in decisions carry), the
// invited name as typed, no capacity and no code; the action's event as the
// system, marked `demo`; and the decided event, through the one decide's queue
// helper. It takes no id from any request: its caller resolves the action itself
// in the caller's own workspace. No tool, route or app reaches it: its one
// importer is a demo world's step (`no-agent-sign.guard.test.ts`).
//
// It signs nothing and seals nothing. The caller writes the stand-in signature
// event first, so the app's handler finds a `demo` record and seals none.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { isVisitorDemoOrgId } from "~/modules/demo/demo-org"
import { type ActionRow, frameOf, fromRows, queueDecidedEvent, ROW_COLUMNS, viewOf } from "./decide"
import { writeClientActionEvent } from "./events"
import type { ClientActionKind } from "./targets"

const K = () => sql.raw(schemaRef("kernel"))

const DECISION_OF: Record<ClientActionKind, "signed" | "accepted" | "approved"> = {
  sign: "signed",
  accept: "accepted",
  approve: "approved",
}

export interface DemoDecideInput {
  orgId: string
  actionId: string
  /** The app and type the caller expects the action to be about: anything else is refused. */
  target: { app: string; type: string }
}

export type DemoDecideRefusal =
  | "DEMO_DECIDE_NOT_DEMO"
  | "DEMO_DECIDE_NOT_DEMO_BOX"
  | "DEMO_DECIDE_NOT_FOUND"
  | "DEMO_DECIDE_OTHER_TARGET"
  | "DEMO_DECIDE_NOT_OPEN"
  | "DEMO_DECIDE_VERSION_CHANGED"
  | "DEMO_DECIDE_UNAVAILABLE"

export type DemoDecideOutcome =
  | { ok: true; actionId: string; decision: "signed" | "accepted" | "approved" }
  | { ok: false; code: DemoDecideRefusal; message: string }

function refused(code: DemoDecideRefusal, message: string): DemoDecideOutcome {
  return { ok: false, code, message }
}

async function readRow(orgId: string, actionId: string): Promise<ActionRow | null> {
  return withPrivilegedDb(orgId, "client-action-demo-read", async (tx) =>
    fromRows(
      extractRows<ActionRow>(
        await tx.execute(sql`
          SELECT ${ROW_COLUMNS}
            FROM ${K()}.client_actions a
            JOIN ${K()}.organizations o ON o.id = a.org_id
            LEFT JOIN ${K()}.users u ON u.id = a.created_by_user_id AND u.org_id = a.org_id
            LEFT JOIN ${K()}.companies c ON c.id = a.company_id AND c.org_id = a.org_id
           WHERE a.id = ${actionId} AND a.org_id = ${orgId}
        `),
      ),
    ),
  )
}

/** Record a demo client's stand-in decision on one open action. See the file's head. */
export async function decideDemoClientAction(input: DemoDecideInput): Promise<DemoDecideOutcome> {
  const { orgId, actionId } = input
  if (!isDemoModeEnabled()) {
    return refused(
      "DEMO_DECIDE_NOT_DEMO_BOX",
      "This server is not a demo server: no stand-in decision is recorded. Nothing was decided.",
    )
  }
  if (!(await isVisitorDemoOrgId(orgId))) {
    return refused(
      "DEMO_DECIDE_NOT_DEMO",
      "This workspace is not a visitor's demo workspace: no stand-in decision is recorded. Nothing was decided.",
    )
  }
  const pre = await readRow(orgId, actionId)
  if (!pre) {
    return refused(
      "DEMO_DECIDE_NOT_FOUND",
      `No client action ${actionId} in this workspace. Nothing was decided.`,
    )
  }
  if (pre.target_app !== input.target.app || pre.target_type !== input.target.type) {
    return refused(
      "DEMO_DECIDE_OTHER_TARGET",
      `Client action ${actionId} is about ${pre.target_app}.${pre.target_type}, not ${input.target.app}.${input.target.type}. Nothing was decided.`,
    )
  }
  // Asked before the transaction, as the one decide does: no lock is held while an app answers.
  const view = await viewOf(pre)
  if (view === "down") {
    return refused(
      "DEMO_DECIDE_UNAVAILABLE",
      `The document of client action ${actionId} cannot be read right now. Nothing was decided; try again.`,
    )
  }
  return withPrivilegedDb(orgId, "client-action-demo-decide", async (tx) => {
    const row = fromRows(
      extractRows<ActionRow>(
        await tx.execute(sql`
          SELECT ${ROW_COLUMNS}
            FROM ${K()}.client_actions a
            JOIN ${K()}.organizations o ON o.id = a.org_id
            LEFT JOIN ${K()}.users u ON u.id = a.created_by_user_id AND u.org_id = a.org_id
            LEFT JOIN ${K()}.companies c ON c.id = a.company_id AND c.org_id = a.org_id
           WHERE a.id = ${actionId} AND a.org_id = ${orgId}
           FOR UPDATE OF a
        `),
      ),
    )
    if (!row) {
      return refused(
        "DEMO_DECIDE_NOT_FOUND",
        `No client action ${actionId} in this workspace. Nothing was decided.`,
      )
    }
    const frame = frameOf(row, "current")
    if (frame !== "open") {
      return refused(
        "DEMO_DECIDE_NOT_OPEN",
        `Client action ${actionId} is ${frame}, not open: nothing more was decided.`,
      )
    }
    if (
      view.sha256 !== row.target_sha256 ||
      (row.target_blocks_sha256 !== null &&
        (view.blocksSha256 ?? null) !== row.target_blocks_sha256)
    ) {
      return refused(
        "DEMO_DECIDE_VERSION_CHANGED",
        `The document of client action ${actionId} changed since its link was made. Nothing was decided.`,
      )
    }
    const decision = DECISION_OF[row.kind]
    const updated = extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.client_actions
           SET decided_at = now(), decision = ${decision}, decided_via = 'link',
               typed_name = ${row.invited_name}
         WHERE id = ${actionId} AND decided_at IS NULL AND revoked_at IS NULL
           AND expires_at > now() AND code_locked_at IS NULL
         RETURNING id
      `),
    )
    if (updated.length === 0) {
      return refused(
        "DEMO_DECIDE_NOT_OPEN",
        `Client action ${actionId} was decided or closed meanwhile: nothing more was decided.`,
      )
    }
    await writeClientActionEvent(tx, {
      orgId,
      actionId,
      event: "decided",
      actorKind: "system",
      meta: { decision, via: "link", demo: true },
    })
    await queueDecidedEvent(tx, row, { decision, via: "link", title: view.title })
    return { ok: true as const, actionId, decision }
  })
}
