// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"

vi.mock("~/modules/secret-request/SecretRequestToolCard", () => ({
  default: (props: { requestId: string }) => (
    <div data-testid="secret-request-card-stub" data-request-id={props.requestId} />
  ),
}))

const { sendMock, getMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  // No live read by default: the card shows the row's snapshot.
  getMock: vi.fn(() => Promise.reject(new Error("offline"))),
}))
vi.mock("~/modules/threads/thread-send", () => ({
  sendThreadMessage: sendMock,
  releaseHeldScopes: () => {},
  sendFailureToast: () => ({ message: "failed", type: "error" }),
}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ post: vi.fn(), get: getMock }),
}))
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
    "Your agent sets this workspace up with you here, one step at a time. It first asks which features you want, then starts with a quick brief on your company: your agent asks a few questions, or reads your website or a document you give it, and keeps what it learns as company knowledge. Then you invite your team, so your colleagues arrive in a workspace whose agent already knows the company. After that come your mailbox, Google sign-in, the support inbox and imports from your other tools. Each step says how long it takes, and you can skip any of them, or invite your team first, and come back any time."

  it("managed without a goal: the managed intro and three goal buttons, no mail-first intro", async () => {
    sendMock.mockReset()
    sendMock.mockResolvedValue(undefined)
    const view = setupKickoffOf({ ...META, secretRequestId: undefined, managed: true })
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-4" threadId="t-4" view={view} />)
    const row = screen.getByTestId("setup-kickoff-row")
    // The company brief first, then the team, then the goal the buttons ask for.
    expect(row.textContent).toContain("starting with a quick brief on your company")
    expect(row.textContent).toContain("Where do you want to go from there?")
    expect(row.textContent).not.toContain("your mailbox, Google sign-in")
    for (const goal of ["knowledge", "support", "projects"]) {
      expect(screen.getByTestId(`setup-goal-${goal}`)).toBeTruthy()
    }
    // A choice is a message in this conversation, never a dialog.
    fireEvent.click(screen.getByTestId("setup-goal-projects"))
    expect(sendMock).toHaveBeenCalledTimes(1)
    const [, threadId, content] = sendMock.mock.calls[0]!
    expect(threadId).toBe("t-4")
    expect(content).toBe("My goal: projects.")
    expect(document.querySelector("[role=dialog]")).toBeNull()
    await waitFor(() => expect(screen.queryByTestId("setup-goal-knowledge")).toBeNull())
  })

  it("an open step's Start arrow posts that step in the conversation as the person", async () => {
    sendMock.mockReset()
    sendMock.mockResolvedValue(undefined)
    const view = setupKickoffOf({ ...META, secretRequestId: undefined, managed: true })
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-6" threadId="t-6" view={view} />)
    const open = view.state.items.find((i) => !i.done)
    if (!open) throw new Error("no open step in the fixture")
    fireEvent.click(screen.getByTestId(`setup-item-start-${open.key}`))
    expect(sendMock).toHaveBeenCalledTimes(1)
    const [, threadId, content] = sendMock.mock.calls[0]!
    expect(threadId).toBe("t-6")
    expect(content).toMatch(/^Let's do this step now: .+\.$/)
  })

  it("managed with a goal: the intro starts there, no buttons", () => {
    const view = setupKickoffOf({ ...META, managed: true, goal: "knowledge" })
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-5" threadId="t-5" view={view} />)
    expect(screen.getByTestId("setup-kickoff-row").textContent).toContain(
      "starting with a quick brief on your company",
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
      "Et ensuite, par où voulez-vous continuer ?",
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

describe("SetupKickoffRow reads the checklist live", () => {
  const SNAPSHOT = {
    ...META,
    secretRequestId: undefined,
    managed: true,
    state: {
      items: [
        { key: "apps", done: true, optional: false },
        { key: "team", done: false, optional: false },
        { key: "knowledge", done: false, optional: false },
      ],
      next: "team",
      asOf: "2026-11-26T10:00:00.000Z",
    },
  }
  const NOW = {
    items: [
      { key: "apps", done: true, optional: false },
      { key: "team", done: true, optional: false },
      { key: "knowledge", done: true, optional: false },
    ],
    next: null,
    asOf: "2026-11-26T10:20:00.000Z",
  }

  it("a step done since the card was posted shows as done, the count follows (EN and FR)", async () => {
    getMock.mockReset()
    getMock.mockResolvedValue(NOW as never)
    const view = setupKickoffOf(SNAPSHOT)
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-8" threadId="t-8" view={view} />)
    // The row's snapshot first.
    expect(screen.getByTestId("setup-checklist-progress").textContent).toBe("1 of 3 done")
    await waitFor(() =>
      expect(screen.getByTestId("setup-checklist-progress").textContent).toBe("3 of 3 done"),
    )
    expect(getMock).toHaveBeenCalledWith("/first-run/checklist")
    expect(screen.getByTestId("setup-item-team").getAttribute("data-done")).toBe("true")
    expect(screen.queryByTestId("setup-item-start-knowledge")).toBeNull()
  })

  it("reads again when the tab comes back into view; a failed read keeps the card", async () => {
    getMock.mockReset()
    getMock.mockRejectedValueOnce(new Error("offline"))
    const view = setupKickoffOf(SNAPSHOT)
    if (!view) throw new Error("not read")
    render(() => (
      <I18nProvider initialLocale="fr">
        <SetupKickoffRow messageId="m-9" threadId="t-9" view={view} />
      </I18nProvider>
    ))
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1))
    const progress = screen.getByTestId("setup-checklist-progress")
    const before = progress.textContent
    expect(screen.getByTestId("setup-item-team").getAttribute("data-done")).toBe("false")
    getMock.mockResolvedValue(NOW as never)
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() =>
      expect(screen.getByTestId("setup-item-team").getAttribute("data-done")).toBe("true"),
    )
    expect(screen.getByTestId("setup-checklist-progress").textContent).not.toBe(before)
  })
})
