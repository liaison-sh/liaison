// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App builder drafts (migration 0276) on real Postgres: org isolation and the
// kernel:apps:build write rule (FORCE RLS), one live draft per base, the
// immutable published app name, the 20-version window and the artifacts that
// go with it, the 512 KiB files limit, restore and discard.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withRlsContext } from "~/db/rls"
import { appBuildArtifacts, appDrafts } from "~/db/schema/kernel"
import {
  createDraft,
  DRAFT_VERSIONS_KEPT,
  DraftError,
  discardDraft,
  draftAppName,
  getBuildArtifact,
  getDraft,
  listDrafts,
  listDraftVersions,
  markDraftPublished,
  recordVersionBuild,
  restoreDraftVersion,
  updateDraftFiles,
} from "~/modules/app-builder/drafts"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let otherOrgId = ""
let builder = ""
let outsider = ""

const BUILD = ["kernel:apps:build"]

function as<T>(
  userId: string,
  scopes: string[],
  fn: (tx: RlsClient) => Promise<T>,
  org = orgId,
): Promise<T> {
  return withRlsContext({ actorType: "user", userId, orgId: org, scopes, dimensionGrants: {} }, fn)
}

const files = (handlers = "export const ping = () => 'pong'\n") => ({
  "app.manifest.json": JSON.stringify({ name: "x", version: "0.1.0" }),
  "handlers.ts": handlers,
})

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "ok"
  } catch (err) {
    return err instanceof DraftError ? err.code : `thrown:${(err as Error).message}`
  }
}

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "App Builder Org" })
  orgId = org.orgId
  builder = (await minimal.person(orgId)).id
  const other = await minimal.secondOrg({ name: "App Builder Other Org" })
  otherOrgId = other.orgId
  outsider = other.adminUserId
})

afterAll(async () => {
  await releaseTestLock()
})

describe("app drafts", () => {
  it("a draft is its org's alone, and only kernel:apps:build writes one", async () => {
    const { draft, version } = await as(builder, BUILD, (tx) =>
      createDraft(
        tx,
        { orgId, userId: builder },
        { baseName: "tracker", title: "Tracker", files: files() },
      ),
    )
    expect(version.n).toBe(1)
    expect(draft.status).toBe("draft")
    // Another org sees nothing, even with the scope.
    const seen = await as(outsider, ["*"], (tx) => listDrafts(tx), otherOrgId)
    expect(seen.map((d) => d.id)).not.toContain(draft.id)
    expect(await code(as(outsider, ["*"], (tx) => getDraft(tx, draft.id), otherOrgId))).toBe(
      "not_found",
    )
    // The org reads it; without kernel:apps:build nobody writes.
    expect((await as(builder, [], (tx) => getDraft(tx, draft.id))).draft.id).toBe(draft.id)
    expect(
      await code(
        as(builder, [], (tx) =>
          createDraft(
            tx,
            { orgId, userId: builder },
            { baseName: "nope", title: "N", files: files() },
          ),
        ),
      ),
    ).toStartWith("thrown:")
    expect(
      await code(
        as(builder, [], (tx) =>
          updateDraftFiles(tx, { orgId, userId: builder }, { draftId: draft.id, files: files() }),
        ),
      ),
    ).not.toBe("ok")
  })

  it("one live draft per base name; names are checked", async () => {
    const caller = { orgId, userId: builder }
    const first = await as(builder, BUILD, (tx) =>
      createDraft(tx, caller, { baseName: "returns", title: "Returns", files: files() }),
    )
    expect(
      await code(
        as(builder, BUILD, (tx) =>
          createDraft(tx, caller, { baseName: "returns", title: "Again", files: files() }),
        ),
      ),
    ).toBe("base_name_taken")
    // Discarded, the base is free again.
    await as(builder, BUILD, (tx) => discardDraft(tx, caller, first.draft.id))
    const second = await as(builder, BUILD, (tx) =>
      createDraft(tx, caller, { baseName: "returns", title: "Again", files: files() }),
    )
    expect(second.draft.id).not.toBe(first.draft.id)
    expect(
      await code(
        as(builder, BUILD, (tx) =>
          createDraft(tx, caller, { baseName: "api", title: "A", files: files() }),
        ),
      ),
    ).toBe("base_name_reserved")
    expect(
      await code(
        as(builder, BUILD, (tx) =>
          createDraft(tx, caller, { baseName: "Bad", title: "A", files: files() }),
        ),
      ),
    ).toBe("invalid_base_name")
  })

  it("published_app_name is set once and never changes; a published base stays its draft's", async () => {
    const caller = { orgId, userId: builder }
    const { draft } = await as(builder, BUILD, (tx) =>
      createDraft(tx, caller, { baseName: "orders", title: "Orders", files: files() }),
    )
    const appName = await as(builder, BUILD, (tx) => markDraftPublished(tx, caller, draft.id))
    expect(appName).toBe(draftAppName(orgId, "orders"))
    // Publishing again keeps the same name.
    expect(await as(builder, BUILD, (tx) => markDraftPublished(tx, caller, draft.id))).toBe(appName)
    // The database refuses any other writer that tries to move it, or the base.
    for (const set of [
      { publishedAppName: draftAppName(orgId, "other") },
      { publishedAppName: null },
      { baseName: "renamed" },
    ]) {
      const moved = await as(builder, BUILD, (tx) =>
        tx.update(appDrafts).set(set).where(eq(appDrafts.id, draft.id)).returning(),
      ).catch((err: Error) => `refused:${err.message}`)
      expect(String(moved)).toContain("refused")
    }
    // Discarded, its base is still the published app's.
    await as(builder, BUILD, (tx) => discardDraft(tx, caller, draft.id))
    expect(
      await code(
        as(builder, BUILD, (tx) =>
          createDraft(tx, caller, { baseName: "orders", title: "O", files: files() }),
        ),
      ),
    ).toBe("base_name_taken")
  })

  it("keeps the last 20 versions, numbers never reused, and prunes their artifacts", async () => {
    const caller = { orgId, userId: builder }
    const { draft } = await as(builder, BUILD, (tx) =>
      createDraft(tx, caller, { baseName: "many", title: "Many", files: files() }),
    )
    const pkg = new TextEncoder().encode("package-of-v1")
    const sha = createHash("sha256").update(pkg).digest("hex")
    await as(builder, BUILD, (tx) =>
      recordVersionBuild(tx, caller, {
        draftId: draft.id,
        n: 1,
        build: { ok: true, packageSha256: sha, sizeBytes: pkg.byteLength },
        artifacts: [{ kind: "package", bytes: pkg }],
      }),
    )
    expect(
      (await as(builder, [], (tx) => getBuildArtifact(tx, { draftId: draft.id, sha256: sha })))
        ?.kind,
    ).toBe("package")
    for (let i = 2; i <= 25; i++) {
      await as(builder, BUILD, (tx) =>
        updateDraftFiles(tx, caller, {
          draftId: draft.id,
          files: files(`// v${i}\n`),
          message: `v${i}`,
        }),
      )
    }
    const versions = await as(builder, [], (tx) => listDraftVersions(tx, draft.id))
    expect(versions).toHaveLength(DRAFT_VERSIONS_KEPT)
    expect(versions[0]!.n).toBe(25)
    expect(versions.at(-1)!.n).toBe(6)
    expect((await as(builder, [], (tx) => getDraft(tx, draft.id))).draft.latestVersion).toBe(25)
    expect(await code(as(builder, [], (tx) => getDraft(tx, draft.id, { version: 1 })))).toBe(
      "version_not_found",
    )
    // Version 1's package went with it.
    const left = await as(builder, [], (tx) =>
      tx.select().from(appBuildArtifacts).where(eq(appBuildArtifacts.draftId, draft.id)),
    )
    expect(left).toHaveLength(0)
  })

  it("refuses files over 512 KiB and files that are not draft files", async () => {
    const caller = { orgId, userId: builder }
    const big = "x".repeat(512 * 1024)
    expect(
      await code(
        as(builder, BUILD, (tx) =>
          createDraft(tx, caller, { baseName: "huge", title: "Huge", files: files(big) }),
        ),
      ),
    ).toBe("files_too_large")
    expect(
      await code(
        as(builder, BUILD, (tx) =>
          createDraft(tx, caller, {
            baseName: "odd",
            title: "Odd",
            files: { ...files(), "evil.js": "1" },
          }),
        ),
      ),
    ).toBe("invalid_files")
    expect(
      await code(
        as(builder, BUILD, (tx) =>
          createDraft(tx, caller, {
            baseName: "half",
            title: "Half",
            files: { "handlers.ts": "" },
          }),
        ),
      ),
    ).toBe("invalid_files")
  })

  it("restore makes a new version with the old files; a discarded draft takes no change", async () => {
    const caller = { orgId, userId: builder }
    const { draft } = await as(builder, BUILD, (tx) =>
      createDraft(tx, caller, { baseName: "undo", title: "Undo", files: files("// one\n") }),
    )
    await as(builder, BUILD, (tx) =>
      updateDraftFiles(tx, caller, { draftId: draft.id, files: files("// two\n") }),
    )
    const restored = await as(builder, BUILD, (tx) =>
      restoreDraftVersion(tx, caller, { draftId: draft.id, n: 1 }),
    )
    expect(restored.n).toBe(3)
    expect(restored.files["handlers.ts"]).toBe("// one\n")
    expect(restored.message).toBe("Restored version 1")
    // A build naming bytes it does not carry is refused.
    expect(
      await code(
        as(builder, BUILD, (tx) =>
          recordVersionBuild(tx, caller, {
            draftId: draft.id,
            n: 3,
            build: { ok: true, packageSha256: "0".repeat(64) },
            artifacts: [],
          }),
        ),
      ),
    ).toBe("invalid_build")
    await as(builder, BUILD, (tx) => discardDraft(tx, caller, draft.id))
    expect(
      await code(
        as(builder, BUILD, (tx) =>
          updateDraftFiles(tx, caller, { draftId: draft.id, files: files() }),
        ),
      ),
    ).toBe("draft_discarded")
    expect((await as(builder, [], (tx) => listDrafts(tx))).map((d) => d.id)).not.toContain(draft.id)
  })
})
