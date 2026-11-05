// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { orgKernelSettingsSchema } from "@liaison/shared"
import { resolveMediaAnalysisPermission } from "~/modules/agent/media/media-analysis-constants"

describe("resolveMediaAnalysisPermission", () => {
  it("applies defaults when settings are empty (tickets on, kernel on, mail off)", () => {
    const settings = orgKernelSettingsSchema.parse({})
    expect(resolveMediaAnalysisPermission(settings, "tickets", "image")).toEqual({ allowed: true })
    expect(resolveMediaAnalysisPermission(settings, "tickets", "video")).toEqual({ allowed: true })
    expect(resolveMediaAnalysisPermission(settings, "kernel", "image")).toEqual({ allowed: true })
    expect(resolveMediaAnalysisPermission(settings, "kernel", "video")).toEqual({ allowed: true })
    expect(resolveMediaAnalysisPermission(settings, "mail", "image")).toEqual({ allowed: false })
    expect(resolveMediaAnalysisPermission(settings, "mail", "video")).toEqual({ allowed: false })
  })

  it("an app's own files (apps surface): images and PDFs on by default, video off", () => {
    const settings = orgKernelSettingsSchema.parse({})
    expect(resolveMediaAnalysisPermission(settings, "apps", "image")).toEqual({ allowed: true })
    expect(resolveMediaAnalysisPermission(settings, "apps", "document")).toEqual({ allowed: true })
    expect(resolveMediaAnalysisPermission(settings, "apps", "video")).toEqual({ allowed: false })
  })

  it("document is a first-class kind: tickets/kernel on like image, mail ON unlike image/video", () => {
    const settings = orgKernelSettingsSchema.parse({})
    expect(resolveMediaAnalysisPermission(settings, "tickets", "document")).toEqual({
      allowed: true,
    })
    expect(resolveMediaAnalysisPermission(settings, "kernel", "document")).toEqual({
      allowed: true,
    })
    // Business PDFs arrive as mail attachments — document defaults ON for mail
    // while image/video stay OFF there.
    expect(resolveMediaAnalysisPermission(settings, "mail", "document")).toEqual({ allowed: true })
    expect(resolveMediaAnalysisPermission(settings, "mail", "image")).toEqual({ allowed: false })
  })

  it("an org override turns document off for mail and off for tickets, independent of image/video", () => {
    const settings = orgKernelSettingsSchema.parse({
      mediaAnalysis: { mail: { document: false }, tickets: { document: false } },
    })
    // mail/document turned OFF by override; mail/image still default OFF.
    expect(resolveMediaAnalysisPermission(settings, "mail", "document")).toEqual({ allowed: false })
    expect(resolveMediaAnalysisPermission(settings, "mail", "image")).toEqual({ allowed: false })
    // tickets/document turned OFF by override; tickets/image still default ON.
    expect(resolveMediaAnalysisPermission(settings, "tickets", "document")).toEqual({
      allowed: false,
    })
    expect(resolveMediaAnalysisPermission(settings, "tickets", "image")).toEqual({ allowed: true })
  })

  it("honours a kernel override (agent-chat attachments can be disabled)", () => {
    const settings = orgKernelSettingsSchema.parse({
      mediaAnalysis: { kernel: { image: false } },
    })
    expect(resolveMediaAnalysisPermission(settings, "kernel", "image")).toEqual({ allowed: false })
    // kernel/video untouched → default true
    expect(resolveMediaAnalysisPermission(settings, "kernel", "video")).toEqual({ allowed: true })
  })

  it("honours overrides while keeping unset toggles at their defaults", () => {
    const settings = orgKernelSettingsSchema.parse({
      mediaAnalysis: { tickets: { video: false }, mail: { image: true } },
    })
    // explicit override
    expect(resolveMediaAnalysisPermission(settings, "tickets", "video")).toEqual({ allowed: false })
    // tickets/image untouched → default true
    expect(resolveMediaAnalysisPermission(settings, "tickets", "image")).toEqual({ allowed: true })
    // mail/image override true
    expect(resolveMediaAnalysisPermission(settings, "mail", "image")).toEqual({ allowed: true })
    // mail/video untouched → default false
    expect(resolveMediaAnalysisPermission(settings, "mail", "video")).toEqual({ allowed: false })
  })

  it("returns { unsupported: true } for an unknown surface (distinct from { allowed: false })", () => {
    const settings = orgKernelSettingsSchema.parse({})
    const res = resolveMediaAnalysisPermission(settings, "threads", "image")
    expect(res).toEqual({ unsupported: true })
    expect(res).not.toEqual({ allowed: false })
  })

  it("enforces the boolean type on the mediaAnalysis field (not passthrough-unknown)", () => {
    expect(() =>
      orgKernelSettingsSchema.parse({ mediaAnalysis: { tickets: { image: "yes" } } }),
    ).toThrow()
  })
})
