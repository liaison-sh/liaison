// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Card numbers and payment keys masked in an approval's payload, before it is
// stored: when a request is created, when its payload is updated by the agent
// (`approval_update_payload`), by a person's edit, or by an app's restage. An
// agent can write a customer's card number or a pasted key into a staged reply;
// the approval row, its summary and whatever the approved call sends then hold
// bullets instead. The same rules as every message (`@liaison/shared`
// pan-scan): a key keeps its prefix only; a card number keeps its last four.
//
// Keys are masked in every string. Card numbers are masked in every string
// except identifier fields (`id`, `…Id`, `…_id`, `…Ref`, `gid://…`, URLs),
// where a long Luhn-valid number is an order or a record id, not a card.
import { maskCardNumbers, maskVendorKeys } from "@liaison/shared"

const ID_KEY = /(^id$|Id$|_id$|Ids$|_ids$|Ref$|_ref$|^ref$|Url$|_url$|^url$)/

function maskString(text: string, key: string | null): string {
  const keys = maskVendorKeys(text).text
  if ((key !== null && ID_KEY.test(key)) || /^(gid|https?):\/\//.test(keys)) return keys
  return maskCardNumbers(keys).text
}

function walk(value: unknown, key: string | null): unknown {
  if (typeof value === "string") return maskString(value, key)
  if (Array.isArray(value)) return value.map((v) => walk(v, key))
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k)
    return out
  }
  return value
}

/** `value` with every card number and payment key in its strings masked; unchanged values keep their shape. */
export function maskApprovalPayload<T>(value: T): T {
  return walk(value, null) as T
}
