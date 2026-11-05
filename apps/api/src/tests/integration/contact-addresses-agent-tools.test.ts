// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CONTACT ADDRESS IS VERIFIED ONLY BY A PERSON.
//
// `kernel:contacts_address_verify` is gated and noAutoApprove: an agent's call
// parks a card that shows the full address, the source, the note and a link to
// the source file, and nothing is verified until a person approves it; the
// approver is then the verifier. No auto-approve policy answers it (not
// `kernel:*`, not one naming the tool), and an app's declared cross-app call
// into it parks too (no capability arm). `contacts_address_upsert` is gated
// like contacts_write (a `kernel:*` policy runs it) and always stores the
// address NOT verified. Driven through the real chat seam (buildToolSet's
// execute closure, then executeToolCore) with the real handlers.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { autoApprovePolicies, files } from "~/db/schema/kernel"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { decideApproval } from "~/modules/approvals/decide"
import {
  agentInstructionsRegistry,
  appCrossAppCallsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { addAddress } from "~/modules/contacts/addresses"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let ORG = ""
let ADMIN = ""
let DM = ""
let CONTACT = ""
let ADDRESS = ""
let FILE = ""
let FOREIGN_FILE = ""
const CALLER_APP = "address-test-shipper"

let actor: UserContext

/** An auto-approve policy on `toolName`, written the way the policy tool stores it. */
async function autoApprove(toolName: string): Promise<void> {
  await withPrivilegedDb(ORG, "test:auto-approve-policy", (tx) =>
    tx.insert(autoApprovePolicies).values({ orgId: ORG, toolName, createdBy: ADMIN }),
  )
}

/** A stored file row (no bytes needed: only its visibility is read). */
async function fileRow(orgId: string, threadId: string, filename: string, by: string | null) {
  const id = crypto.randomUUID()
  await withPrivilegedDb(orgId, "test:file-row", (tx) =>
    tx.insert(files).values({
      id,
      orgId,
      app: "kernel",
      entityType: "thread",
      entityId: threadId,
      filename,
      mimeType: "application/pdf",
      sizeBytes: 10,
      storageKey: `test/${id}`,
      uploadedBy: by,
    }),
  )
  return id
}

function turnFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

async function agentCall(
  sdkName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const frame = turnFrame()
  const tools = buildToolSet(ORG, actor, DM, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

interface AddressRow {
  street1: string | null
  verified_at: Date | null
  verified_by: string | null
  source: string | null
  source_note: string | null
  source_file_id: string | null
}

async function address(id = ADDRESS): Promise<AddressRow | undefined> {
  const [row] = await sql<AddressRow[]>`
    SELECT street1, verified_at, verified_by::text, source, source_note, source_file_id::text
      FROM kernel.contact_addresses WHERE id = ${id}`
  return row
}

async function resetAddress(): Promise<void> {
  await sql`UPDATE kernel.contact_addresses
     SET verified_at = NULL, verified_by = NULL, source = NULL, source_note = NULL,
         source_file_id = NULL
   WHERE id = ${ADDRESS}`
  await sql`UPDATE kernel.approval_requests SET status = 'denied'
   WHERE org_id = ${ORG} AND status = 'pending'`
}

async function pendingVerify(): Promise<
  { id: string; summary: { title: string; lines: string[]; links?: unknown[] } }[]
> {
  return sql`
    SELECT id::text, summary FROM kernel.approval_requests
     WHERE org_id = ${ORG} AND tool_name = 'kernel:contacts_address_verify' AND status = 'pending'
     ORDER BY created_at DESC`
}

const verifyArgs = () => ({
  contactId: CONTACT,
  addressId: ADDRESS,
  source: "purchase_order",
  note: "PO 4512 ship-to",
  fileId: FILE,
})

describe("contact addresses: verification only through a person", () => {
  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    ADMIN = (await minimal.orgAdmin(ORG)).id
    actor = { actorType: "user", userId: ADMIN, orgId: ORG, scopes: ["*"], dimensionGrants: {} }
    DM = await minimal.thread(ORG, ADMIN, { title: "Addresses" })
    CONTACT = await minimal.contact(ORG, "ines@example.com", { name: "Ines Laurent" })
    const { address: added } = await withRlsContext(actor, (tx) =>
      addAddress(tx, {
        orgId: ORG,
        userId: ADMIN,
        contactId: CONTACT,
        origin: "legacy_metadata",
        fields: {
          role: "delivery",
          company: "Laurent Audio",
          street1: "12 rue des Lilas",
          city: "Lyon",
          postalCode: "69003",
          countryIso2: "FR",
        },
      }),
    )
    ADDRESS = added.id
    // The purchase order, attached to the conversation (readable), and a file of another
    // organisation (never readable here).
    FILE = await fileRow(ORG, DM, "PO-4512.pdf", ADMIN)
    const other = await minimal.secondOrg({ name: "Address Other Org" })
    FOREIGN_FILE = await fileRow(other.orgId, crypto.randomUUID(), "elsewhere.pdf", null)
    await ensureAppsForOrg(ORG)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    appCrossAppCallsRegistry.delete([ORG, CALLER_APP])
    initializedOrgRuntimes.delete(ORG)
    await releaseTestLock()
  })

  it("is registered gated and noAutoApprove, with a summarizer; the list is read only", async () => {
    const verify = toolRegistry.get([ORG, "kernel", "contacts_address_verify"])
    expect(verify?.gated).toBe(true)
    expect(verify?.noAutoApprove).toBe(true)
    expect(verify?.trustBoundary).toBe("user")
    expect(verify?.description).toContain("Never verify from an email alone")
    expect(toolRegistry.get([ORG, "kernel", "contacts_addresses_list"])?.readOnly).toBe(true)
    expect(toolRegistry.get([ORG, "kernel", "contacts_address_upsert"])?.gated).toBe(true)
  })

  it("an agent's verify parks a card with the full address, the source, the note and the file", async () => {
    const res = await agentCall("kernel__contacts_address_verify", verifyArgs())
    expect(res).toMatchObject({ blocked: true, status: "pending_approval" })
    expect((await address())?.verified_at).toBeNull()
    const [req] = await pendingVerify()
    expect(req?.summary.title).toBe(
      "Mark an address of Ines Laurent <ines@example.com> as verified",
    )
    expect(req?.summary.lines).toContain("Address: Laurent Audio, 12 rue des Lilas, 69003 Lyon, FR")
    expect(req?.summary.lines).toContain("Checked against: a purchase order")
    expect(req?.summary.lines).toContain("Note: PO 4512 ship-to")
    expect(req?.summary.lines).toContain("Source file: PO-4512.pdf")
    expect(req?.summary.links).toContainEqual({
      label: "Open source file",
      app: "kernel",
      entityType: "file",
      entityId: FILE,
    })
  })

  it("approving the card verifies the address, recording the approver and the source", async () => {
    const [req] = await pendingVerify()
    await decideApproval({
      orgId: ORG,
      requestId: req!.id,
      actor: { ...actor, scopes: ["*", "kernel:approve"] },
      decision: "approve",
    })
    const row = await address()
    expect(row?.verified_at).not.toBeNull()
    expect(row?.verified_by).toBe(ADMIN)
    expect(row?.source).toBe("purchase_order")
    expect(row?.source_note).toBe("PO 4512 ship-to")
    expect(row?.source_file_id).toBe(FILE)
  })

  it("an auto-approve policy on kernel:* does NOT skip it (and does run the upsert)", async () => {
    await resetAddress()
    await autoApprove("kernel:*")
    const res = await agentCall("kernel__contacts_address_verify", verifyArgs())
    expect(res).toMatchObject({ blocked: true, status: "pending_approval" })
    expect((await address())?.verified_at).toBeNull()

    // The same policy runs the upsert at once, and what it stores is not verified.
    const added = await agentCall("kernel__contacts_address_upsert", {
      contactId: CONTACT,
      role: "billing",
      company: "Laurent Audio",
      street1: "1 place Bellecour",
      city: "Lyon",
      postalCode: "69002",
      countryIso2: "fr",
    })
    expect(added.blocked).toBeUndefined()
    const [billing] = await sql<{ verified_at: Date | null; country_iso2: string }[]>`
      SELECT verified_at, country_iso2 FROM kernel.contact_addresses
       WHERE org_id = ${ORG} AND role = 'billing'`
    expect(billing?.verified_at).toBeNull()
    expect(billing?.country_iso2).toBe("FR")
  })

  it("a policy naming the tool does not skip it either", async () => {
    await resetAddress()
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    await autoApprove("kernel:contacts_address_verify")
    const res = await agentCall("kernel__contacts_address_verify", verifyArgs())
    expect(res).toMatchObject({ blocked: true, status: "pending_approval" })
    expect((await address())?.verified_at).toBeNull()
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
  })

  it("an app's declared cross-app call to verify parks, from a webhook or a person's click", async () => {
    await resetAddress()
    appCrossAppCallsRegistry.set([ORG, CALLER_APP], {
      targets: ["kernel:contacts_address_verify"],
    })
    for (const humanAuthorized of [false, true]) {
      const res = await executeToolCore({
        toolName: "kernel:contacts_address_verify",
        orgId: ORG,
        actor,
        params: verifyArgs(),
        origin: "system",
        threadId: DM,
        internalCall: { callerApp: CALLER_APP, humanAuthorized },
        callChain: [`${CALLER_APP}:sync`],
      })
      // Parked for a person: no capability arm (machine or human-authorized) runs it.
      expect("blocked" in res).toBe(true)
      expect((await address())?.verified_at).toBeNull()
    }
  })

  it("a person's own direct call verifies at once, as that person", async () => {
    await resetAddress()
    const res = await executeToolCore({
      toolName: "kernel:contacts_address_verify",
      orgId: ORG,
      actor,
      params: { contactId: CONTACT, addressId: ADDRESS, source: "phone_call" },
      origin: "human-ui",
    })
    expect("data" in res).toBe(true)
    const row = await address()
    expect(row?.verified_by).toBe(ADMIN)
    expect(row?.source).toBe("phone_call")
  })

  it("an agent's edit of a verified address makes it not verified (after approval)", async () => {
    const res = await agentCall("kernel__contacts_address_upsert", {
      contactId: CONTACT,
      addressId: ADDRESS,
      street1: "14 rue des Lilas",
    })
    expect(res).toMatchObject({ blocked: true, status: "pending_approval" })
    const [req] = await sql<{ id: string; summary: { lines: string[] } }[]>`
      SELECT id::text, summary FROM kernel.approval_requests
       WHERE org_id = ${ORG} AND tool_name = 'kernel:contacts_address_upsert' AND status = 'pending'`
    expect(req?.summary.lines).toContain(
      "This address is verified: saving the change makes it NOT verified again.",
    )
    await decideApproval({
      orgId: ORG,
      requestId: req!.id,
      actor: { ...actor, scopes: ["*", "kernel:approve"] },
      decision: "approve",
    })
    const row = await address()
    expect(row?.street1).toBe("14 rue des Lilas")
    expect(row?.verified_at).toBeNull()
    expect(row?.verified_by).toBeNull()
    expect(row?.source).toBeNull()
  })

  it("a source file the caller cannot read is refused before anything parks", async () => {
    await resetAddress()
    const before = (await pendingVerify()).length
    const res = await agentCall("kernel__contacts_address_verify", {
      ...verifyArgs(),
      fileId: FOREIGN_FILE,
    })
    expect(JSON.stringify(res)).toContain("The source file was not found, or you cannot read it")
    expect((await pendingVerify()).length).toBe(before)
  })

  it("the list returns the book with its verification, for an app or an agent", async () => {
    const res = await agentCall("kernel__contacts_addresses_list", { contactId: CONTACT })
    const list = res as { addresses?: { id: string; verified: boolean; role: string }[] }
    expect(list.addresses?.map((a) => [a.role, a.verified])).toEqual([
      ["billing", false],
      ["delivery", false],
    ])
  })
})
