// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An issuer's legal identifiers come from the person (walk of agent-driven
// configuration, N19): with no issuer profile, an agent proposed one with a
// SIREN nobody gave, and when the checksum refused it, picked another number.
// The check runs in executeTool for every agent call (in-app or MCP) to a tool
// on the host's own list, whatever the app's manifest says.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import * as eventBusModule from "~/infra/events/event-bus"
import { registerConfigTools } from "~/modules/agent/tools/config-tools"
import { executeTool, type ToolOrigin } from "~/modules/apps/execute-tool"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import {
  frenchVatOf,
  ungroundedAddresses,
  ungroundedIdentifiers,
} from "~/modules/provisioning/legal-identity-grounding"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { type AppInstallSnapshot, snapshotAppInstalls } from "~/tests/helpers/app-install-state"
import { firstPartyAppTarball } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Apps this file installs are instance-wide rows: put them back after it.
let installs: AppInstallSnapshot | null = null

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

let orgId: string
let adminId: string
let admin: UserContext
let installRoot: string
let prevAppsDir: string | undefined

beforeAll(async () => {
  await acquireTestLock()
  installs = await snapshotAppInstalls()
  installRoot = mkdtempSync(join(tmpdir(), "legal-identity-install-root-"))
  prevAppsDir = process.env.LIAISON_APPS_DIR
  process.env.LIAISON_APPS_DIR = installRoot
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  adminId = a.userId
  admin = a.actor
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../bundled-apps/invoicing/app.manifest.json"),
      "utf8",
    ),
  ) as { scopes: string[] }
  await installAppFromTarball({
    tarballPath: firstPartyAppTarball("invoicing"),
    installedBy: adminId,
    grantedScopes: manifest.scopes,
  })
  await reloadInstalledApps(orgId)
  registerConfigTools(orgId)
}, 120_000)

afterAll(async () => {
  broadcastSpy.mockRestore()
  if (prevAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = prevAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  await installs?.restore()
  await releaseTestLock()
})

// 552032534 passes the Luhn checksum; 123456789 does not. FR27552032534 is the
// French VAT number computed from 552032534.
const issuer = (extra: Record<string, unknown>) => ({
  issuerProfiles: [
    { legalName: `Northwind ${crypto.randomUUID().slice(0, 6)}`, country: "FR", ...extra },
  ],
})

function call(
  thread: string,
  toolName: string,
  params: unknown,
  origin: ToolOrigin = "in-app-agent",
) {
  return executeTool({
    toolName,
    orgId,
    actor: admin,
    params,
    threadId: thread,
    origin,
    stepBundleId: null,
  })
}

const proposeIn = (thread: string, data: unknown, origin?: ToolOrigin) =>
  call(thread, "kernel:config_invoicing", { invoicing: data }, origin)

type Refusal = { status?: number; code?: string; message?: string; details?: unknown }

async function refusalOf(run: Promise<unknown>): Promise<Refusal> {
  try {
    await run
  } catch (err) {
    return err as Refusal
  }
  throw new Error("expected a refusal")
}

async function personSays(thread: string, content: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`INSERT INTO kernel.messages
    (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${thread}, ${orgId}, ${adminId}, 'user', ${content}, '{}') RETURNING id`
  return row!.id
}

async function attach(messageId: string, filename: string, mimeType: string): Promise<void> {
  await sql`INSERT INTO kernel.files
    (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
    VALUES (${orgId}, 'kernel', 'message', ${messageId}, ${filename}, ${mimeType}, 1024,
      ${`test/legal-identity/${crypto.randomUUID()}`}, ${adminId})`
}

const summaryLines = (res: { blocked?: { summary?: unknown } }) =>
  ((res.blocked?.summary as { lines?: string[] } | undefined)?.lines ?? []).join("\n")

describe("an agent's legal identifiers come from the person", () => {
  it("one nobody gave is refused, final, naming it and what to ask", async () => {
    const thread = await minimal.thread(orgId, adminId)
    await personSays(thread, "here are our invoices, please import them")
    const refused = await refusalOf(
      proposeIn(thread, issuer({ siren: "552032534", addressLine1: "10 Rue de la Paix" })),
    )
    expect(refused.status).toBe(400)
    expect(refused.code).toBe("legal_identifier_not_given")
    expect(refused.details).toEqual({ retryable: false })
    expect(refused.message).toContain("SIREN 552032534")
    expect(refused.message).toContain("ask them to type each one in a message")
    // The address is not grounding-checked, so the refusal does not claim it is,
    // and it never sends the person for a document.
    expect(refused.message).not.toContain("address")
    expect(refused.message).not.toContain("document")
  })

  it("a spaced SIREN the person wrote parks, and the card shows it normalized", async () => {
    const thread = await minimal.thread(orgId, adminId)
    await personSays(thread, "Our SIREN is 552 032 534.")
    const res = await proposeIn(thread, issuer({ siren: "552 032 534" }))
    expect(res.blocked?.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(summaryLines(res)).toContain("SIREN 552032534")
  })

  it("a bad checksum on a number the person gave is a final refusal that asks for the right one", async () => {
    const thread = await minimal.thread(orgId, adminId)
    await personSays(thread, "SIREN 123 456 789")
    const refused = await refusalOf(proposeIn(thread, issuer({ siren: "123 456 789" })))
    expect(refused.code).toBe("invalid_legal_identifier")
    expect(refused.details).toEqual({ retryable: false })
    expect(refused.message).toContain("ask the person to type their exact SIREN in a message")
    expect(refused.message).toContain("Never try another number")
  })

  it("a French VAT number computed from the given SIREN is accepted; a wrong key is not", async () => {
    expect(frenchVatOf("552032534")).toBe("FR27552032534")
    const thread = await minimal.thread(orgId, adminId)
    await personSays(thread, "SIREN 552032534")
    const ok = await proposeIn(thread, issuer({ siren: "552032534", vatId: "FR27552032534" }))
    expect(ok.blocked?.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
    const refused = await refusalOf(
      proposeIn(thread, issuer({ siren: "552032534", vatId: "FR40552032534" })),
    )
    expect(refused.code).toBe("legal_identifier_not_given")
    expect(refused.message).toContain("VAT number FR40552032534")
    expect(refused.message).not.toContain("SIREN 552032534")
  })

  it("a BIC is an identifier too", async () => {
    const thread = await minimal.thread(orgId, adminId)
    await personSays(thread, "SIREN 552032534")
    const refused = await refusalOf(
      proposeIn(thread, issuer({ siren: "552032534", swiftBic: "AGRIFRPP" })),
    )
    expect(refused.code).toBe("legal_identifier_not_given")
    expect(refused.message).toContain("BIC AGRIFRPP")
  })

  it("with a PDF it cannot read, the refusal asks the person to confirm the value in a message", async () => {
    const thread = await minimal.thread(orgId, adminId)
    const msg = await personSays(thread, "our registration extract")
    await attach(msg, "kbis.pdf", "application/pdf")
    const refused = await refusalOf(proposeIn(thread, issuer({ siren: "552032534" })))
    expect(refused.code).toBe("legal_identifier_not_given")
    expect(refused.message).toContain("kbis.pdf")
    expect(refused.message).toContain("have the person confirm it by typing it in a message")
    // The typed confirmation grounds it.
    await personSays(thread, "Yes, it is 552032534.")
    const res = await proposeIn(thread, issuer({ siren: "552032534" }))
    expect(res.blocked?.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("an MCP client's call is checked the same way", async () => {
    const thread = await minimal.thread(orgId, adminId)
    const refused = await refusalOf(proposeIn(thread, issuer({ siren: "552032534" }), "mcp"))
    expect(refused.code).toBe("legal_identifier_not_given")
  })

  it("the invoicing app's own issuer tools cannot bypass it", async () => {
    const thread = await minimal.thread(orgId, adminId)
    for (const tool of [
      "invoicing:settings_issuer_profile_create",
      "invoicing:settings_issuer_profile_update",
    ]) {
      const params = tool.endsWith("create")
        ? { legal_name: "Northwind SAS", country: "FR", vat_id: "FR27552032534" }
        : { id: crypto.randomUUID(), iban: "FR7630006000011234567890189" }
      const refused = await refusalOf(call(thread, tool, params))
      expect({ tool, code: refused.code }).toEqual({ tool, code: "legal_identifier_not_given" })
    }
  })

  it("a person's own call from the app is not checked: it runs", async () => {
    const thread = await minimal.thread(orgId, adminId)
    const res = await proposeIn(thread, issuer({ siren: "552032534" }), "human-ui")
    expect(res.blocked).toBeUndefined()
    expect(JSON.stringify(res.data)).toContain("invoicing")
  })
})

describe("a mailbox or inbox address an agent connects comes from the person (walk N37)", () => {
  const inbox = (address: string) => ({
    inboxes: [{ address, provider: "gmail" }],
  })

  it("a ticket inbox on an address nobody gave is refused before any card, final", async () => {
    const thread = await minimal.thread(orgId, adminId)
    await personSays(
      thread,
      "Please connect our Google Workspace mail so our team mailbox comes in.",
    )
    const refused = await refusalOf(
      call(thread, "kernel:config_tickets", { tickets: inbox("support@harborlane.test") }),
    )
    expect(refused.status).toBe(400)
    expect(refused.code).toBe("address_not_given")
    expect(refused.details).toEqual({ retryable: false })
    expect(refused.message).toContain("ticket inbox address support@harborlane.test")
    expect(refused.message).toContain("never make one up")
    expect(refused.message).toContain("not proposed at all")
  })

  it("a mailbox address and an IMAP login are checked; one the person typed parks", async () => {
    const thread = await minimal.thread(orgId, adminId)
    await personSays(thread, "It is Team@Harborlane.test")
    const refused = await refusalOf(
      call(thread, "kernel:config_mail", {
        mail: {
          mailboxes: [
            {
              address: "team@harborlane.test",
              provider: "imap",
              imap: {
                email: "login@harborlane.test",
                imapHost: "imap.example.test",
                imapPort: 993,
                smtpHost: "smtp.example.test",
                smtpPort: 465,
                username: "team",
              },
            },
          ],
        },
      }),
    )
    expect(refused.code).toBe("address_not_given")
    expect(refused.message).toContain("login@harborlane.test")
    expect(refused.message).not.toContain("mailbox address team@harborlane.test")

    const parked = await call(thread, "kernel:config_mail", {
      mail: { mailboxes: [{ address: "team@harborlane.test", provider: "gmail" }] },
    })
    expect(parked.blocked?.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("an address the workspace knows (a member's) grounds it; the person's own call is not checked", async () => {
    const thread = await minimal.thread(orgId, adminId)
    const [me] = await sql<
      { email: string }[]
    >`SELECT email FROM kernel.users WHERE id = ${adminId}`
    const known = await call(thread, "kernel:config_tickets", { tickets: inbox(me!.email) })
    expect(known.blocked?.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
    const own = await call(
      thread,
      "kernel:config_tickets",
      { tickets: inbox("desk@harborlane.test") },
      "human-ui",
    )
    expect(JSON.stringify(own.data ?? own.blocked ?? {})).not.toContain("address_not_given")
  })
})

describe("ungroundedAddresses", () => {
  it("matches case-insensitively, and only the whole address", () => {
    const a = [{ field: "address", label: "inbox", value: "Support@Acme.test" }]
    expect(ungroundedAddresses(a, ["write to support@acme.test"])).toEqual([])
    expect(ungroundedAddresses(a, ["acme.test support"])).toEqual(a)
  })

  it("never matches inside a longer address (review): a prefix or a longer domain is not the address", () => {
    const a = [{ field: "address", label: "inbox", value: "support@acme.com" }]
    expect(ungroundedAddresses(a, ["write to it-support@acme.com"])).toEqual(a)
    expect(ungroundedAddresses(a, ["our desk is support@acme.com.au"])).toEqual(a)
    expect(ungroundedAddresses(a, ["it is <Support@Acme.com>."])).toEqual([])
  })
})

describe("ungroundedIdentifiers", () => {
  it("folds case, spaces, dots and dashes on both sides", () => {
    const ids = [
      { field: "siren", label: "SIREN", value: "552.032.534" },
      { field: "iban", label: "IBAN", value: "fr76 3000 6000 0112 3456 7890 189" },
    ]
    expect(
      ungroundedIdentifiers(ids, ["SIREN 552-032-534, IBAN FR7630006000011234567890189"]),
    ).toEqual([])
  })
})
