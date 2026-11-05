// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T13 (S2, S3, D28, D45): folder, repo, node and model resolution for a
// session's start, and the claiming node's own folder path.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { currentNodeModels } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  type FolderRef,
  folderNamedIn,
  loadNodeCandidates,
  type NodeCandidate,
  pickNode,
  resolveAgentModel,
  resolveFolder,
  resolveFolderOnNode,
  resolveModel,
  resolveRepo,
} from "./resolve"

const folders: FolderRef[] = [
  { name: "liaison-monorepo", kind: "repo" },
  { name: "liaison-desktop", kind: "repo" },
  { name: "notes", kind: "root" },
]

describe("folder and repo resolution (P1-T13)", () => {
  it("liaison-monorepo, Liaison-Monorepo and liaison-mono resolve; liaison is ambiguous with candidates", () => {
    for (const q of ["liaison-monorepo", "Liaison-Monorepo", "liaison-mono", " LIAISON-MONO "]) {
      expect(resolveFolder(folders, q)).toEqual({ ok: true, folder: folders[0] })
    }
    expect(resolveFolder(folders, "liaison")).toEqual({
      ok: false,
      reason: "folder_unresolved",
      candidates: ["liaison-desktop", "liaison-monorepo"],
    })
  })

  it("an exact name wins over a longer name it prefixes", () => {
    const withShort = [...folders, { name: "liaison", kind: "root" as const }]
    expect(resolveFolder(withShort, "liaison")).toEqual({ ok: true, folder: withShort[3] })
  })

  it("unknown names list at most 10 candidates", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      name: `project-${String(i).padStart(2, "0")}`,
      kind: "root" as const,
    }))
    const res = resolveFolder(many, "zzz")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.candidates).toHaveLength(10)
    expect(res.candidates[0]).toBe("project-00")
    const near = resolveFolder(folders, "desk")
    expect(near).toEqual({
      ok: false,
      reason: "folder_unresolved",
      candidates: ["liaison-desktop"],
    })
  })

  it("a git URL in every form passes; a repo name resolves only to a repo folder", () => {
    for (const url of [
      "https://github.com/acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
      "git@github.com:acme/widgets.git",
    ]) {
      expect(resolveRepo(url, folders)).toEqual({ ok: true, url })
    }
    expect(resolveRepo("liaison-mono", folders)).toEqual({
      ok: true,
      folderName: "liaison-monorepo",
    })
    expect(resolveRepo("notes", folders)).toMatchObject({ ok: false, reason: "folder_unresolved" })
  })
})

describe("a folder named in a message (walk D24)", () => {
  const folders = [
    { name: "liaison-walk-sample", kind: "root" as const },
    { name: "app", kind: "repo" as const },
    { name: "app-web", kind: "repo" as const },
  ]
  it("finds the one shared folder a message names, as a word, ignoring case", () => {
    expect(folderNamedIn("In liaison-walk-sample, list the files.", folders)?.name).toBe(
      "liaison-walk-sample",
    )
    expect(folderNamedIn("in Liaison-Walk-Sample list the files", folders)?.name).toBe(
      "liaison-walk-sample",
    )
    // The longer name wins over one it contains.
    expect(folderNamedIn("fix the build in app-web", folders)?.name).toBe("app-web")
  })
  it("none when no folder is named, a name is only part of a word, or two are named", () => {
    expect(folderNamedIn("list the files", folders)).toBeNull()
    expect(folderNamedIn("an application bug", folders)).toBeNull()
    expect(folderNamedIn("compare app-web with liaison-walk-sample", folders)).toBeNull()
  })
})

describe("node and model choice (P1-T13)", () => {
  const node = (over: Partial<NodeCandidate>): NodeCandidate => ({
    nodeId: crypto.randomUUID(),
    name: "n",
    online: false,
    lastSeenAt: null,
    folders: [],
    models: [{ id: "claude-haiku-4-5-20251001" }],
    ...over,
    runs: over.runs ?? over.models ?? [{ id: "claude-haiku-4-5-20251001" }],
  })

  it("two nodes: the one advertising the folder; with none, the online one; a tie goes to the most recently seen", () => {
    const laptop = node({ name: "laptop", online: false, folders: [folders[0]] })
    const desktop = node({ name: "desktop", online: true, folders: [folders[2]] })
    expect(pickNode([desktop, laptop], "liaison-monorepo")).toEqual({ ok: true, node: laptop })
    expect(pickNode([laptop, desktop])).toEqual({ ok: true, node: desktop })

    const older = node({ name: "older", online: true, lastSeenAt: new Date("2026-10-01") })
    const newer = node({ name: "newer", online: true, lastSeenAt: new Date("2026-10-12") })
    expect(pickNode([older, newer])).toEqual({ ok: true, node: newer })
    expect(pickNode([older, newer], "nowhere")).toEqual({ ok: false, reason: "no_node" })
    expect(pickNode([])).toEqual({ ok: false, reason: "no_node" })
  })

  it("a routine's explicit model claude-opus-9 is refused, its agent preference falls back by family", () => {
    const n = node({ models: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-4-5-20251001" }] })
    expect(resolveModel(n, { requested: "claude-opus-9" })).toEqual({
      ok: false,
      reason: "model_unavailable",
      offered: ["claude-opus-5-5", "claude-haiku-4-5-20251001"],
    })
    expect(resolveModel(n, { agentPreference: "claude-opus-9" })).toEqual({
      ok: true,
      model: "claude-opus-5-5",
    })
    expect(resolveModel(n, { requested: "claude-haiku-4-5" })).toEqual({
      ok: true,
      model: "claude-haiku-4-5-20251001",
    })
  })
})

// Review of #66: a variant of a current version (its `[1m]` context row, a
// dated duplicate) is that version, not an older one.
describe("the agent's model: current versions and their variants (#66)", () => {
  const runs = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-opus-5-5[1m]", label: "Claude Opus 5.5 with 1M context" },
    { id: "claude-opus-5-5-20261001", label: "Claude Opus 5.5 (2026-10-01)" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  ]
  const node = { models: currentNodeModels(runs), runs }

  it("the [1m] variant and a dated duplicate of a current version are current", () => {
    expect(node.models.map((m) => m.id)).toEqual(["claude-opus-5-5"])
    expect(resolveAgentModel(node, "claude-opus-5-5[1m]")).toEqual({
      ok: true,
      model: "claude-opus-5-5[1m]",
    })
    expect(resolveAgentModel(node, "Opus 5.5 with 1M context")).toEqual({
      ok: true,
      model: "claude-opus-5-5[1m]",
    })
    expect(resolveAgentModel(node, "claude-opus-5-5-20261001")).toEqual({
      ok: true,
      model: "claude-opus-5-5-20261001",
    })
  })

  it("an older version is still not current", () => {
    expect(resolveAgentModel(node, "claude-opus-4-6")).toMatchObject({ ok: false, legacy: true })
    expect(resolveAgentModel(node, "claude-opus-9")).toMatchObject({ ok: false, legacy: false })
  })
})

describe("the owner's nodes and a node's own paths (P1-T13)", () => {
  let orgId: string
  let userId: string
  let laptop: string
  let desktop: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    const ids = await withSystemDb("resolve-test-seed", async (tx) => {
      const userId = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`,
        ),
      )[0].id
      const node = async (name: string, folders: unknown[]) => {
        const id = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name)
            VALUES (${orgId}, ${userId}, ${`dev-${crypto.randomUUID()}`}, ${name}) RETURNING id`),
        )[0].id
        await tx.execute(drizzleSql`
          INSERT INTO kernel.node_capabilities (node_id, org_id, owner_user_id, shared_folders, models)
          VALUES (${id}, ${orgId}, ${userId}, ${JSON.stringify(folders)}::jsonb,
            '[{"id":"claude-haiku-4-5","label":"Haiku"}]'::jsonb)`)
        return id
      }
      const laptop = await node("Laptop", [
        { name: "liaison-monorepo", path: "/Users/a/code/liaison-monorepo", kind: "repo" },
      ])
      const desktop = await node("Desktop", [
        { name: "liaison-monorepo", path: "/home/b/src/liaison-monorepo", kind: "repo" },
        { name: "notes", path: "/home/b/notes", kind: "root" },
      ])
      // An enabled node that never published capabilities cannot run a session.
      await tx.execute(drizzleSql`
        INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name)
        VALUES (${orgId}, ${userId}, ${`dev-${crypto.randomUUID()}`}, 'Old app')`)
      return { userId, laptop, desktop }
    })
    ;({ userId, laptop, desktop } = ids)
  })
  afterAll(releaseTestLock)

  it("candidates carry folder names and kinds, never paths, and only nodes with capabilities", async () => {
    const candidates = await loadNodeCandidates(orgId, userId)
    expect(candidates.map((c) => c.name).sort()).toEqual(["Desktop", "Laptop"])
    expect(JSON.stringify(candidates)).not.toContain("/Users/a")
    expect(JSON.stringify(candidates)).not.toContain("/home/b")
    const d = candidates.find((c) => c.nodeId === desktop)!
    expect(d.folders).toEqual([
      { name: "liaison-monorepo", kind: "repo" },
      { name: "notes", kind: "root" },
    ])
    expect(d.models).toEqual([{ id: "claude-haiku-4-5", label: "Haiku" }])
  })

  it("resolveFolderOnNode answers the claiming node's path, not another node's", async () => {
    expect(await resolveFolderOnNode(orgId, laptop, { folderName: "liaison-monorepo" })).toBe(
      "/Users/a/code/liaison-monorepo",
    )
    expect(await resolveFolderOnNode(orgId, desktop, { folderName: "liaison-monorepo" })).toBe(
      "/home/b/src/liaison-monorepo",
    )
    expect(await resolveFolderOnNode(orgId, laptop, { folderName: "notes" })).toBeNull()
    expect(await resolveFolderOnNode(orgId, desktop, { repo: "liaison-mono" })).toBe(
      "/home/b/src/liaison-monorepo",
    )
    expect(await resolveFolderOnNode(orgId, desktop, { repo: "notes" })).toBeNull()
    expect(
      await resolveFolderOnNode(orgId, desktop, { repo: "git@github.com:acme/widgets.git" }),
    ).toBeNull()
  })
})
