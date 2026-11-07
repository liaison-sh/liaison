// SPDX-License-Identifier: FSL-1.1-ALv2
// What an install records and refuses: grants, triggers, names, versions, interface approval.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { resetCatalogCache } from "~/modules/apps/catalog"
import { installedAppDescriptor } from "~/modules/apps/init"
import { applyUpgrade, installAppFromTarball } from "~/modules/apps/install-service"

const ADMIN = "00000000-0000-0000-0000-000000000001"
const NAME = "grant-tester"
let installRoot: string

function makeTarball(name: string, version: string, extra: Record<string, unknown> = {}): string {
  const work = mkdtempSync(join(tmpdir(), "grant-pkg-"))
  const stage = join(work, "stage")
  mkdirSync(stage)
  writeFileSync(
    join(stage, "app.manifest.json"),
    JSON.stringify({
      name,
      version,
      packageFormat: 1,
      license: "MIT",
      scopes: [`${name}:items:read`],
      ...extra,
    }),
  )
  writeFileSync(join(stage, "bundle.js"), "// noop")
  const tar = join(work, `${name}-${version}.liaisonapp`)
  spawnSync("tar", ["-czf", tar, "-C", stage, "app.manifest.json", "bundle.js"])
  return tar
}

const base = { installedBy: ADMIN, grantedScopes: [`${NAME}:items:read`], requireSignature: false }

async function rows(name = NAME) {
  return withSystemDb("grants-test", (db) =>
    db.select().from(appsInstalled).where(eq(appsInstalled.name, name)),
  )
}

beforeEach(() => {
  installRoot = mkdtempSync(join(tmpdir(), "grant-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
})
afterEach(async () => {
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  resetCatalogCache()
  for (const n of [
    NAME,
    "kernel",
    "squat-me",
    "invoicing",
    "login",
    "auth",
    "register",
    "reset-password",
    "settings",
    "agents",
  ]) {
    await withSystemDb("grants-test-clean", async (db) => {
      await db.delete(appsInstalled).where(eq(appsInstalled.name, n))
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, n))
    })
  }
})

describe("capabilities and cross-app calls are part of the grant", () => {
  const declared = {
    capabilities: ["messages.post", "pdf.render"],
    cross_app_calls: [{ target: "mail:compose", reason: "send" }],
  }

  it("refuses an install whose declared capabilities were not granted", async () => {
    await expect(
      installAppFromTarball({
        ...base,
        tarballPath: makeTarball(NAME, "1.0.0", declared),
        grantedCapabilities: ["messages.post"],
        grantedCrossAppCalls: ["mail:compose"],
      }),
    ).rejects.toThrow(/capabilities the admin did not grant: pdf\.render/)
  })

  it("refuses an install whose cross_app_calls were not approved", async () => {
    await expect(
      installAppFromTarball({
        ...base,
        tarballPath: makeTarball(NAME, "1.0.0", declared),
        grantedCapabilities: ["messages.post", "pdf.render"],
        grantedCrossAppCalls: [],
      }),
    ).rejects.toThrow(/cross-app calls the admin did not approve: mail:compose/)
  })

  it("refuses a capability this platform does not know", async () => {
    await expect(
      installAppFromTarball({
        ...base,
        tarballPath: makeTarball(NAME, "1.0.0", { capabilities: ["root.everything"] }),
        grantedCapabilities: ["root.everything"],
      }),
    ).rejects.toThrow(/unknown capabilities: root\.everything/)
  })

  it("records exactly what was granted, and the runtime descriptor carries only that", async () => {
    await installAppFromTarball({
      ...base,
      tarballPath: makeTarball(NAME, "1.0.0", declared),
      grantedCapabilities: ["messages.post", "pdf.render"],
      grantedCrossAppCalls: ["mail:compose"],
    })
    const [row] = await rows()
    expect(row?.grantedCapabilities).toEqual(["messages.post", "pdf.render"])
    expect(row?.grantedCrossAppCalls).toEqual(["mail:compose"])

    const manifestPath = join(installRoot, NAME, "1.0.0", "app.manifest.json")
    const app = {
      name: NAME,
      version: "1.0.0",
      manifestPath,
      bundlePath: join(installRoot, NAME, "1.0.0", "bundle.js"),
      source: "installed" as const,
    }
    const narrowed = installedAppDescriptor(app, {
      grantedCapabilities: ["messages.post"],
      grantedCrossAppCalls: [],
    }) as unknown as { capabilities: string[]; cross_app_calls: unknown[] }
    expect(narrowed.capabilities).toEqual(["messages.post"])
    expect(narrowed.cross_app_calls).toEqual([])

    const first = installedAppDescriptor(app, {
      firstParty: true,
      grantedCapabilities: [],
    }) as unknown as { capabilities: string[] }
    expect(first.capabilities).toEqual(["messages.post", "pdf.render"])
  })

  it("a legacy dependencies.tools entry is a cross-app call the admin must approve", async () => {
    await expect(
      installAppFromTarball({
        ...base,
        tarballPath: makeTarball(NAME, "1.0.0", { dependencies: { tools: ["mail:compose"] } }),
        grantedCapabilities: [],
        grantedCrossAppCalls: [],
      }),
    ).rejects.toThrow(/cross-app calls the admin did not approve: mail:compose/)
  })

  it("the runtime descriptor drops dependencies.tools the admin did not approve", async () => {
    await installAppFromTarball({
      ...base,
      tarballPath: makeTarball(NAME, "1.0.0", declared),
      grantedCapabilities: ["messages.post", "pdf.render"],
      grantedCrossAppCalls: ["mail:compose"],
    })
    const manifestPath = join(installRoot, NAME, "1.0.0", "app.manifest.json")
    const app = {
      name: NAME,
      version: "1.0.0",
      manifestPath,
      bundlePath: join(installRoot, NAME, "1.0.0", "bundle.js"),
      source: "installed" as const,
    }
    // Simulate a manifest carrying the legacy list next to cross_app_calls.
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"))
    raw.dependencies = { tools: ["mail:compose", "tickets:internal_tool"] }
    writeFileSync(manifestPath, JSON.stringify(raw))
    const narrowed = installedAppDescriptor(app, {
      grantedCapabilities: [],
      grantedCrossAppCalls: ["mail:compose"],
    }) as unknown as { dependencies: { tools: string[] } }
    expect(narrowed.dependencies.tools).toEqual(["mail:compose"])
  })

  it("an upgrade that adds a capability must be granted it", async () => {
    await installAppFromTarball({
      ...base,
      tarballPath: makeTarball(NAME, "1.0.0"),
      grantedCapabilities: [],
    })
    await expect(
      applyUpgrade({
        ...base,
        name: NAME,
        tarballPath: makeTarball(NAME, "1.1.0", { capabilities: ["realtime.publish"] }),
        grantedCapabilities: [],
      }),
    ).rejects.toThrow(/capabilities the admin did not grant: realtime\.publish/)
  })
})

describe("database triggers need a voucher", () => {
  const triggers = {
    schema: {
      items: {
        fields: { id: { type: "uuid" } },
        triggers: {
          t1: {
            timing: "BEFORE",
            event: ["INSERT"],
            level: "ROW",
            language: "plpgsql",
            body: "BEGIN RETURN NEW; END;",
          },
        },
      },
    },
  }

  it("refuses a package with triggers that nobody vouched for", async () => {
    await expect(
      installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "1.0.0", triggers) }),
    ).rejects.toThrow(/declares database triggers/)
    expect(await rows()).toHaveLength(0)
  })
})

describe("reserved names", () => {
  it("refuses a package named kernel", async () => {
    await expect(
      installAppFromTarball({
        ...base,
        grantedScopes: ["kernel:items:read"],
        tarballPath: makeTarball("kernel", "1.0.0", { scopes: ["kernel:items:read"] }),
      }),
    ).rejects.toThrow(/reserved/)
  })

  // An app's tabs live at /<name>, so a package named after a Liaison page route would
  // own that page's paths (/login/magic signs in on load, /auth/device approves a device).
  it("refuses a package named after a Liaison page route", async () => {
    for (const name of [
      "login",
      "auth",
      "register",
      "reset-password",
      "settings",
      "agents",
      // The agent's data store namespace and the dashboard tab (0275).
      "agent",
      "dashboard",
      "dashboards",
    ]) {
      await expect(
        installAppFromTarball({
          ...base,
          grantedScopes: [`${name}:items:read`],
          tarballPath: makeTarball(name, "1.0.0", { scopes: [`${name}:items:read`] }),
        }),
      ).rejects.toThrow(`Cannot install '${name}': that name is a Liaison page route.`)
      expect(await rows(name)).toHaveLength(0)
    }
  })

  it("refuses a squat on a first-party catalog app's name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-catalog-"))
    writeFileSync(
      join(dir, "catalog.json"),
      JSON.stringify([
        {
          name: "squat-me",
          version: "9.9.9",
          file: "squat-me.liaisonapp",
          scopes: [],
          connections: [],
        },
      ]),
    )
    process.env.LIAISON_APP_CATALOG_DIR = dir
    resetCatalogCache()
    try {
      await expect(
        installAppFromTarball({
          ...base,
          grantedScopes: ["squat-me:items:read"],
          tarballPath: makeTarball("squat-me", "1.0.0", { scopes: ["squat-me:items:read"] }),
        }),
      ).rejects.toThrow(/first-party catalog app/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("first-party names and system labels are reserved (A12)", () => {
  // A catalog holding the first-party `invoicing` app, as the image bakes it.
  function withInvoicingCatalog(): { dir: string; tarball: string } {
    const dir = mkdtempSync(join(tmpdir(), "grant-catalog-"))
    const tarball = makeTarball("invoicing", "3.0.0", {
      scopes: ["invoicing:items:read"],
      displayName: "Invoicing",
      views: { activityBar: { icon: "InvoicingIcon", label: "Invoicing" } },
    })
    copyFileSync(tarball, join(dir, "invoicing.liaisonapp"))
    writeFileSync(
      join(dir, "catalog.json"),
      JSON.stringify([
        {
          name: "invoicing",
          displayName: "Invoicing",
          version: "3.0.0",
          file: "invoicing.liaisonapp",
          scopes: ["invoicing:items:read"],
          connections: [],
        },
      ]),
    )
    process.env.LIAISON_APP_CATALOG_DIR = dir
    resetCatalogCache()
    return { dir, tarball: join(dir, "invoicing.liaisonapp") }
  }

  it("refuses an outside package named after a first-party app", async () => {
    const { dir } = withInvoicingCatalog()
    try {
      await expect(
        installAppFromTarball({
          ...base,
          grantedScopes: ["invoicing:items:read"],
          tarballPath: makeTarball("invoicing", "1.0.0", { scopes: ["invoicing:items:read"] }),
        }),
      ).rejects.toThrow(/first-party catalog app/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses an outside package whose display name is a first-party app's, in any case", async () => {
    const { dir } = withInvoicingCatalog()
    try {
      await expect(
        installAppFromTarball({
          ...base,
          tarballPath: makeTarball(NAME, "1.0.0", { displayName: "INVOICING" }),
        }),
      ).rejects.toThrow(
        `Cannot install '${NAME}': its display name 'INVOICING' is reserved for a first-party app.`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses an outside package whose activity-bar label is a system label", async () => {
    await expect(
      installAppFromTarball({
        ...base,
        tarballPath: makeTarball(NAME, "1.0.0", {
          views: { activityBar: { icon: "GrantIcon", label: "Settings" } },
        }),
      }),
    ).rejects.toThrow(
      `Cannot install '${NAME}': its activity-bar label 'Settings' is reserved for a Liaison system page.`,
    )
    await expect(
      installAppFromTarball({
        ...base,
        tarballPath: makeTarball(NAME, "1.0.0", { displayName: "app store" }),
      }),
    ).rejects.toThrow(/its display name 'app store' is reserved for a Liaison system page/)
    expect(await rows()).toHaveLength(0)
  })

  // M2: a catalog key renders as the kernel's own text, so an outside app's labelKey
  // may only name its own `apps.<name>.*` keys.
  it("refuses an outside package whose labelKey names a key outside its own namespace", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        {
          views: {
            activityBar: { icon: "GrantIcon", label: "Grants", labelKey: "kernel.nav.settings" },
          },
        },
        "views.activityBar.labelKey 'kernel.nav.settings'",
      ],
      [
        {
          views: {
            tabTypes: {
              home: { component: "Home", label: "Home page", labelKey: "kernel.nav.app.shopify" },
            },
          },
        },
        "views.tabTypes.home.labelKey 'kernel.nav.app.shopify'",
      ],
      [
        {
          views: {
            activityBar: { icon: "GrantIcon", label: "Grants", labelKey: "apps.other.nav" },
          },
        },
        "views.activityBar.labelKey 'apps.other.nav'",
      ],
      [
        {
          views: {
            panels: {
              side: {
                component: "Side",
                label: "Side",
                labelKey: "kernel.appSettings.invoicing.x",
              },
            },
          },
        },
        "views.panels.side.labelKey 'kernel.appSettings.invoicing.x'",
      ],
    ]
    for (const [extra, field] of cases) {
      await expect(
        installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "1.0.0", extra) }),
      ).rejects.toThrow(
        `Cannot install '${NAME}': its ${field} is not under its own namespace apps.${NAME}.`,
      )
    }
    expect(await rows()).toHaveLength(0)
    const own = await installAppFromTarball({
      ...base,
      tarballPath: makeTarball(NAME, "1.0.0", {
        views: {
          activityBar: { icon: "GrantIcon", label: "Grants", labelKey: `apps.${NAME}.nav` },
        },
      }),
    })
    expect(own.version).toBe("1.0.0")
  })

  // M2: every label the shell shows is compared, after folding look-alike characters.
  it("refuses a system label in any shown label field, and its look-alikes", async () => {
    const section = (title: string) => ({
      settings: {
        sections: [
          {
            id: "general",
            title,
            scope: "user",
            blocks: [{ block: "field", key: "theme", type: "text", label: "Theme" }],
          },
        ],
      },
    })
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { views: { tabTypes: { home: { component: "Home", label: "Security" } } } },
        "tab label 'Security'",
      ],
      [
        { views: { panels: { side: { component: "Side", label: "Users" } } } },
        "panel label 'Users'",
      ],
      [
        { contributions: { "kernel.sidebar": { component: "Side", label: "App store" } } },
        "contribution label 'App store'",
      ],
      [section("Settings"), "settings section title 'Settings'"],
      // Cyrillic Ѕ and е, a zero-width space, full-width letters, punctuation, an accent.
      [{ displayName: "\u0405\u0435ttings" }, "display name '\u0405\u0435ttings'"],
      [{ displayName: "Set\u200btings" }, "display name 'Set\u200btings'"],
      [
        { displayName: "\uff33\uff25\uff23\uff35\uff32\uff29\uff34\uff39" },
        "display name '\uff33\uff25\uff23\uff35\uff32\uff29\uff34\uff39'",
      ],
      [{ displayName: "Settings!" }, "display name 'Settings!'"],
      [{ displayName: "S\u00e9curity" }, "display name 'S\u00e9curity'"],
      [{ displayName: "H\u03bfme" }, "display name 'H\u03bfme'"],
    ]
    for (const [extra, claim] of cases) {
      await expect(
        installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "1.0.0", extra) }),
      ).rejects.toThrow(
        `Cannot install '${NAME}': its ${claim} is reserved for a Liaison system page.`,
      )
    }
    expect(await rows()).toHaveLength(0)
  })

  it("refuses a look-alike of a first-party app's name", async () => {
    const { dir } = withInvoicingCatalog()
    try {
      await expect(
        installAppFromTarball({
          ...base,
          tarballPath: makeTarball(NAME, "1.0.0", { displayName: "\u0406nv\u043eicing" }),
        }),
      ).rejects.toThrow(/is reserved for a first-party app/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // L2: the publisher an outside app names is its own claim; it may not claim Liaison's.
  it("refuses an outside package that names Liaison or a first-party publisher as its publisher", async () => {
    const listing = (publisher: string) => ({
      listing: {
        publisher,
        category: "Support",
        icon: "ticket",
        summary: "Grants.",
        sourceRepository: "https://example.org/grants",
      },
    })
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ author: "Liaison" }, "author 'Liaison'"],
      [{ author: "Liaison Labs" }, "author 'Liaison Labs'"],
      [listing("L1aison"), "listing publisher 'L1aison'"],
      [listing("\u216ciaison"), "listing publisher '\u216ciaison'"],
    ]
    for (const [extra, claim] of cases) {
      await expect(
        installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "1.0.0", extra) }),
      ).rejects.toThrow(
        `Cannot install '${NAME}': its ${claim} is reserved for a first-party publisher.`,
      )
    }
    expect(await rows()).toHaveLength(0)
    const own = await installAppFromTarball({
      ...base,
      tarballPath: makeTarball(NAME, "1.0.0", { author: "Liaisonics Partners" }),
    })
    expect(own.version).toBe("1.0.0")
  })

  it("leaves a first-party install of that app unaffected", async () => {
    const { dir, tarball } = withInvoicingCatalog()
    try {
      const result = await installAppFromTarball({
        ...base,
        grantedScopes: ["invoicing:items:read"],
        tarballPath: tarball,
      })
      expect(result.version).toBe("3.0.0")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("upgrade must be newer", () => {
  it("rejects an older or equal signed package unless a rollback is explicit", async () => {
    await installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "2.0.0") })
    await expect(
      applyUpgrade({ ...base, name: NAME, tarballPath: makeTarball(NAME, "1.0.0") }),
    ).rejects.toThrow(/not newer/)
    await expect(
      applyUpgrade({ ...base, name: NAME, tarballPath: makeTarball(NAME, "2.0.0") }),
    ).rejects.toThrow(/not newer/)
    const rolled = await applyUpgrade({
      ...base,
      name: NAME,
      tarballPath: makeTarball(NAME, "1.0.0"),
      allowDowngrade: true,
    })
    expect(rolled.version).toBe("1.0.0")
  })

  it("a plain install over a newer active version is refused too, unless a rollback is explicit", async () => {
    await installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "2.0.0") })
    await expect(
      installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "1.0.0") }),
    ).rejects.toThrow(/older/)
    // Re-installing the same version stays allowed.
    await installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "2.0.0") })
    await installAppFromTarball({
      ...base,
      tarballPath: makeTarball(NAME, "1.0.0"),
      allowDowngrade: true,
    })
  })

  it("accepts a newer one", async () => {
    await installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "1.0.0") })
    const up = await applyUpgrade({ ...base, name: NAME, tarballPath: makeTarball(NAME, "1.0.1") })
    expect(up.version).toBe("1.0.1")
  })
})

describe("interface approval is recorded at install", () => {
  it("stores who approved and when, only when the admin said so", async () => {
    await installAppFromTarball({ ...base, tarballPath: makeTarball(NAME, "1.0.0") })
    let [row] = await rows()
    expect(row?.uiFullAccessApprovedAt).toBeNull()

    await installAppFromTarball({
      ...base,
      tarballPath: makeTarball(NAME, "1.0.0"),
      approveUiFullAccess: true,
    })
    ;[row] = await rows()
    expect(row?.uiFullAccessApprovedBy).toBe(ADMIN)
    expect(row?.uiFullAccessApprovedAt).toBeInstanceOf(Date)
  })

  it("a new version needs a new approval", async () => {
    await installAppFromTarball({
      ...base,
      tarballPath: makeTarball(NAME, "1.0.0"),
      approveUiFullAccess: true,
    })
    await applyUpgrade({ ...base, name: NAME, tarballPath: makeTarball(NAME, "1.1.0") })
    // 1.0.0 stays as the previous version, with its own approval.
    const row = (await rows()).find((r) => r.version === "1.1.0")
    expect(row).toBeDefined()
    expect(row?.uiFullAccessApprovedAt).toBeNull()
  })
})
