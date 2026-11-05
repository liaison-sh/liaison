// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  decideField,
  getAt,
  hashValue,
  inScope,
  keepServerValue,
  NO_SERVER,
  normalize,
  parsePrefer,
  preferFor,
  pruneConfig,
  setAt,
  summarize,
  type TrackedField,
  trackedFields,
} from "~/cli/config/drift"

const config = {
  org: { slug: "fabrikam", name: "Fabrikam", timezone: "Europe/Paris" },
  admin: { email: "owner@fabrikam.example", name: "Owner" },
  limits: { seats: 10, mailboxes: null },
  email: { from: "Support <support@fabrikam.example>" },
  roles: [{ name: "support", scopes: ["tickets:tickets:read", "kernel:threads:read"] }],
  apps: [
    {
      name: "database",
      enable: true,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} config ref, not a JS template.
      config: { region: "eu", apiKey: "${DB_KEY:-}" },
      domainAccess: { orders: { tier: "read", roles: ["support"] } },
    },
    { name: "tickets", enable: true, connection: { name: "gmail", credentials: { token: "x" } } },
  ],
  agents: [{ handle: "@Support", displayName: "Support", scopes: ["tickets:tickets:read"] }],
  users: [{ email: "ann@fabrikam.example", name: "Ann", role: "support" }],
}

function field(path: string): TrackedField {
  const f = trackedFields(config).find((t) => t.path === path)
  if (!f) throw new Error(`no tracked field ${path}`)
  return f
}

describe("trackedFields", () => {
  test("lists the non-secret paths the file sets, entries by identity", () => {
    const paths = trackedFields(config).map((f) => f.path)
    expect(paths).toContain("org.name")
    expect(paths).toContain("org.timezone")
    expect(paths).toContain("limits.seats")
    expect(paths).toContain("limits.mailboxes")
    expect(paths).toContain("email.from")
    expect(paths).toContain("roles.support")
    expect(paths).toContain("apps.database.enable")
    expect(paths).toContain("apps.database.config.region")
    expect(paths).toContain("apps.database.domainAccess")
    expect(paths).toContain("agents.support.scopes")
    expect(paths).toContain("agents.support.purpose")
    // Secrets and untracked sections are never tracked.
    expect(paths).not.toContain("apps.database.config.apiKey")
    expect(paths.some((p) => p.includes("connection"))).toBe(false)
    expect(paths.some((p) => p.startsWith("users"))).toBe(false)
    expect(paths.some((p) => p.startsWith("admin"))).toBe(false)
  })

  test("getAt finds an agent entry by its handle without @, case-insensitive", () => {
    expect(getAt(config, field("agents.support.displayName").loc)).toBe("Support")
  })

  test("an app listed once per connection is tracked once per path, read from the entry that sets it", () => {
    const twice = {
      org: { slug: "fabrikam" },
      apps: [
        {
          name: "database",
          enable: true,
          connection: { name: "gate" },
          domainAccess: { support: { tier: "confidential", roles: ["ops"] } },
        },
        {
          name: "database",
          enable: false,
          connection: { name: "warehouse" },
          config: { region: "eu" },
        },
      ],
    }
    const fields = trackedFields(twice)
    const paths = fields.map((f) => f.path)
    expect(paths.filter((p) => p === "apps.database.enable")).toHaveLength(1)
    const at = (path: string) => {
      const f = fields.find((t) => t.path === path)
      if (!f) throw new Error(`no tracked field ${path}`)
      return f.loc
    }
    // The apply writes the entries in order, so the last one that sets a key wins.
    expect(getAt(twice, at("apps.database.enable"))).toBe(false)
    expect(getAt(twice, at("apps.database.config.region"))).toBe("eu")
    expect(getAt(twice, at("apps.database.domainAccess"))).toEqual({
      support: { tier: "confidential", roles: ["ops"] },
    })
    // A write lands in the entry that already holds the key.
    setAt(twice, at("apps.database.domainAccess"), { support: { tier: "restricted", roles: [] } })
    expect(twice.apps[0]?.domainAccess).toEqual({ support: { tier: "restricted", roles: [] } })
    expect("domainAccess" in (twice.apps[1] ?? {})).toBe(false)
  })
})

describe("normalize + hash", () => {
  test("hash is stable across key order and scope order", () => {
    const f = field("roles.support")
    const a = normalize(f, { name: "support", scopes: ["b", "a"] })
    const b = normalize(f, { scopes: ["a", "b"], name: "support" })
    expect(hashValue(a)).toBe(hashValue(b))
  })

  test("agent scopes ignore the common base, text ignores empty", () => {
    const scopes = field("agents.support.scopes")
    expect(normalize(scopes, ["kernel:threads:read", "x:y"])).toEqual(["x:y"])
    expect(normalize(scopes, [])).toBeNull()
    expect(normalize(field("agents.support.purpose"), "")).toBeNull()
  })

  test("a role's description is compared only when the file names one", () => {
    const f = field("roles.support")
    expect(normalize(f, { scopes: [], description: "UI text" }, { scopes: [] })).toEqual({
      scopes: [],
    })
    expect(
      normalize(f, { scopes: [], description: "UI text" }, { scopes: [], description: "x" }),
    ).toEqual({ scopes: [], description: "UI text" })
  })

  test("summaries mask secret-like paths", () => {
    expect(summarize("invoicing.issuerProfiles.Acme.iban", "FR76 1234")).toMatch(/^\(set, sha256:/)
    expect(summarize("org.timezone", "Europe/Paris")).toBe('"Europe/Paris"')
    expect(summarize("org.timezone", null)).toBe("(not set)")
  })
})

describe("decideField", () => {
  const tz = field("org.timezone")
  const record = (value: unknown) => ({
    hash: hashValue(normalize(tz, value)),
    appliedAt: new Date("2026-11-01T10:00:00Z"),
    appliedBy: "cli:ops@host",
  })

  test("no org yet: create", () => {
    const d = decideField({
      field: tz,
      fileValue: "Europe/Paris",
      server: NO_SERVER,
      record: undefined,
      prefer: undefined,
    })
    expect(d.entry.action).toBe("create")
  })

  test("file equals server: unchanged, whatever the record says", () => {
    const d = decideField({
      field: tz,
      fileValue: "Europe/Paris",
      server: "Europe/Paris",
      record: record("UTC"),
      prefer: undefined,
    })
    expect(d.entry.action).toBe("unchanged")
  })

  test("no record yet: update, never a conflict (first apply after upgrade)", () => {
    const d = decideField({
      field: tz,
      fileValue: "Europe/Paris",
      server: "UTC",
      record: undefined,
      prefer: undefined,
    })
    expect(d.entry.action).toBe("update")
  })

  test("server still as last applied: update", () => {
    const d = decideField({
      field: tz,
      fileValue: "Europe/Paris",
      server: "UTC",
      record: record("UTC"),
      prefer: undefined,
    })
    expect(d.entry.action).toBe("update")
    expect(d.entry.lastApplied?.matchesServer).toBe(true)
  })

  test("server changed since the last apply and file disagrees: conflict", () => {
    const d = decideField({
      field: tz,
      fileValue: "Europe/Paris",
      server: "America/New_York",
      record: record("Europe/Berlin"),
      prefer: undefined,
    })
    expect(d.entry.action).toBe("conflict")
    expect(d.entry.file).toBe('"Europe/Paris"')
    expect(d.entry.server).toBe('"America/New_York"')
    expect(d.entry.lastApplied).toEqual({
      at: "2026-11-01T10:00:00.000Z",
      by: "cli:ops@host",
      matchesServer: false,
    })
  })

  test("--prefer file writes, --prefer server keeps", () => {
    const base = {
      field: tz,
      fileValue: "Europe/Paris",
      server: "America/New_York",
      record: record("Europe/Berlin"),
    }
    expect(decideField({ ...base, prefer: "file" }).entry).toMatchObject({
      action: "update",
      resolution: "file",
    })
    expect(decideField({ ...base, prefer: "server" }).entry).toMatchObject({
      action: "keep",
      resolution: "server",
    })
  })
})

describe("--prefer / --only parsing and matching", () => {
  test("parsePrefer", () => {
    expect(parsePrefer(["file"])).toEqual({ all: "file", scoped: [] })
    expect(parsePrefer(["server=apps.database", "file"])).toEqual({
      all: "file",
      scoped: [{ path: "apps.database", side: "server" }],
    })
    expect(typeof parsePrefer(["file", "server"])).toBe("string")
    expect(typeof parsePrefer(["mine"])).toBe("string")
    expect(typeof parsePrefer(["file="])).toBe("string")
  })

  test("preferFor takes the longest matching scoped flag, else the global one", () => {
    const spec = {
      all: "file" as const,
      scoped: [
        { path: "apps", side: "server" as const },
        { path: "apps.database.config", side: "file" as const },
      ],
    }
    expect(preferFor(spec, "apps.tickets.enable")).toBe("server")
    expect(preferFor(spec, "apps.database.config.region")).toBe("file")
    expect(preferFor(spec, "org.timezone")).toBe("file")
    expect(preferFor(undefined, "org.timezone")).toBeUndefined()
  })

  test("inScope matches the path, its parents and its parts", () => {
    expect(inScope("apps.database.domainAccess", [])).toBe(true)
    expect(inScope("apps.database.domainAccess", ["apps.database.domainAccess"])).toBe(true)
    expect(inScope("apps.database.domainAccess", ["apps"])).toBe(true)
    expect(inScope("roles.support", ["roles.support.scopes"])).toBe(true)
    expect(inScope("apps.databases.enable", ["apps.database"])).toBe(false)
    expect(inScope("org.timezone", ["apps.database.domainAccess"])).toBe(false)
  })
})

describe("pruneConfig", () => {
  test("keeps org + admin and only the selected part of an entry, with its required keys", () => {
    const pruned = pruneConfig(config, ["apps.database.domainAccess"])
    expect(Object.keys(pruned).sort()).toEqual(["admin", "apps", "org"])
    expect(pruned.apps).toEqual([
      {
        name: "database",
        enable: true,
        domainAccess: { orders: { tier: "read", roles: ["support"] } },
      },
    ])
  })

  test("a whole section or entry is kept as written", () => {
    expect(pruneConfig(config, ["roles"]).roles).toEqual(config.roles)
    expect(pruneConfig(config, ["agents.support"]).agents).toEqual(config.agents)
    expect(pruneConfig(config, ["email.from"]).email).toEqual({ from: config.email.from })
  })

  test("returns a fresh tree (keeping server values never edits the caller's config)", () => {
    const pruned = pruneConfig(config, [])
    setAt(pruned, ["org", "timezone"], "UTC")
    expect(config.org.timezone).toBe("Europe/Paris")
  })
})

describe("keepServerValue", () => {
  test("writes the server value back, removes a key the server does not set", () => {
    const work = pruneConfig(config, [])
    keepServerValue(work, field("org.timezone"), "UTC")
    expect(getAt(work, ["org", "timezone"])).toBe("UTC")
    keepServerValue(work, field("email.from"), undefined)
    expect(getAt(work, ["email", "from"])).toBeUndefined()
    keepServerValue(work, field("limits.seats"), null)
    expect(getAt(work, ["limits", "seats"])).toBeNull()
  })

  test("a role entry takes the server's scopes; an app the server has off is dropped", () => {
    const work = pruneConfig(config, [])
    keepServerValue(work, field("roles.support"), { name: "support", scopes: ["a:b"] })
    expect(getAt(work, field("roles.support").loc)).toEqual({ name: "support", scopes: ["a:b"] })
    keepServerValue(work, field("apps.database.enable"), false)
    expect(getAt(work, ["apps", { key: "name", id: "database" }])).toBeUndefined()
  })
})
