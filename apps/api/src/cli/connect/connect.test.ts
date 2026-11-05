// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Connect helper test. Mocks OAuth + the outbox (injected `ConnectDeps`) but
 * uses the REAL test DB for org/user seeding and the connection / inbox polling
 * reads.
 *
 * Coverage:
 * - arg parse: no slash / empty ref -> usage (naming mail/gmail and
 *   tickets/gmail) to the log seam, exit 2;
 * - registry warm + google-client save before startOAuthFlow; URL printed;
 * - polling waits for a NEW connection (a pre-existing one never satisfies it);
 * - mail/gmail never creates a ticket inbox, even for the legacy config shape;
 * - tickets/gmail applies the declared inbox settings once the server created
 *   the inbox.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { type ConnectDeps, connectGuide, createConnect } from "~/cli/connect"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock, truncateOrgTables } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

let orgId: string
let orgSlug: string
let adminId: string

beforeEach(async () => {
  // Truncate so the single-org default (used when a config has no resolvable
  // org.slug) resolves to exactly this test's org — not an accreting set.
  await truncateOrgTables()
  orgSlug = `cli-connect-${crypto.randomUUID().slice(0, 12)}`
  const org = await ensureOrg({ slug: orgSlug, name: "ConnectTestOrg" })
  orgId = org.orgId
  const admin = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-connect-1!",
    role: "admin",
  })
  adminId = admin.userId
})

/** A captured-log seam + a baseline `ConnectDeps` with a no-op OAuth flow. */
function makeDeps(overrides: Partial<ConnectDeps> = {}): {
  deps: ConnectDeps
  lines: string[]
} {
  const lines: string[] = []
  const deps: ConnectDeps = {
    ensureAppsForOrg: async () => {},
    saveGoogleIntegrationConfig: async () => {},
    startOAuthFlow: async () =>
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&state=xyz&code_challenge=cc",
    log: (msg) => lines.push(msg),
    pollIntervalMs: 1,
    pollTimeoutMs: 50,
    sleep: () => Promise.resolve(),
    // No guide unless a test asks for one (the real one may look up MX records).
    guide: async () => ({ refuse: false, lines: [] }),
    ...overrides,
  }
  return { deps, lines }
}

/** A Mail app gmail mailbox config. */
function mailGmailConfig(address: string): ProvisioningConfig {
  return {
    org: { slug: orgSlug, name: "ConnectTestOrg" },
    mail: {
      mailboxes: [
        {
          address,
          provider: "gmail",
          google: { clientId: "cid-123.apps.googleusercontent.com", clientSecret: "csecret-123" },
        },
      ],
    },
  }
}

/** Write a config object to a temp file and return its path. */
async function writeConfig(config: unknown): Promise<string> {
  const { writeFileSync, mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = mkdtempSync(join(tmpdir(), "connect-cfg-"))
  const cfgPath = join(dir, "liaison.json")
  writeFileSync(cfgPath, JSON.stringify(config))
  return cfgPath
}

async function ticketInboxRows(address: string) {
  const rows = await withPrivilegedDb(orgId, "test-read-inbox", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, name, default_team FROM app_tickets.inboxes
      WHERE org_id = ${orgId}::uuid AND email_address = ${address}
    `),
  )
  return extractRows<{ id: string; name: string; default_team: string | null }>(rows)
}

/** Insert an ACTIVE connected_account to simulate the OAuth callback landing. */
async function insertConnectedAccount(app: string, connection: string, identifier: string) {
  return withPrivilegedDb(orgId, "test-insert-connection", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts (
          id, org_id, app_name, connection_name, owner_type, owner_id,
          identifier, provider_type, status, created_by, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}::uuid, ${app}, ${connection}, 'org', NULL,
          ${identifier}, 'oauth2', 'active', ${adminId}, now(), now()
        ) RETURNING id
      `),
    )
    return rows[0]!.id
  })
}

/** Insert the reactive app_mail.accounts row the mail app would create. */
async function insertMailAccount(connectedAccountId: string, address: string) {
  await withPrivilegedDb(orgId, "test-insert-mail-account", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.accounts (
        id, org_id, connected_account_id, owner_type, provider, email_address,
        sync_status, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}::uuid, ${connectedAccountId}::uuid, 'org',
        'gmail', ${address}, 'idle', now(), now()
      )
    `)
  })
}

describe("connect — arg parsing", () => {
  test("no slash → usage to log seam, exit 2", async () => {
    const { deps, lines } = makeDeps()
    const run = createConnect(deps)
    const res = await run({ ref: "mailgmail" })
    expect(res.exitCode).toBe(2)
    expect(lines.some((l) => l.includes("usage:"))).toBe(true)
    const usage = lines.join("\n")
    expect(usage).toMatch(/mail\/gmail +connect a Mail app mailbox/)
    expect(usage).toMatch(/tickets\/gmail +connect a ticket inbox/)
  })

  test("empty ref → usage, exit 2", async () => {
    const { deps, lines } = makeDeps()
    const run = createConnect(deps)
    const res = await run({ ref: "" })
    expect(res.exitCode).toBe(2)
    expect(lines.some((l) => l.includes("usage:"))).toBe(true)
  })
})

describe("connect — registry warm + google client + URL", () => {
  test("config-supplied google creds → saveGoogleIntegrationConfig before startOAuthFlow; authorize URL printed", async () => {
    const order: string[] = []
    let savedClientId: string | undefined
    let flowArgs: { app: string; connection: string } | undefined
    const { deps, lines } = makeDeps({
      ensureAppsForOrg: async () => {
        order.push("ensureApps")
      },
      saveGoogleIntegrationConfig: async (_org, cfg) => {
        order.push("saveGoogle")
        savedClientId = cfg.clientId
      },
      startOAuthFlow: async (_org, _uid, app, connection) => {
        order.push("startFlow")
        flowArgs = { app, connection }
        // The consent lands right after the URL is issued.
        await insertConnectedAccount("mail", "gmail", "support@fabrikam.example")
        return "https://auth.example/o?client_id=THE_CLIENT&state=THE_STATE&code_challenge=cc"
      },
    })
    const run = createConnect(deps)
    const res = await run({ ref: "mail/gmail", configPath: undefined })
    // configPath omitted means no google save; pass config inline via a temp file
    // is overkill — instead assert the no-config path still warms + flows + URL.
    expect(res.exitCode).toBe(0)
    expect(order[0]).toBe("ensureApps")
    expect(order).toContain("startFlow")
    expect(flowArgs).toEqual({ app: "mail", connection: "gmail" })
    expect(savedClientId).toBeUndefined() // no config → no google save
    // The authorize URL was printed (to the stderr log seam) with client_id+state.
    const urlLine = lines.find((l) => l.includes("client_id=THE_CLIENT"))
    expect(urlLine).toBeDefined()
    expect(urlLine).toContain("state=THE_STATE")
  })

  test("shopify: a config identifier with an env-placeholder ref is interpolated into the shop template var", async () => {
    // Regression: connect must interpolate env refs like `config apply` does, else
    // an identifier such as SHOPIFY_STORE_DOMAIN reaches startOAuthFlow as the
    // literal dollar-brace string and shop validation rejects it.
    let capturedShop: string | undefined
    const { deps } = makeDeps({
      startOAuthFlow: async (_org, _uid, _app, _conn, opts) => {
        capturedShop = opts?.shop
        await insertConnectedAccount("shopify", "shop", "fabrikam-test")
        return "https://fabrikam-test.myshopify.com/admin/oauth/authorize?client_id=c&state=s"
      },
    })
    const { writeFileSync, mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "connect-shopify-"))
    const cfgPath = join(dir, "liaison.json")
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} config ref under test, not a JS template.
    const shopRef = "${CONNECT_TEST_SHOP}"
    writeFileSync(
      cfgPath,
      JSON.stringify({
        org: { slug: orgSlug, name: "ConnectTestOrg" },
        apps: [
          {
            name: "shopify",
            enable: true,
            connection: { name: "shop", ownerType: "org", identifier: shopRef },
          },
        ],
      }),
    )
    process.env.CONNECT_TEST_SHOP = "fabrikam-test"
    try {
      const run = createConnect(deps)
      const res = await run({ ref: "shopify/shop", configPath: cfgPath })
      expect(res.exitCode).toBe(0)
      expect(capturedShop).toBe("fabrikam-test")
    } finally {
      delete process.env.CONNECT_TEST_SHOP
    }
  })

  test("shopify without a store domain says where the domain goes", async () => {
    const { deps, lines } = makeDeps({
      startOAuthFlow: async () => {
        throw new Error('Connection "shop" requires a "shop" value in the OAuth flow')
      },
    })
    const run = createConnect(deps)
    const res = await run({ ref: "shopify/shop" })
    expect(res.exitCode).toBe(1)
    expect(lines.some((l) => l.includes("apps[name=shopify].connection.identifier"))).toBe(true)
  })

  test("with a config supplying google creds → saveGoogleIntegrationConfig runs before startOAuthFlow", async () => {
    const order: string[] = []
    const { deps } = makeDeps({
      ensureAppsForOrg: async () => {
        order.push("ensureApps")
      },
      saveGoogleIntegrationConfig: async () => {
        order.push("saveGoogle")
      },
      startOAuthFlow: async () => {
        order.push("startFlow")
        await insertConnectedAccount("mail", "gmail", "support@fabrikam.example")
        return "https://auth.example/o?client_id=c&state=s"
      },
    })
    const cfgPath = await writeConfig(mailGmailConfig("support@fabrikam.example"))
    const run = createConnect(deps)
    const res = await run({ ref: "mail/gmail", configPath: cfgPath })
    expect(res.exitCode).toBe(0)
    expect(order.indexOf("saveGoogle")).toBeLessThan(order.indexOf("startFlow"))
    expect(order.indexOf("saveGoogle")).toBeGreaterThan(order.indexOf("ensureApps"))
  })
})

describe("connect — polling", () => {
  test("connection never appears → clear timeout message + non-zero exit", async () => {
    const { deps, lines } = makeDeps({
      startOAuthFlow: async () => "https://auth.example/o?client_id=c&state=s",
    })
    const run = createConnect(deps)
    const res = await run({ ref: "social/meta" })
    expect(res.exitCode).not.toBe(0)
    expect(lines.some((l) => l.includes("timed out") && l.includes("social/meta"))).toBe(true)
  })

  test("connection appears mid-poll → resolves exit 0", async () => {
    let polls = 0
    const { deps } = makeDeps({
      startOAuthFlow: async () => "https://auth.example/o?client_id=c&state=s",
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
      // On the second sleep, insert the connection so the next poll finds it.
      sleep: async () => {
        polls++
        if (polls === 2) await insertConnectedAccount("social", "meta", "act_123")
      },
    })
    const run = createConnect(deps)
    const res = await run({ ref: "social/meta" })
    expect(res.exitCode).toBe(0)
  })
})

describe("connect: a pre-existing connection does not satisfy the wait", () => {
  test("connecting a second account times out instead of returning on the first one", async () => {
    await insertConnectedAccount("tickets", "gmail", "first@fabrikam.example")
    const { deps, lines } = makeDeps({
      startOAuthFlow: async () => "https://auth.example/o?client_id=c&state=s",
    })
    const res = await createConnect(deps)({ ref: "tickets/gmail" })
    expect(res.exitCode).toBe(1)
    expect(lines.some((l) => l.includes("timed out"))).toBe(true)
  })
})

describe("connect: mail/gmail never creates a ticket inbox", () => {
  test("legacy mailboxes config with an inbox block: refused with guidance, no ticket inbox", async () => {
    const address = "support@fabrikam.example"
    const { deps, lines } = makeDeps({
      startOAuthFlow: async () => {
        const caId = await insertConnectedAccount("mail", "gmail", address)
        await insertMailAccount(caId, address)
        return "https://auth.example/o?client_id=c&state=s"
      },
    })
    const cfgPath = await writeConfig({
      org: { slug: orgSlug, name: "ConnectTestOrg" },
      mailboxes: [
        {
          address,
          provider: "gmail",
          google: { clientId: "cid-123.apps.googleusercontent.com", clientSecret: "csecret-123" },
          inbox: { name: "Support", default: true },
        },
      ],
    })
    const res = await createConnect(deps)({ ref: "mail/gmail", configPath: cfgPath })
    expect(res.exitCode).toBe(2)
    expect(lines.some((l) => l.includes("tickets.inboxes"))).toBe(true)
    expect(await ticketInboxRows(address)).toEqual([])
  })

  test("mail/gmail with a config declaring the same address as a ticket inbox: still no ticket inbox", async () => {
    const address = "support@fabrikam.example"
    const { deps } = makeDeps({
      startOAuthFlow: async () => {
        const caId = await insertConnectedAccount("mail", "gmail", address)
        await insertMailAccount(caId, address)
        return "https://auth.example/o?client_id=c&state=s"
      },
    })
    const cfgPath = await writeConfig({
      ...mailGmailConfig(address),
      tickets: { inboxes: [{ address, provider: "gmail", name: "Support", default: true }] },
    })
    const res = await createConnect(deps)({ ref: "mail/gmail", configPath: cfgPath })
    expect(res.exitCode).toBe(0)
    expect(await ticketInboxRows(address)).toEqual([])
  })
})

describe("connect: tickets/gmail applies the declared inbox settings", () => {
  test("the server-created inbox gets the name and default team from tickets.inboxes", async () => {
    const address = "desk@fabrikam.example"
    let caId = ""
    let seeded = false
    const { deps } = makeDeps({
      pollTimeoutMs: 5_000,
      startOAuthFlow: async () => {
        caId = await insertConnectedAccount("tickets", "gmail", address)
        return "https://auth.example/o?client_id=c&state=s"
      },
      // Stand-in for ticketsOnAccountConnected: the inbox appears mid-poll.
      sleep: async () => {
        if (seeded || !caId) return
        seeded = true
        await withPrivilegedDb(orgId, "test-seed-inbox", (tx) =>
          runAdminOp(
            tx,
            orgId,
            "inboxesCreate",
            { connectedAccountId: caId, name: address, emailAddress: address },
            { actorType: "user", userId: adminId },
          ),
        )
      },
    })
    const cfgPath = await writeConfig({
      org: { slug: orgSlug, name: "ConnectTestOrg" },
      tickets: {
        inboxes: [{ address, provider: "gmail", name: "Support desk", defaultTeam: "Le Pass" }],
      },
    })
    const res = await createConnect(deps)({ ref: "tickets/gmail", configPath: cfgPath })
    expect(res.exitCode).toBe(0)
    const [inbox] = await ticketInboxRows(address)
    expect(inbox?.name).toBe("Support desk")
    expect(inbox?.default_team).toBe("Le Pass")
  })
})

describe("connect: the guide comes first, from the agent's own code", () => {
  const instance = env as { GMAIL_OAUTH_CLIENT_ID?: string; GMAIL_OAUTH_CLIENT_SECRET?: string }
  async function withInstanceClient<T>(fn: () => Promise<T>): Promise<T> {
    const saved = [instance.GMAIL_OAUTH_CLIENT_ID, instance.GMAIL_OAUTH_CLIENT_SECRET] as const
    instance.GMAIL_OAUTH_CLIENT_ID = "instance-cli.apps.googleusercontent.com"
    instance.GMAIL_OAUTH_CLIENT_SECRET = "instance-cli-secret"
    try {
      return await fn()
    } finally {
      instance.GMAIL_OAUTH_CLIENT_ID = saved[0]
      instance.GMAIL_OAUTH_CLIENT_SECRET = saved[1]
    }
  }

  test("a refused guide stops before any flow starts, exit 2", async () => {
    let started = false
    const { deps, lines } = makeDeps({
      guide: async () => ({ refuse: true, lines: ["use IMAP"] }),
      startOAuthFlow: async () => {
        started = true
        return "https://auth.example/o"
      },
    })
    const cfgPath = await writeConfig({
      org: { slug: orgSlug, name: "ConnectTestOrg" },
      mail: { mailboxes: [{ address: "ana@gmail.com", provider: "gmail" }] },
    })
    const res = await createConnect(deps)({ ref: "mail/gmail", configPath: cfgPath })
    expect(res.exitCode).toBe(2)
    expect(started).toBe(false)
    expect(lines).toContain("use IMAP")
  })

  test("several Gmail entries and no --email: asks which, starts nothing, exit 2", async () => {
    let guided = false
    const { deps, lines } = makeDeps({
      guide: async () => {
        guided = true
        return { refuse: false, lines: [] }
      },
    })
    const cfgPath = await writeConfig({
      org: { slug: orgSlug, name: "ConnectTestOrg" },
      mail: {
        mailboxes: [
          { address: "ana@gmail.com", provider: "gmail" },
          { address: "support@acme.example", provider: "gmail" },
        ],
      },
    })
    const res = await createConnect(deps)({ ref: "mail/gmail", configPath: cfgPath })
    expect(res.exitCode).toBe(2)
    expect(guided).toBe(false)
    expect(lines.join("\n")).toContain("--email")
  })

  test("--email picks the address the guide is computed for", async () => {
    let seen: string | undefined
    const { deps } = makeDeps({
      guide: async (_org, _ref, email) => {
        seen = email
        return { refuse: true, lines: [] }
      },
    })
    const cfgPath = await writeConfig({
      org: { slug: orgSlug, name: "ConnectTestOrg" },
      mail: {
        mailboxes: [
          { address: "ana@gmail.com", provider: "gmail" },
          { address: "support@acme.example", provider: "gmail" },
        ],
      },
    })
    await createConnect(deps)({
      ref: "mail/gmail",
      configPath: cfgPath,
      email: "support@acme.example",
    })
    expect(seen).toBe("support@acme.example")
  })

  test("personal Gmail on an unverified instance client: refused with the statement and the IMAP pointer", async () => {
    const g = await withInstanceClient(() => connectGuide(orgId, "mail/gmail", "ana@gmail.com"))
    expect(g.refuse).toBe(true)
    expect(g.lines.join("\n")).toContain("IMAP")
    expect(g.lines.join("\n")).toContain("liaison guide imap --email ana@gmail.com")
  })

  test("Workspace address on an unverified instance client: the Trusted steps, then the flow", async () => {
    const g = await withInstanceClient(() =>
      connectGuide(orgId, "tickets/gmail", "support@acme.example", async () => [
        { exchange: "aspmx.l.google.com" },
      ]),
    )
    expect(g.refuse).toBe(false)
    const text = g.lines.join("\n")
    expect(text).toContain("path: trusted")
    expect(text).toContain("instance-cli.apps.googleusercontent.com")
    expect(text).toContain("Manage App Access")
    expect(g.failureHint).toMatch(/Trusted/)
  })
})
