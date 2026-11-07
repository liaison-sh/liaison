// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Apps live in every server process without a restart (S1.1-S1.3, A7-A9).
//
// One bun process plays the peer: what another process did is written straight
// into the database (and object storage), and this process follows it the way
// a peer does, through `syncActiveVersionsFromDb` (the announcement's handler)
// or the upkeep reconcile (no announcement at all, A7).
//
// - S1.1: an app uninstalled elsewhere is unregistered here (tools, job
//   handlers, local files), and an uninstall announces itself to the peers.
// - S1.2: an app first installed elsewhere registers in the orgs already
//   running here, and its job queue is bound at once.
// - S1.3: an installed package is stored once in object storage under
//   `instance/apps/<name>/<version>.liaisonapp`; a process whose install root
//   lacks the active version fetches it, checks the sha256 recorded at install,
//   and unpacks it before registering. Pruning and uninstall delete the stored
//   packages (A8).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { advisoryLockKey } from "~/db/advisory-lock"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import {
  appActivationEvents,
  appsActiveVersion,
  appsInstalled,
} from "~/db/schema/kernel/apps-installed"
import { isJobWorkerRegistered, JobsTestAccess } from "~/infra/jobs/jobs"
import { getObjectBuffer, putObject } from "~/infra/storage/object-storage"
import { redis } from "~/lib/redis"
import * as activation from "~/modules/apps/activation"
import {
  initializedOrgRuntimes,
  registeredAppVersions,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { bumpCatalogGeneration } from "~/modules/apps/catalog-generation"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { applyUpgrade, installAppFromTarball, uninstallApp } from "~/modules/apps/install-service"

const TEST_ORG = "00000000-0000-0000-0000-0000000a7f01"
const TEST_USER = "00000000-0000-0000-0000-0000000a7f02"
const ADMIN = "00000000-0000-0000-0000-000000000001"
// Unique per run: object storage is shared by every checkout's runs.
const APP = `live-peers-${Date.now().toString(36)}`
const SCOPES = [`${APP}:items:read`]
const JOB = "sweep"

let installRoot: string
const work: string[] = []

/** A `.liaisonapp` with one tool and one on-demand job; `salt` changes its bytes. */
function tarball(version: string, salt = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "live-peers-pkg-"))
  work.push(dir)
  const stage = join(dir, "stage")
  mkdirSync(stage)
  const manifest = {
    name: APP,
    version,
    packageFormat: 1,
    license: "MIT",
    scopes: SCOPES,
    tools: {
      list_items: {
        description: `List items ${version}`,
        requiredScopes: SCOPES,
        readOnly: true,
        handler: "list_items",
      },
    },
    jobs: { [JOB]: { handler: JOB, onDemand: true } },
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(
    join(stage, "bundle.js"),
    `function list_items() { return { version: "${version}" } }\nfunction ${JOB}() {}\n// ${salt}\n`,
  )
  const tar = join(dir, `${APP}-${version}.liaisonapp`)
  spawnSync("tar", ["-czf", tar, "-C", stage, "app.manifest.json", "bundle.js"])
  return tar
}

const install = (version: string) =>
  installAppFromTarball({
    tarballPath: tarball(version),
    installedBy: ADMIN,
    grantedScopes: SCOPES,
    requireSignature: false,
  })

const upgrade = (version: string) =>
  applyUpgrade({
    name: APP,
    tarballPath: tarball(version),
    installedBy: ADMIN,
    grantedScopes: SCOPES,
    requireSignature: false,
  })

const tool = () => toolRegistry.get([TEST_ORG, APP, "list_items"])
const running = () => registeredAppVersions.get(`${TEST_ORG}:${APP}`)
const storedKey = (version: string) => `instance/apps/${APP}/${version}.liaisonapp`

async function stored(version: string): Promise<Buffer | null> {
  try {
    return await getObjectBuffer(storedKey(version))
  } catch {
    return null
  }
}

/** Another process removed the app: only the database says so. */
async function deleteRowsElsewhere(): Promise<void> {
  await withSystemDb("t", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, APP))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP))
  })
}

/** This process has never seen the app: nothing registered, no queue bound. */
async function forgetLocally(): Promise<void> {
  const { unregisterAppEverywhere } = await import("~/modules/apps/runtime")
  await unregisterAppEverywhere(APP)
  JobsTestAccess.forgetQueueBinding(`app-${APP}`)
  activation.ActivationSyncTestAccess.forget(APP)
  bumpCatalogGeneration()
}

/** The upkeep reconcile (A7), when this tree has it. */
async function upkeep(): Promise<void> {
  const run = (activation as Record<string, unknown>).runInstalledAppsUpkeep as
    | (() => Promise<void>)
    | undefined
  if (!run) throw new Error("activation.runInstalledAppsUpkeep is missing")
  await run()
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${TEST_ORG}, 'Live Peers Org', 'live-peers-org') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${TEST_USER}, ${TEST_ORG}, 'live-peers@test.com', 'hash', 'L', 'active')
    ON CONFLICT (id) DO NOTHING`
  // The org runs in this process: what another process installs must reach it.
  await ensureAppsForOrg(TEST_ORG)
}, 120_000)

beforeEach(() => {
  installRoot = mkdtempSync(join(tmpdir(), "live-peers-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
})

afterEach(async () => {
  const { unregisterAppEverywhere } = await import("~/modules/apps/runtime")
  await unregisterAppEverywhere(APP)
  // Let this process forget the app too, so the next case starts unseen.
  await deleteRowsElsewhere()
  await activation.syncActiveVersionsFromDb().catch(() => {})
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APPS_DIR
  await withSystemDb("t", (db) =>
    db.delete(appActivationEvents).where(eq(appActivationEvents.app, APP)),
  )
  await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP}`
  const { deleteObjects } = await import("~/infra/storage/object-storage")
  await deleteObjects(["1.0.0", "2.0.0", "3.0.0"].map(storedKey)).catch(() => {})
  bumpCatalogGeneration()
})

afterAll(async () => {
  for (const dir of work) rmSync(dir, { recursive: true, force: true })
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("S1.1: an uninstall reaches the peers", () => {
  it("a peer unregisters an app uninstalled elsewhere: tools, job handlers and local files", async () => {
    await install("1.0.0")
    // This process followed the install (as a peer does on its announcement).
    await activation.syncActiveVersionsFromDb()
    expect(tool()).toBeDefined()
    expect(isJobWorkerRegistered(APP, JOB)).toBe(true)

    await deleteRowsElsewhere()
    await activation.syncActiveVersionsFromDb()

    expect(tool()).toBeUndefined()
    expect(running()).toBeUndefined()
    expect(isJobWorkerRegistered(APP, JOB)).toBe(false)
    expect(existsSync(join(installRoot, APP))).toBe(false)
  }, 60_000)

  it("an uninstall announces itself to the other processes", async () => {
    await install("1.0.0")
    const listener = redis.duplicate()
    const messages: string[] = []
    try {
      await listener.subscribe(activation.ACTIVE_VERSIONS_CHANNEL)
      listener.on("message", (_channel: string, message: string) => messages.push(message))
      // The install's own announcement may still be on its way: count only what
      // arrives once the uninstall starts.
      await Bun.sleep(300)
      messages.length = 0
      await uninstallApp({ name: APP })
      for (let i = 0; i < 40 && messages.length === 0; i++) await Bun.sleep(50)
    } finally {
      await listener.quit()
    }
    expect(messages.length).toBeGreaterThan(0)
  }, 60_000)

  it("A7: with no announcement, the upkeep unregisters an app that has no active version", async () => {
    await install("1.0.0")
    expect(tool()).toBeDefined()
    await deleteRowsElsewhere()
    await upkeep()
    expect(tool()).toBeUndefined()
    expect(isJobWorkerRegistered(APP, JOB)).toBe(false)
  }, 60_000)
})

describe("S1.2: a first install reaches the orgs running in a peer", () => {
  it("a peer registers an app first installed elsewhere in its running orgs", async () => {
    await install("1.0.0")
    await forgetLocally()
    expect(tool()).toBeUndefined()

    await activation.syncActiveVersionsFromDb()

    expect(running()).toBe("1.0.0")
    expect(tool()?.description).toBe("List items 1.0.0")
  }, 60_000)

  it("a peer binds the new app's job queue at once", async () => {
    await install("1.0.0")
    await forgetLocally()
    expect(JobsTestAccess.isQueueBound(`app-${APP}`)).toBe(false)

    await activation.syncActiveVersionsFromDb()

    expect(JobsTestAccess.isQueueBound(`app-${APP}`)).toBe(true)
  }, 60_000)

  it("A7: with no announcement, the upkeep registers an active app missing from a running org", async () => {
    await install("1.0.0")
    await forgetLocally()
    await upkeep()
    expect(running()).toBe("1.0.0")
  }, 60_000)
})

describe("S1.3: the package store", () => {
  it("an install stores the package once, its sha256 the one on the install row", async () => {
    await install("1.0.0")
    const bytes = await stored("1.0.0")
    expect(bytes).not.toBeNull()
    const [row] = await withSystemDb("t", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, APP)),
    )
    expect(
      createHash("sha256")
        .update(bytes as Buffer)
        .digest("hex"),
    ).toBe(row?.sha256)
  }, 60_000)

  it("a peer with an empty install root fetches, unpacks, then registers the active version", async () => {
    await install("1.0.0")
    // The peer's own install root: empty.
    const peerRoot = mkdtempSync(join(tmpdir(), "live-peers-peer-"))
    work.push(peerRoot)
    process.env.LIAISON_APPS_DIR = peerRoot
    await forgetLocally()

    await activation.syncActiveVersionsFromDb()

    expect(existsSync(join(peerRoot, APP, "1.0.0", "bundle.js"))).toBe(true)
    expect(running()).toBe("1.0.0")
    expect(tool()).toBeDefined()
  }, 60_000)

  it("a stored package whose sha256 differs is refused and the peer keeps its previous state", async () => {
    await install("1.0.0")
    // Other bytes under the same key (a tampered or mixed-up store).
    await putObject({
      key: storedKey("1.0.0"),
      body: readFileSync(tarball("1.0.0", "other bytes")),
      contentType: "application/gzip",
    })
    const peerRoot = mkdtempSync(join(tmpdir(), "live-peers-peer-"))
    work.push(peerRoot)
    process.env.LIAISON_APPS_DIR = peerRoot
    await forgetLocally()

    await activation.syncActiveVersionsFromDb()

    expect(existsSync(join(peerRoot, APP, "1.0.0"))).toBe(false)
    expect(running()).toBeUndefined()
    const store = await import("~/modules/apps/package-store")
    await expect(store.ensureBundleMaterialised(APP, "1.0.0")).rejects.toThrow(/sha256/)
  }, 60_000)

  it("an upgrade stores its package too, and pruning deletes the pruned version's package", async () => {
    await install("1.0.0")
    await upgrade("2.0.0")
    expect(await stored("2.0.0")).not.toBeNull()
    await upgrade("3.0.0")
    // The server keeps the active version and the one before it (S5).
    expect(await stored("1.0.0")).toBeNull()
    expect(await stored("2.0.0")).not.toBeNull()
    expect(await stored("3.0.0")).not.toBeNull()
  }, 60_000)

  it("an uninstall deletes every stored package of the app", async () => {
    await install("1.0.0")
    await upgrade("2.0.0")
    await uninstallApp({ name: APP })
    expect(await stored("1.0.0")).toBeNull()
    expect(await stored("2.0.0")).toBeNull()
  }, 60_000)

  it("the boot step materialises every active version missing from the install root", async () => {
    await install("1.0.0")
    const freshRoot = mkdtempSync(join(tmpdir(), "live-peers-boot-"))
    work.push(freshRoot)
    process.env.LIAISON_APPS_DIR = freshRoot
    const store = await import("~/modules/apps/package-store")
    const result = await store.materialiseActiveVersions()
    // apps_active_version is instance-wide and outlives the per-file reset (it has no org), so
    // an earlier file of the same process can leave other apps' active rows behind whose
    // packages this run never stored. Their outcome is not this case's subject: this app's is.
    expect(result.failed.filter((f) => f.app.startsWith(`${APP}@`))).toEqual([])
    expect(result.materialised).toContain(`${APP}@1.0.0`)
    expect(existsSync(join(freshRoot, APP, "1.0.0", "bundle.js"))).toBe(true)
  }, 60_000)
})

/** Hold the app's activation lock from another session until `release` is called. */
async function holdActivationLock(): Promise<{ release: () => Promise<void> }> {
  let release!: () => void
  const held = new Promise<void>((r) => {
    release = r
  })
  let locked!: () => void
  const gotLock = new Promise<void>((r) => {
    locked = r
  })
  const key = advisoryLockKey(`app-activate:${APP}`).toString()
  const holder = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${key}::bigint)`
    locked()
    await held
  })
  await gotLock
  return {
    release: async () => {
      release()
      await holder
    },
  }
}

async function pointerRow() {
  const [row] = await withSystemDb("t", (db) =>
    db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, APP)),
  )
  return row ?? null
}

describe("K2: uninstall and install take the app's activation lock", () => {
  it("an uninstall waits for an activation of the app in flight elsewhere", async () => {
    await install("1.0.0")
    const lock = await holdActivationLock()
    let done = false
    const un = uninstallApp({ name: APP }).then(() => {
      done = true
    })
    try {
      await Bun.sleep(400)
      expect(done).toBe(false)
      expect(await pointerRow()).not.toBeNull()
    } finally {
      await lock.release()
    }
    await un
    expect(await pointerRow()).toBeNull()
  }, 60_000)

  it("an install places and records nothing while an activation of the app is in flight", async () => {
    const lock = await holdActivationLock()
    let done = false
    const run = install("1.0.0").then(() => {
      done = true
    })
    try {
      await Bun.sleep(400)
      expect(done).toBe(false)
      expect(existsSync(join(installRoot, APP, "1.0.0"))).toBe(false)
      const rows = await withSystemDb("t", (db) =>
        db.select().from(appsInstalled).where(eq(appsInstalled.name, APP)),
      )
      expect(rows).toEqual([])
    } finally {
      await lock.release()
    }
    await run
    expect((await pointerRow())?.version).toBe("1.0.0")
  }, 60_000)
})

describe("K3: storing the package is strict for an operator's install, best effort for a catalog repair", () => {
  async function faults(): Promise<{ failing: boolean }> {
    const store = (await import("~/modules/apps/package-store")) as Record<string, unknown>
    const seam = store.packageStoreFaults as { failing: boolean } | undefined
    if (!seam) throw new Error("package-store.packageStoreFaults is missing")
    return seam
  }

  it("object storage down: an install fails with nothing placed or recorded", async () => {
    const seam = await faults()
    seam.failing = true
    try {
      await expect(install("1.0.0")).rejects.toThrow()
    } finally {
      seam.failing = false
    }
    expect(existsSync(join(installRoot, APP, "1.0.0"))).toBe(false)
    expect(await pointerRow()).toBeNull()
  }, 60_000)

  it("object storage down: a catalog repair still installs and activates", async () => {
    const seam = await faults()
    seam.failing = true
    try {
      await installAppFromTarball({
        tarballPath: tarball("1.0.0"),
        installedBy: ADMIN,
        grantedScopes: SCOPES,
        requireSignature: false,
        storeBestEffort: true,
      })
    } finally {
      seam.failing = false
    }
    expect((await pointerRow())?.version).toBe("1.0.0")
    expect(running()).toBe("1.0.0")
    expect(await stored("1.0.0")).toBeNull()
  }, 60_000)
})

describe("K4: the boot step back-fills the package store", () => {
  it("a catalog version missing from the store is uploaded from the image's baked tarball", async () => {
    const catalogDir = mkdtempSync(join(tmpdir(), "live-peers-catalog-"))
    work.push(catalogDir)
    const baked = tarball("1.0.0", "baked")
    writeFileSync(join(catalogDir, "pkg.liaisonapp"), readFileSync(baked))
    writeFileSync(
      join(catalogDir, "catalog.json"),
      JSON.stringify([
        { name: APP, version: "1.0.0", file: "pkg.liaisonapp", scopes: SCOPES, connections: [] },
      ]),
    )
    const before = process.env.LIAISON_APP_CATALOG_DIR
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    try {
      await installAppFromTarball({
        tarballPath: join(catalogDir, "pkg.liaisonapp"),
        installedBy: ADMIN,
        grantedScopes: SCOPES,
        requireSignature: false,
      })
      const { deleteObjects } = await import("~/infra/storage/object-storage")
      await deleteObjects([storedKey("1.0.0")])
      expect(await stored("1.0.0")).toBeNull()

      const store = await import("~/modules/apps/package-store")
      await store.materialiseActiveVersions()

      const bytes = await stored("1.0.0")
      expect(bytes).not.toBeNull()
      expect(
        createHash("sha256")
          .update(bytes as Buffer)
          .digest("hex"),
      ).toBe(createHash("sha256").update(readFileSync(baked)).digest("hex"))
    } finally {
      if (before === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
      else process.env.LIAISON_APP_CATALOG_DIR = before
    }
  }, 60_000)

  it("an uploaded version missing from the store is named, to be reinstalled", async () => {
    await install("1.0.0")
    const { deleteObjects } = await import("~/infra/storage/object-storage")
    await deleteObjects([storedKey("1.0.0")])
    const store = await import("~/modules/apps/package-store")
    const result = (await store.materialiseActiveVersions()) as { unstored?: string[] }
    expect(result.unstored).toContain(`${APP}@1.0.0`)
  }, 60_000)
})

describe("K5: an org where the version fails does not re-register it everywhere on each sync", () => {
  const OTHER_ORG = "00000000-0000-0000-0000-0000000a7f03"

  it("after one follow, later announcements and the upkeep register in no org again", async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${OTHER_ORG}, 'Live Peers Other', 'live-peers-other') ON CONFLICT (id) DO NOTHING`
    let switches = 0
    try {
      await install("1.0.0")
      initializedOrgRuntimes.add(OTHER_ORG)
      // The version never stays registered in the other org (it fails there).
      activation.activationGate.beforeOrgSwitch = async () => {
        switches++
      }
      activation.activationGate.afterOrgSwitch = async (orgId) => {
        if (orgId === OTHER_ORG) registeredAppVersions.delete(`${OTHER_ORG}:${APP}`)
      }
      await forgetLocally()
      await activation.syncActiveVersionsFromDb()
      expect(running()).toBe("1.0.0")
      expect(switches).toBeGreaterThan(0)

      switches = 0
      await activation.syncActiveVersionsFromDb()
      await activation.syncActiveVersionsFromDb()
      await upkeep()
      expect(switches).toBe(0)
    } finally {
      activation.activationGate.beforeOrgSwitch = undefined
      activation.activationGate.afterOrgSwitch = undefined
      initializedOrgRuntimes.delete(OTHER_ORG)
      registeredAppVersions.delete(`${OTHER_ORG}:${APP}`)
      await sql`DELETE FROM kernel.apps WHERE org_id = ${OTHER_ORG}`
      await sql`DELETE FROM kernel.audit_log WHERE org_id = ${OTHER_ORG}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${OTHER_ORG}`.catch(() => {})
    }
  }, 60_000)
})
