// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two colleagues named "Dana Reyes" are unremarkable in an org this size, but
// the picker gave no way to tell them apart. A user row now shows its email
// as a second line exactly when another VISIBLE user row shares its name;
// a uniquely named person stays on one line, as before.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MentionResult } from "~/lib/mention-service"
import { MentionAutocomplete } from "~/modules/threads/MentionAutocomplete"
import { resetThreadStore } from "~/modules/threads/thread-store"

const results = vi.hoisted(() => ({ value: [] as MentionResult[] }))

vi.mock("~/lib/mention-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/mention-service")>()
  return { ...actual, searchMentions: async () => results.value }
})

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ get: async () => ({ data: [] }) }),
}))

function renderPicker() {
  return render(() => (
    <MentionAutocomplete
      query=""
      trigger="@"
      position={{ bottom: 0, left: 0 }}
      onSelect={() => {}}
      onClose={() => {}}
    />
  ))
}

describe("mention picker: same-name people", () => {
  beforeEach(() => {
    resetThreadStore()
    results.value = []
  })
  afterEach(() => {
    cleanup()
    resetThreadStore()
  })

  it("shows the email for two users sharing a display name", async () => {
    results.value = [
      { type: "user", id: "u1", label: "Dana Reyes", secondaryLabel: "dana@north.example" },
      { type: "user", id: "u2", label: "Dana Reyes", secondaryLabel: "dana@south.example" },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getAllByTestId("mention-result-secondary")).toHaveLength(2))
    const [first, second] = screen.getAllByTestId("mention-result-secondary")
    expect(first.textContent).toBe("dana@north.example")
    expect(second.textContent).toBe("dana@south.example")
  })

  it("treats accent/case variants of a name as the same collision", async () => {
    results.value = [
      { type: "user", id: "u1", label: "Renée Côté", secondaryLabel: "renee@north.example" },
      { type: "user", id: "u2", label: "renee cote", secondaryLabel: "renee@south.example" },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getAllByTestId("mention-result-secondary")).toHaveLength(2))
  })

  it("does not show an email for a uniquely named user", async () => {
    results.value = [
      { type: "user", id: "u1", label: "Priya Nair", secondaryLabel: "priya@example.test" },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getByTestId("mention-result-user")).toBeTruthy())
    expect(screen.queryByTestId("mention-result-secondary")).toBeNull()
  })

  it("only shows the email for the users that collide, not an unrelated unique one", async () => {
    results.value = [
      { type: "user", id: "u1", label: "Dana Reyes", secondaryLabel: "dana@north.example" },
      { type: "user", id: "u2", label: "Dana Reyes", secondaryLabel: "dana@south.example" },
      { type: "user", id: "u3", label: "Priya Nair", secondaryLabel: "priya@example.test" },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getAllByTestId("mention-result-secondary")).toHaveLength(2))
    expect(screen.getAllByTestId("mention-result-secondary").map((el) => el.textContent)).toEqual([
      "dana@north.example",
      "dana@south.example",
    ])
  })
})
