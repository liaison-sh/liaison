// SPDX-License-Identifier: FSL-1.1-ALv2
// A send refused 402 `payment_required` (managed edition) says the open
// invoice must be paid, not the generic "could not send".
import { describe, expect, it } from "vitest"
import { ApiError } from "~/lib/api-error"
import { sendFailureToast } from "~/modules/threads/thread-send"

const t = (key: string) => key

describe("sendFailureToast", () => {
  it("402 payment_required names the open invoice", () => {
    const err = new ApiError("Usage is paused", 402, "payment_required")
    expect(sendFailureToast(err, t).message).toBe("cloud-limits.billing.paymentRequired")
  })

  it("any other refusal stays generic", () => {
    expect(sendFailureToast(new ApiError("x", 400, "other"), t).message).toBe(
      "kernel.sendMessageFailed",
    )
  })
})
