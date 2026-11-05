// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { serverT } from "./server-i18n"

describe("serverT", () => {
  it("resolves a kernel key in the requested locale", () => {
    expect(serverT("en", "kernel.common.save")).toBe("Save")
    expect(serverT("fr", "kernel.common.save")).toBe("Enregistrer")
  })

  it("falls back per-key to English when the fr value is missing", () => {
    // enonly.key exists only in en; fr request must fall back to it.
    expect(serverT("fr", "kernel.enonly.key")).toBe("English only value")
  })

  it("interpolates {{params}}", () => {
    expect(serverT("fr", "kernel.digest.subjectOne", { count: "1" })).toBe(
      "1 élément requiert votre attention",
    )
  })

  it("returns the key when missing in every locale", () => {
    expect(serverT("en", "kernel.nope.missing")).toBe("kernel.nope.missing")
  })

  it("resolves keys from any namespace, not only kernel", () => {
    expect(serverT("en", "tours.kernel.sample.title")).toBe("Sample tour")
    expect(serverT("fr", "tours.kernel.sample.title")).toBe("Visite d'exemple")
  })

  it("returns the key for an unknown namespace or a key without one", () => {
    expect(serverT("fr", "nonamespace.common.save")).toBe("nonamespace.common.save")
    expect(serverT("en", "kernel")).toBe("kernel")
  })
})
