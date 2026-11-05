// SPDX-License-Identifier: FSL-1.1-ALv2
// D17 on the cell: from the first failed renewal (status `past_due`, then
// `suspended` and `closed`) no metered usage runs on the platform key. The
// refusal sits at the chokepoints every paid call passes: `resolveKey` (the
// platform key in the managed edition), `spendGate`, and the web-call refusal;
// dictation answers 402 `payment_required`. `active` is served; a self-hosted
// instance with a stale billing row is unaffected (S19).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { PAYMENT_REQUIRED_CODE } from "@liaison/shared"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { resolveKey, spendGate } from "~/modules/agent/credits/credit-meter"
import { handleWebSearch, webCallPricingRefusal } from "~/modules/agent/tools/web-tools"
import {
  defaultTranscribeDeps,
  type TranscribeDeps,
  TranscribeError,
  transcribe,
} from "~/modules/assist/transcribe-service"
import {
  findTranscriptionModel,
  MEASURED_DEFAULT_TRANSCRIPTION_KEY,
  type TranscriptionModel,
} from "~/modules/assist/transcription-models"
import { clearOrgBillingStatusCache } from "~/modules/cloud/billing-status"
import { PaymentRequiredError } from "~/modules/cloud/suspension"
import { seedOrgBillingState } from "~/seed/factories/billing/billing"
import { seedOrgRow } from "~/seed/factories/org/rows"

const mutableEnv = env as { LIAISON_EDITION?: string }
const savedEdition = mutableEnv.LIAISON_EDITION
const savedOpenRouter = process.env.OPENROUTER_API_KEY
const savedExa = process.env.EXA_API_KEY
const orgs: string[] = []

async function orgWithStatus(status: string | null): Promise<string> {
  const id = randomUUID()
  orgs.push(id)
  await seedOrgRow({ id, name: "D17 org", slug: `d17-${id.slice(0, 8)}` })
  if (status !== null) await seedOrgBillingState(id, { plan: "base", status, includedCredits: 100 })
  return id
}

beforeAll(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-test-platform-placeholder"
  delete process.env.EXA_API_KEY
})

afterAll(async () => {
  mutableEnv.LIAISON_EDITION = savedEdition
  _setEdition(null)
  if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = savedOpenRouter
  if (savedExa !== undefined) process.env.EXA_API_KEY = savedExa
  for (const id of orgs) {
    await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${id}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
  }
})

beforeEach(() => {
  mutableEnv.LIAISON_EDITION = "managed"
  _setEdition(null)
  clearOrgBillingStatusCache()
})

afterEach(() => clearOrgBillingStatusCache())

describe("managed: the platform key is refused while payment is required", () => {
  for (const status of ["past_due", "suspended", "closed"]) {
    test(`${status}: resolveKey throws payment_required`, async () => {
      const orgId = await orgWithStatus(status)
      const err = await resolveKey(orgId, "openrouter").catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PaymentRequiredError)
      expect((err as PaymentRequiredError).status).toBe(402)
      expect((err as PaymentRequiredError).code).toBe(PAYMENT_REQUIRED_CODE)
    })
  }

  test("spendGate answers 402 payment_required on the platform key", async () => {
    const orgId = await orgWithStatus("past_due")
    const block = await spendGate(orgId, "liaison", "any-model")
    expect(block?.status).toBe(402)
    expect(block?.billingCode).toBe(PAYMENT_REQUIRED_CODE)
  })

  test("web calls are refused before they are sent, the search says why", async () => {
    const orgId = await orgWithStatus("past_due")
    expect(await webCallPricingRefusal("liaison", orgId)).toBe(new PaymentRequiredError().message)
    const res = await handleWebSearch({ query: "anything" }, { userId: randomUUID(), orgId })
    expect(res).toEqual({ error: new PaymentRequiredError().message })
  })

  test("dictation answers 402 payment_required", async () => {
    const orgId = await orgWithStatus("past_due")
    const model = findTranscriptionModel(MEASURED_DEFAULT_TRANSCRIPTION_KEY) as TranscriptionModel
    const deps: TranscribeDeps = {
      ...defaultTranscribeDeps,
      resolvePlan: async () => ({ model, hedge: null }),
      log: { warn: () => {}, error: () => {} } as never,
    }
    const err = await transcribe(
      {
        orgId,
        userId: randomUUID(),
        audio: new Uint8Array([1, 2, 3, 4]),
        contentType: "audio/webm",
        clean: false,
        signal: new AbortController().signal,
      },
      deps,
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TranscribeError)
    expect((err as TranscribeError).code).toBe("payment_required")
    expect((err as TranscribeError).status).toBe(402)
  })

  test("active, or no push yet: served", async () => {
    for (const status of ["active", null]) {
      const orgId = await orgWithStatus(status)
      expect((await resolveKey(orgId, "openrouter")).source).toBe("liaison")
      expect(await webCallPricingRefusal("byok", orgId)).toBeNull()
    }
  })
})

describe("self-hosted (S19)", () => {
  test("a stale past_due row changes nothing", async () => {
    const orgId = await orgWithStatus("past_due")
    mutableEnv.LIAISON_EDITION = "self_hosted"
    _setEdition(null)
    expect((await resolveKey(orgId, "openrouter")).source).toBe("liaison")
    expect(await spendGate(orgId, "liaison", "any-model")).toBeNull()
    expect(await webCallPricingRefusal("liaison", orgId)).toBeNull()
  })
})
