// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SIGNING IN TO CLAUDE FROM THE APP (2026-09-24).
//
// A person who only ever used the Claude desktop app has no Claude Code login,
// and every local turn failed with "Failed to authenticate": the only fix was
// a terminal. These pin the page's half of the in-app sign-in: the notice over
// the composer, the dialog it opens, and that both say it in French too.

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { englishT, I18nProvider, translatorFor } from "~/modules/i18n/i18n-context"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import ClaudeSignInDialog, {
  CLAUDE_SIGN_IN_TITLE,
  CLAUDE_SIGN_IN_WAITING,
} from "./ClaudeSignInDialog"
import ClaudeSignInNotice, {
  CLAUDE_SIGN_IN_ACTION,
  CLAUDE_SIGN_IN_NEEDED_START,
  CLAUDE_SIGN_IN_NEEDED_TURN,
} from "./ClaudeSignInNotice"
import { installDesktopNotices, startRefusalCopyFor } from "./desktop-notices"
import { startLocalSession } from "./desktop-store"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"
import LocalStartRefusal from "./LocalStartRefusal"

const NEEDED_TURN = { threadId: "t1", agentId: "a1", messageId: "m1" }
const NEEDED_START = { threadId: "t1", agentId: "a1", messageId: null }

afterEach(() => {
  cleanup()
  resetToastStore()
  uninstallFakeBridge()
})

describe("the Claude sign-in notice over the composer", () => {
  it("a turn that could not authenticate offers the sign-in in its conversation", () => {
    const fake = installFakeBridge({ claudeSignInNeeded: NEEDED_TURN })
    render(() => <ClaudeSignInNotice threadId="t1" />)
    expect(screen.getByTestId("claude-sign-in-notice").textContent).toContain(
      englishT(CLAUDE_SIGN_IN_NEEDED_TURN),
    )
    fireEvent.click(screen.getByRole("button", { name: englishT(CLAUDE_SIGN_IN_ACTION) }))
    expect(fake.calls.claudeSignIns).toBe(1)
  })

  it("a refused start says the message was not sent", () => {
    installFakeBridge({ claudeSignInNeeded: NEEDED_START, startError: "ClaudeSignInRequired" })
    render(() => <ClaudeSignInNotice threadId="t1" />)
    expect(screen.getByTestId("claude-sign-in-notice").textContent).toContain(
      englishT(CLAUDE_SIGN_IN_NEEDED_START),
    )
  })

  it("says nothing in another conversation, in a browser, or to a shell that cannot sign in", () => {
    installFakeBridge({ claudeSignInNeeded: NEEDED_TURN })
    render(() => <ClaudeSignInNotice threadId="t2" />)
    expect(screen.queryByTestId("claude-sign-in-notice")).toBeNull()
    cleanup()
    uninstallFakeBridge()
    installFakeBridge({ claudeSignInNeeded: NEEDED_TURN }, { withoutClaudeSignIn: true })
    render(() => <ClaudeSignInNotice threadId="t1" />)
    expect(screen.queryByTestId("claude-sign-in-notice")).toBeNull()
    cleanup()
    uninstallFakeBridge()
    render(() => <ClaudeSignInNotice threadId="t1" />)
    expect(screen.queryByTestId("claude-sign-in-notice")).toBeNull()
  })

  it("can be dismissed", () => {
    const fake = installFakeBridge({ claudeSignInNeeded: NEEDED_TURN })
    render(() => <ClaudeSignInNotice threadId="t1" />)
    fireEvent.click(
      screen.getByRole("button", { name: englishT("kernel.desktopUi.claudeSignIn.dismiss") }),
    )
    expect(fake.calls.claudeNeededDismissals).toBe(1)
    expect(screen.queryByTestId("claude-sign-in-notice")).toBeNull()
  })

  // One sentence per refusal: the notice carries the action, so neither the
  // generic refusal line nor a toast repeats it.
  it("a start refused for want of a sign-in raises no toast and no second refusal line", async () => {
    const fake = installFakeBridge(
      { folderPath: "/Users/someone/code" },
      { refuseStart: "ClaudeSignInRequired" },
    )
    render(() => {
      installDesktopNotices()
      return <LocalStartRefusal threadId="t1" />
    })
    await startLocalSession("t1", "a1")
    fake.push({ claudeSignInNeeded: NEEDED_START })
    await waitFor(() => expect(fake.state().startError).toBe("ClaudeSignInRequired"))
    expect(toasts()).toHaveLength(0)
    expect(screen.queryByTestId("local-start-refusal")).toBeNull()
    // Still a sentence where a sentence is asked for.
    expect(startRefusalCopyFor("ClaudeSignInRequired")).toBe(
      englishT("kernel.desktopUi.notice.start.claudeSignInRequired"),
    )
  })
})

describe("the Claude sign-in dialog", () => {
  it("draws nothing while no sign-in runs", () => {
    installFakeBridge()
    render(() => <ClaudeSignInDialog />)
    expect(screen.queryByText(englishT(CLAUDE_SIGN_IN_TITLE))).toBeNull()
  })

  it("asks for the code Claude shows, and hands it to the shell", async () => {
    const fake = installFakeBridge({ claudeSignIn: { phase: "waiting" } })
    render(() => <ClaudeSignInDialog />)
    expect(screen.getByText(englishT(CLAUDE_SIGN_IN_WAITING))).toBeInTheDocument()
    const submit = screen.getByRole("button", {
      name: englishT("kernel.desktopUi.claudeSignIn.submit"),
    })
    expect(submit).toBeDisabled()
    fireEvent.input(screen.getByTestId("claude-sign-in-code"), {
      target: { value: "  abcd1234#efgh5678 " },
    })
    fireEvent.click(submit)
    await waitFor(() => expect(fake.calls.claudeCodes).toEqual(["abcd1234#efgh5678"]))
    await waitFor(() =>
      expect(
        screen.getByText(englishT("kernel.desktopUi.claudeSignIn.checking")),
      ).toBeInTheDocument(),
    )
  })

  it("says so when the code is not whole, and keeps the field", async () => {
    installFakeBridge({ claudeSignIn: { phase: "codeRejected" } })
    render(() => <ClaudeSignInDialog />)
    expect(
      screen.getByText(englishT("kernel.desktopUi.claudeSignIn.codeRejected")),
    ).toBeInTheDocument()
    expect(screen.getByTestId("claude-sign-in-code")).toBeInTheDocument()
  })

  it("opens the page again, and Cancel gives the sign-in up", async () => {
    const fake = installFakeBridge({ claudeSignIn: { phase: "waiting" } })
    render(() => <ClaudeSignInDialog />)
    fireEvent.click(screen.getByTestId("claude-sign-in-reopen"))
    await waitFor(() => expect(fake.calls.claudeReopens).toBe(1))
    fireEvent.click(
      screen.getByRole("button", { name: englishT("kernel.desktopUi.claudeSignIn.cancel") }),
    )
    await waitFor(() => expect(fake.calls.claudeCancels).toBe(1))
    await waitFor(() => expect(screen.queryByText(englishT(CLAUDE_SIGN_IN_TITLE))).toBeNull())
  })

  it("closes by itself when the shell reports the account signed in", async () => {
    const fake = installFakeBridge({ claudeSignIn: { phase: "checking" } })
    render(() => <ClaudeSignInDialog />)
    expect(screen.getByText(englishT(CLAUDE_SIGN_IN_TITLE))).toBeInTheDocument()
    fake.push({
      claudeSignIn: null,
      claudeAccount: { loggedIn: true, email: "someone@example.com" },
    })
    await waitFor(() => expect(screen.queryByText(englishT(CLAUDE_SIGN_IN_TITLE))).toBeNull())
  })

  it("a sign-in that ended says why and offers another try", async () => {
    const fake = installFakeBridge({
      claudeSignIn: {
        phase: "failed",
        reason: "failed",
        detail: "Login failed: Request failed with status code 400",
      },
    })
    render(() => <ClaudeSignInDialog />)
    expect(screen.getByRole("alert").textContent).toContain("status code 400")
    fireEvent.click(
      screen.getByRole("button", { name: englishT("kernel.desktopUi.claudeSignIn.tryAgain") }),
    )
    await waitFor(() => expect(fake.calls.claudeSignIns).toBe(1))
  })

  it("a timeout has its own sentence", () => {
    installFakeBridge({ claudeSignIn: { phase: "failed", reason: "timeout" } })
    render(() => <ClaudeSignInDialog />)
    expect(screen.getByRole("alert").textContent).toBe(
      englishT("kernel.desktopUi.claudeSignIn.timedOut"),
    )
  })

  it("reads in French", () => {
    installFakeBridge({ claudeSignIn: { phase: "waiting" }, claudeSignInNeeded: NEEDED_TURN })
    render(() => (
      <I18nProvider initialLocale="fr">
        <ClaudeSignInNotice threadId="t1" />
        <ClaudeSignInDialog />
      </I18nProvider>
    ))
    const fr = translatorFor("fr")
    expect(screen.getByText(fr(CLAUDE_SIGN_IN_WAITING))).toBeInTheDocument()
    expect(fr(CLAUDE_SIGN_IN_WAITING)).toContain("collez-le ici")
    expect(screen.getByTestId("claude-sign-in-notice").textContent).toContain(
      fr(CLAUDE_SIGN_IN_NEEDED_TURN),
    )
    expect(fr(CLAUDE_SIGN_IN_ACTION)).toBe("Se connecter à Claude")
  })
})
