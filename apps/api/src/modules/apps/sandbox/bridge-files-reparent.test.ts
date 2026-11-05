// SPDX-License-Identifier: FSL-1.1-ALv2
// ctx.files_reparent moves only the files the caller can read where they are now:
// a file id the bridge's own transaction does not see is left where it is.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import * as privilegedModule from "~/db/privileged"
import { manifestFileParentRegistry } from "~/modules/apps/app-registries"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = "00000000-0000-0000-0000-0000000e2001"
const USER = "00000000-0000-0000-0000-0000000e2002"
const APP = "widgets"
const TARGET = "00000000-0000-4000-8000-0000000e20aa"
const VISIBLE = "00000000-0000-4000-8000-0000000e20b1"
const HIDDEN = "00000000-0000-4000-8000-0000000e20b2"
const manifest = { name: APP, schema: {}, events: {}, connections: {}, network: {} }
const dialect = new PgDialect()

let updates: Array<{ sql: string; params: unknown[] }>
let spy: ReturnType<typeof spyOn>

// The caller's transaction: it sees the target parent and the VISIBLE file only.
const tx = {
  execute: async (q: never) => {
    const { sql: text, params } = dialect.sqlToQuery(q)
    if (text.includes(".files")) {
      return (params as string[]).includes(VISIBLE) ? [{ id: VISIBLE }] : []
    }
    return [{ id: TARGET }]
  },
  queueEvent: async () => {},
}

beforeEach(() => {
  updates = []
  manifestFileParentRegistry.set([ORG, APP, "box"], {
    schemaRef: "app_widgets",
    tableName: "boxes",
    joinOn: "id",
    readScope: `${APP}:boxes:read`,
    writeScope: `${APP}:boxes:write`,
  } as never)
  spy = spyOn(privilegedModule, "withPrivilegedDb").mockImplementation((async (
    _org: string,
    _reason: string,
    fn: (t: unknown) => Promise<unknown>,
  ) =>
    fn({
      execute: async (q: never) => {
        updates.push(dialect.sqlToQuery(q))
        return []
      },
    })) as never)
})
afterEach(() => {
  spy.mockRestore()
  manifestFileParentRegistry.delete([ORG, APP, "box"])
})

describe("ctx.files_reparent", () => {
  it("moves the readable files and leaves the others", async () => {
    const bridge = createRpcBridge(APP, USER, ORG, tx as never, manifest as never)
    const out = await bridge.files_reparent(
      JSON.stringify({
        fileIds: [VISIBLE, HIDDEN],
        targetEntityType: "box",
        targetEntityId: TARGET,
      }),
    )
    expect(JSON.parse(out)).toEqual({ moved: 1 })
    expect(updates).toHaveLength(1)
    expect(updates[0].params).toContain(VISIBLE)
    expect(updates[0].params).not.toContain(HIDDEN)
  })

  it("moves nothing when no requested file is readable", async () => {
    const bridge = createRpcBridge(APP, USER, ORG, tx as never, manifest as never)
    const out = await bridge.files_reparent(
      JSON.stringify({ fileIds: [HIDDEN], targetEntityType: "box", targetEntityId: TARGET }),
    )
    expect(JSON.parse(out)).toEqual({ moved: 0 })
    expect(updates).toHaveLength(0)
  })
})
