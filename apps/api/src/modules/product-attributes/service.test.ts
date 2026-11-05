// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel.product_attributes: org isolation under FORCE RLS, the list filters,
// and the idempotent upsert (a re-run backfill changes nothing).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { organizations, users } from "~/db/schema/kernel"
import {
  handleProductAttributesList,
  handleProductAttributesUpsert,
  summarizeProductAttributesUpsert,
} from "~/modules/agent/tools/product-attribute-tools"
import {
  listProductAttributes,
  upsertProductAttributes,
} from "~/modules/product-attributes/service"

describe("kernel.product_attributes", () => {
  const ORG_A = crypto.randomUUID()
  const ORG_B = crypto.randomUUID()
  const USER_A = crypto.randomUUID()
  const USER_B = crypto.randomUUID()
  const tag = ORG_A.slice(0, 8)

  const ctx = (orgId: string, userId: string): UserContext => ({
    actorType: "user",
    userId,
    orgId,
    scopes: ["*"],
    dimensionGrants: {},
  })

  beforeAll(async () => {
    for (const [org, user, name] of [
      [ORG_A, USER_A, "a"],
      [ORG_B, USER_B, "b"],
    ] as const) {
      await withSystemDb("product-attributes-test-seed", async (db) => {
        await db
          .insert(organizations)
          .values({ id: org, name: `ProductAttrs ${name}`, slug: `prod-attr-${name}-${tag}` })
        await db.insert(users).values({
          id: user,
          orgId: org,
          email: `prod-attr-${name}-${tag}@test.com`,
          name,
          passwordHash: "x",
        })
      })
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.product_attributes WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
  })

  it("an org writes and reads its own attributes; another org reads none of them", async () => {
    const res = await withRlsContext(ctx(ORG_A, USER_A), (tx) =>
      upsertProductAttributes(tx, {
        orgId: ORG_A,
        userId: USER_A,
        items: [
          { sku: "DEV-2", key: "short_code", value: "E2" },
          { sku: "STAND-1", key: "short_code", value: "FS" },
          { sku: "DEV-2", key: "colour", value: "black" },
        ],
      }),
    )
    expect(res).toEqual({ written: 3, deleted: 0, unchanged: 0 })

    const mine = await withRlsContext(ctx(ORG_A, USER_A), (tx) =>
      listProductAttributes(tx, { orgId: ORG_A, keys: ["short_code"] }),
    )
    expect(mine.attributes.map((a) => [a.sku, a.value])).toEqual([
      ["DEV-2", "E2"],
      ["STAND-1", "FS"],
    ])

    // Org B asks for org A's rows by id: RLS answers nothing, even with org A's id in the filter.
    const theirs = await withRlsContext(ctx(ORG_B, USER_B), (tx) =>
      listProductAttributes(tx, { orgId: ORG_A }),
    )
    expect(theirs.attributes).toEqual([])
    const raw = await withRlsContext(ctx(ORG_B, USER_B), async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(drizzleSql`SELECT count(*)::int AS n FROM kernel.product_attributes`),
      ),
    )
    expect(raw[0]?.n).toBe(0)
  })

  it("an org cannot write a row into another org", async () => {
    await expect(
      withRlsContext(ctx(ORG_B, USER_B), (tx) =>
        upsertProductAttributes(tx, {
          orgId: ORG_A,
          userId: USER_B,
          items: [{ sku: "DEV-2", key: "short_code", value: "XX" }],
        }),
      ),
    ).rejects.toThrow()
    const mine = await withRlsContext(ctx(ORG_A, USER_A), (tx) =>
      listProductAttributes(tx, { orgId: ORG_A, skus: ["DEV-2"], keys: ["short_code"] }),
    )
    expect(mine.attributes.map((a) => a.value)).toEqual(["E2"])
  })

  it("re-writing the same values changes nothing, a new value updates, a null value deletes", async () => {
    const again = await withRlsContext(ctx(ORG_A, USER_A), (tx) =>
      upsertProductAttributes(tx, {
        orgId: ORG_A,
        userId: USER_A,
        items: [
          { sku: "DEV-2", key: "short_code", value: " E2 " },
          { sku: "STAND-1", key: "short_code", value: "FS" },
        ],
      }),
    )
    expect(again).toEqual({ written: 0, deleted: 0, unchanged: 2 })

    const changed = await withRlsContext(ctx(ORG_A, USER_A), (tx) =>
      upsertProductAttributes(tx, {
        orgId: ORG_A,
        userId: USER_A,
        items: [
          { sku: "STAND-1", key: "short_code", value: "ST" },
          { sku: "DEV-2", key: "colour", value: null },
          { sku: "NOPE", key: "colour", value: "" },
        ],
      }),
    )
    expect(changed).toEqual({ written: 1, deleted: 1, unchanged: 1 })
    const all = await withRlsContext(ctx(ORG_A, USER_A), (tx) =>
      listProductAttributes(tx, { orgId: ORG_A }),
    )
    expect(all.attributes.map((a) => `${a.sku}.${a.key}=${a.value}`)).toEqual([
      "DEV-2.short_code=E2",
      "STAND-1.short_code=ST",
    ])
  })

  it("refuses a malformed key and an over-long short code", async () => {
    await expect(
      withRlsContext(ctx(ORG_A, USER_A), (tx) =>
        upsertProductAttributes(tx, {
          orgId: ORG_A,
          userId: USER_A,
          items: [{ sku: "DEV-2", key: "Short Code", value: "E2" }],
        }),
      ),
    ).rejects.toThrow(/Invalid attribute key/)
    await expect(
      withRlsContext(ctx(ORG_A, USER_A), (tx) =>
        upsertProductAttributes(tx, {
          orgId: ORG_A,
          userId: USER_A,
          items: [{ sku: "DEV-2", key: "short_code", value: "MUCH-TOO-LONG-CODE" }],
        }),
      ),
    ).rejects.toThrow(/at most 12/)
  })

  it("the kernel tool handlers list by sku and upsert under the caller's org", async () => {
    const listed = await withRlsContext(ctx(ORG_A, USER_A), (tx) =>
      handleProductAttributesList(
        { skus: ["DEV-2", "UNKNOWN"], keys: ["short_code"] },
        {
          orgId: ORG_A,
          userId: USER_A,
          db: tx,
        },
      ),
    )
    expect(listed).toEqual({
      attributes: [expect.objectContaining({ sku: "DEV-2", key: "short_code", value: "E2" })],
      truncated: false,
    })
    const wrote = await withRlsContext(ctx(ORG_B, USER_B), (tx) =>
      handleProductAttributesUpsert(
        { items: [{ sku: "DEV-2", key: "short_code", value: "B2" }] },
        { orgId: ORG_B, userId: USER_B, db: tx },
      ),
    )
    expect(wrote).toEqual({ written: 1, deleted: 0, unchanged: 0 })
    const a = await withRlsContext(ctx(ORG_A, USER_A), (tx) =>
      listProductAttributes(tx, { orgId: ORG_A, skus: ["DEV-2"], keys: ["short_code"] }),
    )
    expect(a.attributes.map((r) => r.value)).toEqual(["E2"])
  })

  it("the approval card lists what the upsert sets and removes", async () => {
    const card = await summarizeProductAttributesUpsert({
      items: [
        { sku: "DEV-2", key: "short_code", value: "E2" },
        { sku: "STAND-1", key: "short_code", value: null },
      ],
    })
    expect(card.title).toBe("Update 2 product attributes")
    expect(card.lines).toEqual(["DEV-2: short_code = E2", "STAND-1: remove short_code"])
  })
})
