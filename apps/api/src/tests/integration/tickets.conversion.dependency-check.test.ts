// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { sql } from "~/db"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  type AppDescriptor,
  AppRegistrationFatalError,
  registerApps,
  verifyCrossAppToolDependencies,
} from "~/modules/apps/runtime"

const ORG = "00000000-0000-0000-0000-000000000ddd"
const REG_ORG = "00000000-0000-0000-0000-000000000dde"

const MAIL_TOOL_NAMES = ["convertToTicket", "createFromTicket", "appendInboundMessage"] as const
const TICKETS_TOOL_NAMES = [
  "convertToMail",
  "createFromMail",
  "pullMailReply",
  "deleteIfUnreferenced",
  "ensureSummary",
  "regenerateSummary",
  "addNote",
] as const

function stubTool(appName: string, toolName: string): void {
  toolRegistry.set([ORG, appName, toolName], {
    appName,
    name: toolName,
    description: `${appName}:${toolName}`,
    requiredScopes: [`${appName}:res:read`],
    handler: async () => ({ ok: true }),
  } as any)
}

function seedAllStubs(): void {
  for (const t of MAIL_TOOL_NAMES) stubTool("mail", t)
  for (const t of TICKETS_TOOL_NAMES) stubTool("tickets", t)
}

function clearAllStubs(): void {
  for (const t of MAIL_TOOL_NAMES) toolRegistry.delete([ORG, "mail", t])
  for (const t of TICKETS_TOOL_NAMES) toolRegistry.delete([ORG, "tickets", t])
}

const mailDescriptor: AppDescriptor = {
  name: "mail",
  version: "1.0.0",
  dependencies: {
    optional: ["tickets"],
    tools: ["tickets:createFromMail", "tickets:deleteIfUnreferenced", "tickets:pullMailReply"],
  },
}

const requiredMailDescriptor: AppDescriptor = {
  name: "mail",
  version: "1.0.0",
  dependencies: {
    required: ["tickets"],
    tools: ["tickets:createFromMail"],
  },
}

const ticketsDescriptor: AppDescriptor = {
  name: "tickets",
  version: "1.0.0",
  dependencies: {
    optional: ["mail"],
    tools: ["mail:createFromTicket", "mail:appendInboundMessage"],
  },
}

const requiredTicketsDescriptor: AppDescriptor = {
  name: "tickets",
  version: "1.0.0",
  dependencies: {
    required: ["mail"],
    tools: ["mail:createFromTicket"],
  },
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'DepCheck Org', 'dep-check-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${REG_ORG}, 'DepCheck Registration Org', 'dep-check-registration-org') ON CONFLICT DO NOTHING`
})

afterEach(() => {
  clearAllStubs()
})

describe("cross-app tool dependency verification", () => {
  it("passes when every declared cross-app tool exists in the registry", () => {
    seedAllStubs()
    expect(() =>
      verifyCrossAppToolDependencies([mailDescriptor, ticketsDescriptor], ORG),
    ).not.toThrow()
  })

  it("allows optional target tools to be unavailable", () => {
    seedAllStubs()
    toolRegistry.delete([ORG, "tickets", "createFromMail"])
    toolRegistry.delete([ORG, "tickets", "deleteIfUnreferenced"])
    toolRegistry.delete([ORG, "tickets", "pullMailReply"])
    expect(() =>
      verifyCrossAppToolDependencies([mailDescriptor, ticketsDescriptor], ORG),
    ).not.toThrow()
  })

  it("allows an optional target app to be absent", () => {
    expect(() => verifyCrossAppToolDependencies([mailDescriptor], ORG)).not.toThrow()
  })

  it("fails with missing_tool_dependency when a required target app is absent", () => {
    let err: any
    try {
      verifyCrossAppToolDependencies([requiredMailDescriptor], ORG)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AppRegistrationFatalError)
    expect(err.code).toBe("missing_tool_dependency")
    expect(err.message).toContain("tickets:createFromMail")
  })

  it("fails when a required target tool is absent", () => {
    seedAllStubs()
    toolRegistry.delete([ORG, "tickets", "createFromMail"])
    let err: any
    try {
      verifyCrossAppToolDependencies([requiredMailDescriptor, ticketsDescriptor], ORG)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AppRegistrationFatalError)
    expect(err.code).toBe("missing_tool_dependency")
    expect(err.message).toContain("tickets:createFromMail")
  })

  it("allows tickets to install without optional Mail tools", () => {
    seedAllStubs()
    toolRegistry.delete([ORG, "mail", "createFromTicket"])
    toolRegistry.delete([ORG, "mail", "appendInboundMessage"])
    expect(() =>
      verifyCrossAppToolDependencies([mailDescriptor, ticketsDescriptor], ORG),
    ).not.toThrow()
  })

  it("fails when a required Mail target tool is absent", () => {
    seedAllStubs()
    toolRegistry.delete([ORG, "mail", "createFromTicket"])
    let err: any
    try {
      verifyCrossAppToolDependencies([mailDescriptor, requiredTicketsDescriptor], ORG)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AppRegistrationFatalError)
    expect(err.message).toContain("mail:createFromTicket")
  })

  it("registerApps degrades gracefully when an optional target tool is absent from the real registration path", async () => {
    const mail = { ...mailAppManifest, dependencies: { ...(mailAppManifest as any).dependencies } }
    const tickets = {
      ...ticketsAppManifest,
      tools: { ...(ticketsAppManifest as any).tools },
      dependencies: { ...(ticketsAppManifest as any).dependencies },
    }
    delete (tickets.tools as Record<string, unknown>).createFromMail

    await expect(
      registerApps(
        [mail as unknown as AppDescriptor, tickets as unknown as AppDescriptor],
        REG_ORG,
      ),
      // registerApps reports the apps that did not register (#477): none here,
      // both apps register with the optional tool missing.
    ).resolves.toEqual({ failedApps: [] })
  })
})
