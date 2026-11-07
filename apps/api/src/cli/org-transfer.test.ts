// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison org transfer`: argument parsing, the keys line, the fingerprint
// file round trip, and the refusals that need no database.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  fingerprintFromJson,
  fingerprintToJson,
  parseOperatorLine,
  parseOrgTransferArgs,
  parseProbeLine,
  runOrgTransferCli,
} from "~/cli/org-transfer"
import * as searchClientModule from "~/infra/search/client"
import { env } from "~/lib/env"
import { parseTransferKeys } from "~/modules/org/transfer/rekey"
import { probeVisibleHere, recordPeerStorage } from "~/modules/org/transfer/storage-identity"

const ORG = randomUUID()
const XFER = randomUUID()

// The probe writes a search document to the live index. A fresh test namespace
// has none, and Meili would create it bare, inferring the key from the probe
// (`id` or `org_id`) and failing; a bare live index then breaks every later
// filtered delete of the namespace. The probe gets its own scratch index here.
const INDEX = `test_org_transfer_${randomUUID().slice(0, 8)}`
const spies: Array<{ mockRestore(): void }> = []

beforeAll(async () => {
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX))
  const meili = searchClientModule.getMeili()
  const created = await meili.createIndex(INDEX, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const settings = await meili.index(INDEX).updateSettings({ filterableAttributes: ["org_id"] })
  await meili.tasks.waitForTask(settings.taskUid)
})

afterAll(async () => {
  await searchClientModule
    .getMeili()
    .deleteIndex(INDEX)
    .catch(() => {})
  for (const s of spies) s.mockRestore()
})

describe("liaison org transfer", () => {
  it("parses each subcommand and refuses what is missing", () => {
    expect(parseOrgTransferArgs(["keys"])).toEqual({ cmd: "keys" })
    expect(parseOrgTransferArgs(["export", ORG, "--transfer", XFER, "--since", "f"])).toEqual({
      cmd: "export",
      orgId: ORG,
      transferId: XFER,
      since: "f",
    })
    expect(parseOrgTransferArgs(["import", "--dry-run"])).toEqual({ cmd: "import", dryRun: true })
    expect(parseOrgTransferArgs(["estimate", ORG])).toEqual({ cmd: "estimate", orgId: ORG })
    expect(parseOrgTransferArgs(["purge-source", ORG, "--transfer", XFER])).toEqual({
      cmd: "purge-source",
      orgId: ORG,
      transferId: XFER,
    })
    expect(parseOrgTransferArgs(["export", "acme", "--transfer", XFER])).toContain("uuid")
    expect(parseOrgTransferArgs(["export", ORG])).toContain("--transfer")
    expect(parseOrgTransferArgs(["import", "--key", "x"])).toContain("unknown argument")
    expect(parseOrgTransferArgs(["frob"])).toContain("keys, export")
    expect(parseOrgTransferArgs(["probe-write", ORG, "--transfer", XFER])).toEqual({
      cmd: "probe-write",
      orgId: ORG,
      transferId: XFER,
    })
    expect(parseOrgTransferArgs(["probe-clear"])).toEqual({ cmd: "probe-clear" })
  })

  it("parses --fail-at on the source agent and refuses an unknown step", () => {
    const base = ["agent", "--role", "source", ORG, "--transfer", XFER, "--target-cmd", "cat"]
    env.LIAISON_TEST_CELL = true
    expect(parseOrgTransferArgs([...base, "--fail-at", "after-cas"])).toMatchObject({
      role: "source",
      failAt: "after-cas",
    })
    expect(parseOrgTransferArgs(base)).not.toHaveProperty("failAt")
    expect(parseOrgTransferArgs([...base, "--fail-at", "commit"])).toContain("--fail-at commit")
  })

  it("refuses --fail-at unless the server's env marks it as a test server", () => {
    const base = ["agent", "--role", "source", ORG, "--transfer", XFER, "--target-cmd", "cat"]
    const saved = env.LIAISON_TEST_CELL
    env.LIAISON_TEST_CELL = false
    try {
      expect(parseOrgTransferArgs([...base, "--fail-at", "frozen"])).toContain(
        "LIAISON_TEST_CELL=1",
      )
      expect(parseOrgTransferArgs(base)).toMatchObject({ role: "source" })
    } finally {
      env.LIAISON_TEST_CELL = saved
    }
  })

  it("parses the agents and the source agent's operator line", () => {
    expect(parseOrgTransferArgs(["agent", "--role", "target"])).toEqual({
      cmd: "agent",
      role: "target",
    })
    expect(
      parseOrgTransferArgs([
        "agent",
        "--role",
        "source",
        ORG,
        "--transfer",
        XFER,
        "--target-cmd",
        "ssh t",
      ]),
    ).toEqual({ cmd: "agent", role: "source", orgId: ORG, transferId: XFER, targetCmd: "ssh t" })
    expect(parseOrgTransferArgs(["agent", "--role", "source", ORG, "--transfer", XFER])).toContain(
      "--target-cmd",
    )
    expect(parseOrgTransferArgs(["agent", "--role", "x"])).toContain("source|target")
    expect(parseOperatorLine("")).toBeNull()
    expect(parseOperatorLine("{}")).toBeNull()
    const key = "k".repeat(32)
    expect(
      parseOperatorLine(
        JSON.stringify({ operator: { control: "https://hq.example/hooks", operatorKey: key } }),
      ),
    ).toEqual({ control: "https://hq.example/hooks", operatorKey: key })
    expect(() =>
      parseOperatorLine(JSON.stringify({ operator: { control: "hq", operatorKey: key } })),
    ).toThrow("webhook URL")
  })

  it("prints one keys line the import accepts", async () => {
    const out: string[] = []
    const r = await runOrgTransferCli(["keys"], {
      input: async function* () {},
      output: (l) => out.push(l),
    })
    expect(r.exitCode).toBe(0)
    expect(out).toHaveLength(1)
    expect(parseTransferKeys(out[0] as string).encryption).toMatch(/^[0-9a-f]{64}$/)
  })

  it("needs MIGRATION_DATABASE_URL to read or write", async () => {
    const saved = process.env.MIGRATION_DATABASE_URL
    delete process.env.MIGRATION_DATABASE_URL
    try {
      const r = await runOrgTransferCli(["estimate", ORG], {
        input: async function* () {},
        output: () => {},
      })
      expect(r.exitCode).toBe(2)
      expect(r.message).toContain("MIGRATION_DATABASE_URL")
    } finally {
      if (saved !== undefined) process.env.MIGRATION_DATABASE_URL = saved
    }
  })

  it("purge-source needs the target's fresh probe on stdin and refuses one visible here", async () => {
    const transferId = randomUUID()
    await recordPeerStorage(transferId, { objects: "x|y", search: "x|y", proven: true })
    const lines = (...l: string[]) =>
      async function* () {
        yield* l
      }
    const noProbe = await runOrgTransferCli(["purge-source", ORG, "--transfer", transferId], {
      input: lines(),
      output: () => {},
    })
    expect(noProbe.exitCode).toBe(1)
    expect(noProbe.message).toContain("no storage probe on stdin")
    // This process stands for a target rebuilt onto the source's stores: its probe is visible.
    const out: string[] = []
    const w = await runOrgTransferCli(["probe-write", ORG, "--transfer", transferId], {
      input: lines(),
      output: (l) => out.push(l),
    })
    expect(w.exitCode).toBe(0)
    const probe = parseProbeLine(out[0] as string)
    try {
      const shared = await runOrgTransferCli(["purge-source", ORG, "--transfer", transferId], {
        input: lines(out[0] as string),
        output: () => {},
      })
      expect(shared.exitCode).toBe(1)
      expect(shared.message).toContain("fresh probe is visible here")
    } finally {
      const c = await runOrgTransferCli(["probe-clear"], {
        input: lines(out[0] as string),
        output: () => {},
      })
      expect(c.exitCode).toBe(0)
    }
    expect(await probeVisibleHere(probe)).toEqual([])
  }, 60_000)

  it("round-trips a fingerprint file", () => {
    const f = new Map([["kernel.users", new Map([['["a"]', "100"]])]])
    expect(fingerprintFromJson(fingerprintToJson(f))).toEqual(f)
  })
})
