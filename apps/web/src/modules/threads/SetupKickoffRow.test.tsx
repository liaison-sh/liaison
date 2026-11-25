// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"

vi.mock("~/modules/secret-request/SecretRequestToolCard", () => ({
  default: (props: { requestId: string }) => (
    <div data-testid="secret-request-card-stub" data-request-id={props.requestId} />
  ),
}))

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock("~/modules/threads/thread-send", () => ({
  sendThreadMessage: sendMock,
  releaseHeldScopes: () => {},
  sendFailureToast: () => ({ message: "failed", type: "error" }),
}))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => ({ post: vi.fn() }) }))
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "u-1", name: "Ada" }),
}))

import { I18nProvider } from "~/modules/i18n/i18n-context"
import { SetupKickoffRow, setupKickoffOf } from "./SetupKickoffRow"

const META = {
  type: "setup-kickoff",
  agentId: "agent-1",
  demoUrl: "https://demo.liaison.sh",
  secretRequestId: "sec-1",
  state: {
    items: [{ key: "aiKey", done: false, optional: false, detail: "no usable model key" }],
    next: "aiKey",
    asOf: "2026-10-26T10:00:00.000Z",
  },
}

describe("SetupKickoffRow", () => {
  it("heads the card, shows the checklist, the key card and the demo offer once", () => {
    const view = setupKickoffOf(META)
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-1" threadId="t-1" view={view} />)
    expect(screen.getByTestId("setup-kickoff-row").textContent).toContain("Set up your space")
    expect(screen.getByTestId("setup-item-aiKey").getAttribute("data-done")).toBe("false")
    expect(screen.getByTestId("secret-request-card-stub").getAttribute("data-request-id")).toBe(
      "sec-1",
    )
    const links = screen.getAllByTestId("setup-demo-link")
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute("href")).toBe("https://demo.liaison.sh")
    expect(links[0]!.getAttribute("target")).toBe("_blank")
    expect(links[0]!.getAttribute("rel")).toContain("noopener")
    expect(screen.getByTestId("setup-kickoff-row").textContent).toContain("demo.liaison.sh")
  })

  it("mounts no key card without a request, and no demo block when the offer is off", () => {
    const view = setupKickoffOf({ ...META, secretRequestId: undefined, demoUrl: null })
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-2" threadId="t-1" view={view} />)
    expect(screen.queryByTestId("secret-request-card-stub")).toBeNull()
    expect(screen.queryByTestId("setup-demo-link")).toBeNull()
  })

  it("speaks French", () => {
    const view = setupKickoffOf(META)
    if (!view) throw new Error("not read")
    render(() => (
      <I18nProvider initialLocale="fr">
        <SetupKickoffRow messageId="m-3" threadId="t-1" view={view} />
      </I18nProvider>
    ))
    expect(screen.getByTestId("setup-kickoff-row").textContent).toContain("Configurez votre espace")
    expect(screen.getByTestId("setup-demo-link").textContent).toContain("Ouvrir la démo")
  })

  it("reads only a setup-kickoff row with a checklist", () => {
    expect(setupKickoffOf({ type: "approval-result" })).toBeNull()
    expect(setupKickoffOf({ type: "setup-kickoff" })).toBeNull()
    expect(setupKickoffOf(null)).toBeNull()
  })
})

describe("SetupKickoffRow on Cloud", () => {
  const SELF_HOSTED_INTRO =
    "Your agent sets this workspace up with you here, one step at a time. It first asks which features you want, then starts with the basics: your mailbox, Google sign-in, the support inbox and imports from your other tools. Each step says how long it takes, and you can skip any of them and come back any time."

  it("managed without a goal: the managed intro and three goal buttons, no mail-first intro", async () => {
    sendMock.mockReset()
    sendMock.mockResolvedValue(undefined)
    const view = setupKickoffOf({ ...META, secretRequestId: undefined, managed: true })
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-4" threadId="t-4" view={view} />)
    const row = screen.getByTestId("setup-kickoff-row")
    expect(row.textContent).toContain("Where do you want to start?")
    expect(row.textContent).not.toContain("your mailbox, Google sign-in")
    for (const goal of ["knowledge", "support", "projects"]) {
      expect(screen.getByTestId(`setup-goal-${goal}`)).toBeTruthy()
    }
    // A choice is a message in this conversation, never a dialog.
    fireEvent.click(screen.getByTestId("setup-goal-projects"))
    expect(sendMock).toHaveBeenCalledTimes(1)
    const [, threadId, content] = sendMock.mock.calls[0]!
    expect(threadId).toBe("t-4")
    expect(content).toBe("I want to start with projects.")
    expect(document.querySelector("[role=dialog]")).toBeNull()
    await Promise.resolve()
    expect(screen.queryByTestId("setup-goal-knowledge")).toBeNull()
  })

  it("managed with a goal: the intro starts there, no buttons", () => {
    const view = setupKickoffOf({ ...META, managed: true, goal: "knowledge" })
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-5" threadId="t-5" view={view} />)
    expect(screen.getByTestId("setup-kickoff-row").textContent).toContain(
      "starting with your company knowledge",
    )
    expect(screen.queryByTestId("setup-goal-knowledge")).toBeNull()
  })

  it("an unknown goal reads as none", () => {
    expect(setupKickoffOf({ ...META, managed: true, goal: "billing" })?.goal).toBeNull()
  })

  it("speaks French on Cloud", () => {
    const view = setupKickoffOf({ ...META, managed: true })
    if (!view) throw new Error("not read")
    render(() => (
      <I18nProvider initialLocale="fr">
        <SetupKickoffRow messageId="m-6" threadId="t-6" view={view} />
      </I18nProvider>
    ))
    expect(screen.getByTestId("setup-kickoff-row").textContent).toContain(
      "Par où voulez-vous commencer ?",
    )
    expect(screen.getByTestId("setup-goal-support").textContent).toBe("Support client")
  })

  it("self-hosted: the card is unchanged, goal or not", () => {
    const view = setupKickoffOf({ ...META, goal: "support" })
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-7" threadId="t-7" view={view} />)
    const row = screen.getByTestId("setup-kickoff-row")
    expect(row.textContent).toContain(SELF_HOSTED_INTRO)
    expect(screen.queryByTestId("setup-goal-support")).toBeNull()
  })
})
