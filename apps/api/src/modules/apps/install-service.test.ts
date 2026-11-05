// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { redis } from "~/lib/redis"
import {
  applyUpgrade,
  installAppFromTarball,
  previewUpgrade,
  uninstallApp,
} from "~/modules/apps/install-service"
import { VERSIONS_IN_USE_KEY } from "~/modules/apps/versions-in-use"

const ADMIN = "00000000-0000-0000-0000-000000000001"
let installRoot: string

interface ManifestOverrides {
  scopes?: string[]
  updateUrl?: string
  host?: string
  sdkVersion?: string
  /** Any other manifest keys, merged in last. */
  extra?: Record<string, unknown>
}

function makeTarball(name: string, version: string, overrides: ManifestOverrides = {}): string {
  const work = mkdtempSync(join(tmpdir(), "install-pkg-"))
  const stage = join(work, "stage")
  mkdirSync(stage)
  const manifest: Record<string, unknown> = {
    name,
    version,
    packageFormat: 1,
    license: "MIT",
    scopes: overrides.scopes ?? [`${name}:items:read`],
  }
  if (overrides.updateUrl) manifest.updateUrl = overrides.updateUrl
  if (overrides.host) manifest.host = overrides.host
  if (overrides.sdkVersion) manifest.sdkVersion = overrides.sdkVersion
  Object.assign(manifest, overrides.extra ?? {})
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(stage, "bundle.js"), "// noop")
  const tar = join(work, `${name}-${version}.liaisonapp`)
  spawnSync("tar", ["-czf", tar, "-C", stage, "app.manifest.json", "bundle.js"])
  return tar
}

function makeTarballWithUi(name: string, version: string): string {
  const work = mkdtempSync(join(tmpdir(), "install-pkg-ui-"))
  const stage = join(work, "stage")
  mkdirSync(stage)
  const manifest: Record<string, unknown> = {
    name,
    version,
    packageFormat: 1,
    license: "MIT",
    scopes: [`${name}:items:read`],
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(stage, "bundle.js"), "// noop")
  writeFileSync(join(stage, "ui.js"), "export const SettingsPanel = () => null\n")
  const tar = join(work, `${name}-${version}.liaisonapp`)
  spawnSync("tar", ["-czf", tar, "-C", stage, "app.manifest.json", "bundle.js", "ui.js"])
  return tar
}

async function cleanupRows(name: string): Promise<void> {
  await withSystemDb("install-test-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, name))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, name))
  })
}

beforeEach(() => {
  installRoot = mkdtempSync(join(tmpdir(), "install-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
})
afterEach(async () => {
  rmSync(installRoot, { recursive: true, force: true })
  await cleanupRows("test-installer")
  await cleanupRows("test-installer-b")
})

describe("installAppFromTarball", () => {
  it("unpacks the tarball to install root and records the row", async () => {
    const result = await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    expect(result.name).toBe("test-installer")
    expect(existsSync(join(installRoot, "test-installer", "1.0.0", "app.manifest.json"))).toBe(true)
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-installer")),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].grantedScopes).toEqual(["test-installer:items:read"])
  })

  it("re-install of the SAME version is idempotent (upsert, not duplicate-key throw)", async () => {
    // A single `config apply` lists some apps multiple times -- e.g. `social`,
    // once per OAuth connection. When that run ALSO performs a version upgrade,
    // the first entry inserts the new (name, version) apps_installed row and the
    // later entries re-hit the install path; the insert must upsert in place, not
    // throw a duplicate-key error (regression: config apply exited 1 mid-run).
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    // Second install of the SAME package must NOT throw, must leave exactly one
    // row, and must reflect the latest install's metadata (updated in place).
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
      sourceUrl: "https://apps.example.com/test-installer/1.0.0.liaisonapp",
    })
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-installer")),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].sourceUrl).toBe("https://apps.example.com/test-installer/1.0.0.liaisonapp")
  })

  it("a same-version package with other files is refused: a version directory is never rewritten", async () => {
    // Every process of a deployment loads apps from one install root, and an old
    // process may be running the files of this version (modules/apps/version-dir.ts).
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    await expect(
      installAppFromTarball({
        tarballPath: makeTarball("test-installer", "1.0.0", {
          updateUrl: "https://apps.example.com/test-installer/latest.liaisonapp",
        }),
        installedBy: ADMIN,
        grantedScopes: ["test-installer:items:read"],
        requireSignature: false,
      }),
    ).rejects.toThrow("never rewritten in place")
  })

  it("keeps the previous version dir and prunes older ones (two dirs per app, S5)", async () => {
    // Discovery registers only the active version (apps_active_version), so the
    // previous version's dir can stay for a switch-back or a rollback; anything
    // older is pruned.
    await cleanupRows("prune-test")
    for (const version of ["1.0.0", "1.0.1", "1.0.2"]) {
      await installAppFromTarball({
        tarballPath: makeTarball("prune-test", version),
        installedBy: ADMIN,
        grantedScopes: ["prune-test:items:read"],
        requireSignature: false,
      })
    }
    expect(readdirSync(join(installRoot, "prune-test")).sort()).toEqual(["1.0.1", "1.0.2"])
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "prune-test")),
    )
    expect(rows.map((r) => r.version).sort()).toEqual(["1.0.1", "1.0.2"])
    const [active] = await withSystemDb("t", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, "prune-test")),
    )
    expect(active).toMatchObject({ version: "1.0.2", previousVersion: "1.0.1" })

    await cleanupRows("prune-test")
  })

  it("never prunes a version a live process still loads (an old release after a rolled-back deploy)", async () => {
    // An old process of a live release announced that it loads 1.0.0; the
    // active row then moved twice (a rolled-back deploy, then the next one).
    await cleanupRows("prune-test")
    const oldProcess = "rolling-old-process"
    const deadProcess = "rolling-dead-process"
    await redis.set(LIVE_INSTANCE_KEY(oldProcess), "{}", "PX", 60_000)
    await redis.hset(
      VERSIONS_IN_USE_KEY,
      oldProcess,
      JSON.stringify({ versions: { "prune-test": ["1.0.0"] } }),
    )
    // A dead process's announcement (no heartbeat record) keeps nothing.
    await redis.hset(
      VERSIONS_IN_USE_KEY,
      deadProcess,
      JSON.stringify({ versions: { "prune-test": ["1.0.1"] } }),
    )
    try {
      for (const version of ["1.0.0", "1.0.1", "1.0.2", "1.0.3"]) {
        await installAppFromTarball({
          tarballPath: makeTarball("prune-test", version),
          installedBy: ADMIN,
          grantedScopes: ["prune-test:items:read"],
          requireSignature: false,
        })
      }
      expect(readdirSync(join(installRoot, "prune-test")).sort()).toEqual([
        "1.0.0",
        "1.0.2",
        "1.0.3",
      ])
      const rows = await withSystemDb("t", (db) =>
        db.select().from(appsInstalled).where(eq(appsInstalled.name, "prune-test")),
      )
      expect(rows.map((r) => r.version).sort()).toEqual(["1.0.0", "1.0.2", "1.0.3"])
    } finally {
      await redis.del(LIVE_INSTANCE_KEY(oldProcess))
      await redis.hdel(VERSIONS_IN_USE_KEY, oldProcess, deadProcess)
      await cleanupRows("prune-test")
    }
  })

  it("rejects install of an app whose name matches a bundled app", async () => {
    await expect(
      installAppFromTarball({
        tarballPath: makeTarball("mail", "99.0.0"),
        installedBy: ADMIN,
        grantedScopes: ["mail:items:read"],
        requireSignature: false,
      }),
    ).rejects.toThrow(/bundled/i)
  })

  it("rejects install of a scope the admin didn't grant", async () => {
    await expect(
      installAppFromTarball({
        tarballPath: makeTarball("test-installer", "1.0.0"),
        installedBy: ADMIN,
        grantedScopes: [],
        requireSignature: false,
      }),
    ).rejects.toThrow(/scope/i)
  })

  it("refuses an app whose host API range this server cannot satisfy (S3)", async () => {
    await expect(
      installAppFromTarball({
        tarballPath: makeTarball("test-installer", "1.0.0", { host: "^9" }),
        installedBy: ADMIN,
        grantedScopes: ["test-installer:items:read"],
        requireSignature: false,
      }),
    ).rejects.toThrow(
      "test-installer 1.0.0 needs host API ^9; this server provides host API 1.1.0. Update Liaison first.",
    )
    expect(existsSync(join(installRoot, "test-installer", "1.0.0"))).toBe(false)
  })

  it("installs an app that declares no host range (treated as ^1)", async () => {
    const result = await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    expect(result.version).toBe("1.0.0")
  })

  it("ignores sdkVersion: an app built against any SDK version installs", async () => {
    const result = await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0", { sdkVersion: "9.9.9", host: "^1" }),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    expect(result.version).toBe("1.0.0")
  })

  it("refuses an app icon that is not plain drawing markup, naming what it found (S1)", async () => {
    const iconSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script><path d="M0 0"/></svg>'
    await expect(
      installAppFromTarball({
        tarballPath: makeTarball("test-installer", "1.0.0", { extra: { iconSvg } }),
        installedBy: ADMIN,
        grantedScopes: ["test-installer:items:read"],
        requireSignature: false,
      }),
    ).rejects.toThrow("Cannot install 'test-installer': its iconSvg contains the element <script>")
    expect(existsSync(join(installRoot, "test-installer", "1.0.0"))).toBe(false)
  })

  it("refuses an iconName that is not in Liaison's icon set (S1)", async () => {
    await expect(
      installAppFromTarball({
        tarballPath: makeTarball("test-installer", "1.0.0", { extra: { iconName: "skull" } }),
        installedBy: ADMIN,
        grantedScopes: ["test-installer:items:read"],
        requireSignature: false,
      }),
    ).rejects.toThrow(/iconName 'skull' is not an icon of Liaison's icon set/)
  })

  it("installs an app whose icon is clean markup, kept byte for byte (S1)", async () => {
    const iconSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 3v18h18" fill="none" stroke="currentColor"/></svg>'
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0", {
        extra: { iconSvg, iconName: "gauge" },
      }),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    const installed = JSON.parse(
      readFileSync(join(installRoot, "test-installer", "1.0.0", "app.manifest.json"), "utf8"),
    )
    expect(installed.iconSvg).toBe(iconSvg)
    expect(installed.iconName).toBe("gauge")
  })

  it("copies the manifest's updateUrl into the apps_installed row", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0", {
        updateUrl: "https://apps.example.com/test-installer/latest.liaisonapp",
      }),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-installer")),
    )
    expect(rows[0].updateUrl).toBe("https://apps.example.com/test-installer/latest.liaisonapp")
  })

  it("leaves updateUrl null when the manifest omits it (install-only app)", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-installer")),
    )
    expect(rows[0].updateUrl).toBeNull()
  })
})

/** A manifest declaring one tab type with this URL pattern. */
function withTab(urlPattern: string): ManifestOverrides {
  return { extra: { views: { tabTypes: { board: { component: "Board", urlPattern } } } } }
}

// A tab pattern decides which page URL opens the tab, and a framed app may navigate to (and
// receives the id of) any path that opens one of its own tabs: its first segment must be its own.
describe("tab URL patterns an app may declare", () => {
  async function install(name: string, urlPattern: string): Promise<unknown> {
    return installAppFromTarball({
      tarballPath: makeTarball(name, "1.0.0", withTab(urlPattern)),
      installedBy: ADMIN,
      grantedScopes: [`${name}:items:read`],
      requireSignature: false,
    })
  }

  it("refuses a pattern that starts with a parameter, under a Liaison page or under another app", async () => {
    const refused: Array<[string, string]> = [
      [
        "/:a/:b",
        "its tab urlPattern '/:a/:b' starts with a parameter: its first segment must be a fixed name the app owns (/test-installer/...).",
      ],
      [
        "/settings/:x",
        "its tab urlPattern '/settings/:x' is under '/settings', a Liaison page route.",
      ],
      [
        "/mail/:entityIdXXXXXXXX",
        "its tab urlPattern '/mail/:entityIdXXXXXXXX' is under '/mail', which belongs to the app 'mail'.",
      ],
      [
        "/",
        "its tab urlPattern '/' must start with a fixed path segment the app owns (/test-installer/...).",
      ],
    ]
    for (const [pattern, message] of refused) {
      await expect(install("test-installer", pattern)).rejects.toThrow(
        `Cannot install 'test-installer': ${message}`,
      )
    }
    expect(existsSync(join(installRoot, "test-installer", "1.0.0"))).toBe(false)
  })

  it("keeps a prefix of its own beside its name for that app alone", async () => {
    // Like a KPI app's `/kpi-catalogue/:entityId+`: no other app owns the segment.
    await install("test-installer", "/ti-catalogue/:entityId+")
    await expect(install("test-installer-b", "/ti-catalogue/:entityIdLonger")).rejects.toThrow(
      "Cannot install 'test-installer-b': its tab urlPattern '/ti-catalogue/:entityIdLonger' is under '/ti-catalogue', which belongs to the app 'test-installer'.",
    )
    await expect(install("test-installer-b", "/test-installer/:x")).rejects.toThrow(
      "which belongs to the app 'test-installer'.",
    )
    await install("test-installer-b", "/test-installer-b/board/:entityId")
  })

  it("applyUpgrade refuses a version whose tab pattern is not its own", async () => {
    await install("test-installer", "/test-installer/board/:entityId")
    await expect(
      applyUpgrade({
        name: "test-installer",
        tarballPath: makeTarball("test-installer", "1.1.0", withTab("/tickets/:entityIdXXXX")),
        installedBy: ADMIN,
        grantedScopes: ["test-installer:items:read"],
        requireSignature: false,
      }),
    ).rejects.toThrow(
      "Cannot install 'test-installer': its tab urlPattern '/tickets/:entityIdXXXX' is under '/tickets', which belongs to the app 'tickets'.",
    )
    expect(existsSync(join(installRoot, "test-installer", "1.1.0"))).toBe(false)
  })
})

describe("upgrade flow (preview + apply)", () => {
  it("previewUpgrade returns the scope diff WITHOUT mutating disk or DB", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    const preview = await previewUpgrade({
      name: "test-installer",
      tarballPath: makeTarball("test-installer", "1.1.0", {
        scopes: ["test-installer:items:read", "test-installer:items:write"],
      }),
      requireSignature: false,
    })
    expect(preview.newScopes).toEqual(["test-installer:items:write"])
    expect(preview.removedScopes).toEqual([])
    expect(preview.manifest.version).toBe("1.1.0")
    expect(existsSync(join(installRoot, "test-installer", "1.0.0"))).toBe(true)
    expect(existsSync(join(installRoot, "test-installer", "1.1.0"))).toBe(false)
    // Pure: no `1.1.0` row was inserted — only the original `1.0.0` row exists.
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-installer")),
    )
    expect(rows.map((r) => r.version)).toEqual(["1.0.0"])
  })

  it("applyUpgrade succeeds when all new scopes are explicitly granted (atomic swap)", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    await applyUpgrade({
      name: "test-installer",
      tarballPath: makeTarball("test-installer", "1.1.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-installer")),
    )
    expect(rows.map((r) => r.version).sort()).toEqual(["1.0.0", "1.1.0"])
    expect(existsSync(join(installRoot, "test-installer", "1.1.0"))).toBe(true)
    // The version that ran before stays, as the previous version (S5).
    expect(existsSync(join(installRoot, "test-installer", "1.0.0"))).toBe(true)
    const [active] = await withSystemDb("t", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, "test-installer")),
    )
    expect(active).toMatchObject({ version: "1.1.0", previousVersion: "1.0.0" })
  })

  it("applyUpgrade refuses a version whose host API range this server cannot satisfy (S3)", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    await expect(
      applyUpgrade({
        name: "test-installer",
        tarballPath: makeTarball("test-installer", "1.1.0", { host: "^9" }),
        installedBy: ADMIN,
        grantedScopes: ["test-installer:items:read"],
        requireSignature: false,
      }),
    ).rejects.toThrow(
      "test-installer 1.1.0 needs host API ^9; this server provides host API 1.1.0. Update Liaison first.",
    )
    expect(existsSync(join(installRoot, "test-installer", "1.0.0"))).toBe(true)
    expect(existsSync(join(installRoot, "test-installer", "1.1.0"))).toBe(false)
  })

  it("applyUpgrade rejects if a new scope wasn't granted (forces re-prompt)", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    await expect(
      applyUpgrade({
        name: "test-installer",
        tarballPath: makeTarball("test-installer", "1.1.0", {
          scopes: ["test-installer:items:read", "test-installer:items:write"],
        }),
        installedBy: ADMIN,
        grantedScopes: ["test-installer:items:read"],
        requireSignature: false,
      }),
    ).rejects.toThrow(/new scope|grant/i)
    expect(existsSync(join(installRoot, "test-installer", "1.0.0"))).toBe(true)
    expect(existsSync(join(installRoot, "test-installer", "1.1.0"))).toBe(false)
  })

  it("applyUpgrade leaves the old version intact when the new copy fails (atomic-swap guarantee)", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    await expect(
      applyUpgrade({
        name: "test-installer",
        tarballPath: "/nonexistent.liaisonapp",
        installedBy: ADMIN,
        grantedScopes: ["test-installer:items:read"],
        requireSignature: false,
      }),
    ).rejects.toThrow()
    expect(existsSync(join(installRoot, "test-installer", "1.0.0"))).toBe(true)
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-installer")),
    )
    expect(rows.some((r) => r.version === "1.0.0")).toBe(true)
  })

  it("applyUpgrade to a version kept as the previous one records it in place", async () => {
    // After a rollback the newer version is still kept (row and files); upgrading
    // to it again updates its row instead of failing on the (name, version) key.
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    await withSystemDb("seed-kept", (db) =>
      db.insert(appsInstalled).values({
        name: "test-installer",
        version: "1.1.0",
        sourceUrl: "x",
        sha256: "a".repeat(64),
        installedBy: ADMIN,
      }),
    )
    await applyUpgrade({
      name: "test-installer",
      tarballPath: makeTarball("test-installer", "1.1.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-installer")),
    )
    expect(rows.map((r) => r.version).sort()).toEqual(["1.0.0", "1.1.0"])
    expect(rows.find((r) => r.version === "1.1.0")?.sha256).not.toBe("a".repeat(64))
    const [active] = await withSystemDb("t", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, "test-installer")),
    )
    expect(active).toMatchObject({ version: "1.1.0", previousVersion: "1.0.0" })
  })
})

describe("installAppFromTarball — UI bundle", () => {
  it("extracts ui.js into the install root version dir", async () => {
    const result = await installAppFromTarball({
      tarballPath: makeTarballWithUi("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    const expected = join(installRoot, result.name, result.version, "ui.js")
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected, "utf8")).toContain("SettingsPanel")
  })

  it("install without ui.js does not write ui.js", async () => {
    const result = await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    expect(existsSync(join(installRoot, result.name, result.version, "ui.js"))).toBe(false)
  })
})

describe("uninstallApp", () => {
  it("removes the row and the install dir", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball("test-installer", "1.0.0"),
      installedBy: ADMIN,
      grantedScopes: ["test-installer:items:read"],
      requireSignature: false,
    })
    await uninstallApp({ name: "test-installer" })
    const rows = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, "test-installer")),
    )
    expect(rows).toHaveLength(0)
    expect(existsSync(join(installRoot, "test-installer"))).toBe(false)
  })
})
