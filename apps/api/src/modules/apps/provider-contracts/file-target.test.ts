// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cross-app file grant of a provider-contract dispatch: only the op whose contract spec names a
// file target (fetch_received_file), only onto the exact caller record passed in that call.
import { describe, expect, it } from "bun:test"
import {
  contractFileTarget,
  contractFileTargetOptions,
} from "~/modules/apps/provider-contracts/file-target"

const C = "einvoicing-pa@1"
const ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
const target = { app: "invoicing", entity_type: "received_file", entity_id: ID }

describe("contractFileTarget", () => {
  it("binds the exact record the caller passed to fetch_received_file", () => {
    expect(
      contractFileTarget(
        "invoicing",
        { contract: C, op: "fetch_received_file" },
        { provider_ref: "1", file: "original", target },
      ),
    ).toEqual({
      app: "invoicing",
      entityType: "received_file",
      entityId: ID,
    })
    expect(
      contractFileTargetOptions(
        "invoicing",
        { contract: C, op: "fetch_received_file" },
        { target },
      ),
    ).toEqual({
      contractCallerApp: "invoicing",
      contractFileTarget: { app: "invoicing", entityType: "received_file", entityId: ID },
    })
  })

  it("grants nothing to any other op, even one carrying a target-shaped param", () => {
    for (const op of [
      "submit_einvoice",
      "book_sale",
      "get_received",
      "set_received_status",
      "list_received",
      "unknown_op",
    ]) {
      expect(contractFileTarget("invoicing", { contract: C, op }, { target })).toBeNull()
      expect(contractFileTargetOptions("invoicing", { contract: C, op }, { target })).toEqual({})
    }
    expect(
      contractFileTarget(
        "invoicing",
        { contract: "other@1", op: "fetch_received_file" },
        { target },
      ),
    ).toBeNull()
  })

  it("grants nothing when the target names another app, or is malformed", () => {
    const op = { contract: C, op: "fetch_received_file" }
    expect(
      contractFileTarget("invoicing", op, { target: { ...target, app: "pennylane" } }),
    ).toBeNull()
    expect(
      contractFileTarget("invoicing", op, { target: { ...target, entity_id: "not-a-uuid" } }),
    ).toBeNull()
    expect(
      contractFileTarget("invoicing", op, { target: { ...target, entity_type: "Bad Type" } }),
    ).toBeNull()
    expect(contractFileTarget("invoicing", op, { target: null })).toBeNull()
    expect(contractFileTarget("invoicing", op, null)).toBeNull()
  })
})
