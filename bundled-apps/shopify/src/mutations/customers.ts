// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: customers (update, marketing consent, tags).

import type { AppContext } from "@liaison/app-sdk"
import {
  type PreflightResult,
  resolveMutationInput,
  makeMutationError,
  readGatedTarget,
  preflightRefusal,
  runMutation,
  requireTargetId,
} from "./shared"

// ─────────────────────────────────────────────────────────────────────────
//  Customers
// ─────────────────────────────────────────────────────────────────────────

const CUSTOMER_UPDATE = `
  mutation CustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) { customer { id email firstName lastName tags } userErrors { field message } }
  }
`
/** Build + validate the CustomerInput a customers_update call resolves to. PURE (no network). Shared
 *  by the handler and its stage-time preflight, like `buildOrderUpdateInput`. */
function buildCustomerUpdateInput(params: Record<string, unknown>): Record<string, unknown> {
  const input = resolveMutationInput(params)
  if (!input.id && params.id) input.id = params.id
  if (!input.id) throw makeMutationError("BAD_PARAM", "id is required")
  return input
}

/**
 * STAGE-TIME preflight for the gated `customers_update` (manifest `preflight`). The only guard was
 * that an id was present, so a customer gid that resolves to nothing (or an ORDER gid handed to a
 * customer tool) parked an edit the human could only find was doomed after approving it.
 */
export async function customers_update_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const input = buildCustomerUpdateInput(params)
    await readGatedTarget(ctx, String(input.id), "Customer", "customers_update")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function customers_update(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const input = buildCustomerUpdateInput(params)
  return runMutation(ctx, { query: CUSTOMER_UPDATE, variables: { input }, dataKey: "customerUpdate", eventEntity: "customer", eventAction: "updated", entityIdPath: "customer.id" })
}

const CUSTOMER_EMAIL_CONSENT = `
  mutation CustomerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) { customer { id email } userErrors { field message } }
  }
`
/** The consent mutation's input: the tool's top-level `customerId` belongs inside it. */
function consentInput(params: Record<string, unknown>): Record<string, unknown> {
  return { ...resolveMutationInput(params), customerId: params.customerId }
}

export async function customers_email_marketing_consent_update(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  if (!params.customerId) throw makeMutationError("BAD_PARAM", "customerId is required")
  return runMutation(ctx, { query: CUSTOMER_EMAIL_CONSENT, variables: { input: consentInput(params) }, dataKey: "customerEmailMarketingConsentUpdate", eventEntity: "customer", eventAction: "email_consent_updated", entityIdPath: "customer.id" })
}

const CUSTOMER_SMS_CONSENT = `
  mutation CustomerSmsMarketingConsentUpdate($input: CustomerSmsMarketingConsentUpdateInput!) {
    customerSmsMarketingConsentUpdate(input: $input) { customer { id email } userErrors { field message } }
  }
`
export async function customers_sms_marketing_consent_update(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  if (!params.customerId) throw makeMutationError("BAD_PARAM", "customerId is required")
  return runMutation(ctx, { query: CUSTOMER_SMS_CONSENT, variables: { input: consentInput(params) }, dataKey: "customerSmsMarketingConsentUpdate", eventEntity: "customer", eventAction: "sms_consent_updated", entityIdPath: "customer.id" })
}

// ─────────────────────────────────────────────────────────────────────────
//  Customers — tag (add/remove) (C6)
// ─────────────────────────────────────────────────────────────────────────

const CUSTOMER_TAGS_ADD = `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`
const CUSTOMER_TAGS_REMOVE = `
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`
/**
 * STAGE-TIME preflight for the gated `customers_tag` (manifest `preflight`). `tagsAdd` accepts ANY
 * taggable gid, so a wrong id does not even fail loudly: it tags the wrong record. Refuse anything
 * that is not a Customer, and anything that resolves to nothing, before a human sees the card.
 */
export async function customers_tag_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const customerId = requireTargetId(params, "customerId")
    await readGatedTarget(ctx, customerId, "Customer", "customers_tag")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function customers_tag(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  if (!params.customerId) throw makeMutationError("BAD_PARAM", "customerId is required")
  const tags = (params.tags as string[] | undefined) ?? []
  const op = params.op === "remove" ? "remove" : "add"
  const query = op === "remove" ? CUSTOMER_TAGS_REMOVE : CUSTOMER_TAGS_ADD
  const dataKey = op === "remove" ? "tagsRemove" : "tagsAdd"
  return runMutation(ctx, {
    query,
    variables: { id: params.customerId, tags },
    dataKey,
    eventEntity: "customer",
    eventAction: op === "remove" ? "untagged" : "tagged",
    entityIdPath: "node.id",
  })
}
