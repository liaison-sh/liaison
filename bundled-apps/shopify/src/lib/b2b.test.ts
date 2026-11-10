// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  B2B_ORDER_TAGS_CONFIG_KEY,
  B2B_SKU_SUFFIXES_CONFIG_KEY,
  b2bVerdict,
  b2bVerdictFor,
  decideCustomerNotification,
  parseOrderTags,
  readB2bRecognition,
} from "./b2b"

// One product per physical item: B2B and retail orders carry the same plain skus.
const plainLines = { nodes: [{ sku: "KIT-01" }, { sku: "CABLE-2M" }] }

function config(values: Record<string, unknown>) {
  return async (key: string) => values[key]
}

describe("b2bVerdict: an order is B2B by the order itself", () => {
  it("a company order with plain skus is B2B (company or company location)", async () => {
    const read = config({})
    expect(await b2bVerdict({ purchasingEntity: { company: { name: "A dealer" } }, lineItems: plainLines }, read)).toEqual({
      b2b: true,
      reason: "b2b_company_buyer",
    })
    expect(await b2bVerdict({ purchasingEntity: { location: { id: "gid://shopify/CompanyLocation/1" } } }, read)).toEqual({
      b2b: true,
      reason: "b2b_company_buyer",
    })
  })

  it("a B2B-tagged order with plain skus is B2B: default tag B2B, any case", async () => {
    const verdict = await b2bVerdict({ tags: ["b2b", "Distribution"], purchasingEntity: {}, lineItems: plainLines }, config({}))
    expect(verdict).toEqual({ b2b: true, reason: "b2b_order_tag" })
  })

  it("the org's own tag list replaces the default; an empty list turns tags off", async () => {
    const order = { tags: ["Wholesale"], lineItems: plainLines }
    expect(await b2bVerdict(order, config({ [B2B_ORDER_TAGS_CONFIG_KEY]: "trade, wholesale" }))).toEqual({
      b2b: true,
      reason: "b2b_order_tag",
    })
    expect(await b2bVerdict({ tags: ["B2B"] }, config({ [B2B_ORDER_TAGS_CONFIG_KEY]: "" }))).toEqual({ b2b: false, reason: null })
  })

  it("a legacy order with a B2B sku suffix is B2B", async () => {
    const verdict = await b2bVerdict(
      { tags: [], lineItems: { nodes: [{ sku: "KIT-01-B2B" }] } },
      config({ [B2B_SKU_SUFFIXES_CONFIG_KEY]: "-B2B,-DIST" }),
    )
    expect(verdict).toEqual({ b2b: true, reason: "b2b_sku_suffix" })
  })

  it("a plain retail order is not B2B", async () => {
    const verdict = await b2bVerdict(
      { tags: ["vip"], purchasingEntity: {}, lineItems: plainLines },
      config({ [B2B_SKU_SUFFIXES_CONFIG_KEY]: "-B2B" }),
    )
    expect(verdict).toEqual({ b2b: false, reason: null })
  })

  it("unreadable settings leave a non-company order undecided, a company order still decided", async () => {
    const broken = async () => {
      throw new Error("config down")
    }
    expect(await b2bVerdict({ tags: ["B2B"] }, broken)).toBeNull()
    expect(await b2bVerdict({ purchasingEntity: { company: { name: "A dealer" } } }, broken)).toEqual({
      b2b: true,
      reason: "b2b_company_buyer",
    })
    expect(await readB2bRecognition(broken)).toBeNull()
    expect(b2bVerdictFor({ tags: ["B2B"] }, null)).toBeNull()
  })

  it("parseOrderTags: unset is the default tag", () => {
    expect(parseOrderTags(undefined)).toEqual(["b2b"])
    expect(parseOrderTags(null)).toEqual(["b2b"])
    expect(parseOrderTags(" B2B , Trade ")).toEqual(["b2b", "trade"])
    expect(parseOrderTags("")).toEqual([])
  })
})

describe("decideCustomerNotification under retail_only", () => {
  const tracking = async () => ({ write: "create" as const, hasNumber: true })
  const run = (order: Parameters<typeof b2bVerdictFor>[0]) =>
    decideCustomerNotification({
      readConfig: config({ customerShippingEmail: "retail_only" }),
      callerAsksToNotify: true,
      loadOrder: async () => order,
      tracking,
    })

  it("a tagged B2B order with plain skus gets no shipping email", async () => {
    const decision = await run({ tags: ["B2B"], purchasingEntity: {}, lineItems: plainLines })
    expect(decision.notify).toBe(false)
    expect(decision.notice?.reason).toBe("b2b_order_tag")
  })

  it("a plain retail order gets it", async () => {
    const decision = await run({ tags: [], purchasingEntity: {}, lineItems: plainLines })
    expect(decision.notify).toBe(true)
    expect(decision.notice?.reason).toBe("retail_order")
  })
})
