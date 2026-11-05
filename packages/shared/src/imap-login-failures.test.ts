// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import en from "./i18n/locales/en/mail.json"
import fr from "./i18n/locales/fr/mail.json"
import {
  IMAP_LOGIN_FAILURES,
  imapLoginFailure,
  imapLoginFailureFromError,
  imapSyncSummary,
} from "./imap-login-failures"

describe("imapLoginFailure", () => {
  test("maps the servers' own refusals to the closed set", () => {
    expect(imapLoginFailure("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")).toBe(
      "wrong_password",
    )
    expect(
      imapLoginFailure(
        "[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)",
      ),
    ).toBe("app_password_required")
    expect(
      imapLoginFailure(
        "[ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access. (Failure)",
      ),
    ).toBe("imap_disabled")
    expect(
      imapLoginFailure(
        "[ALERT] Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)",
      ),
    ).toBe("web_login_required")
    expect(imapLoginFailure("[ALERT] Too many simultaneous connections. (Failure)")).toBe(
      "too_many_connections",
    )
    expect(imapLoginFailure("Command failed", "AUTHENTICATIONFAILED")).toBe("wrong_password")
    expect(imapLoginFailure("connect ECONNREFUSED 10.0.0.1:993")).toBeNull()
  })

  test("reads the code back from a stored sync error", () => {
    expect(imapLoginFailureFromError("IMAP authentication failed: app_password_required")).toBe(
      "app_password_required",
    )
    // Errors stored before the codes existed read as a wrong password.
    expect(imapLoginFailureFromError("IMAP authentication failed")).toBe("wrong_password")
    expect(imapLoginFailureFromError("IMAP too many connections")).toBe("too_many_connections")
    expect(imapLoginFailureFromError("IMAP timeout")).toBeNull()
  })

  test("every code has an en and fr sentence", () => {
    for (const code of IMAP_LOGIN_FAILURES) {
      expect(en.imapLogin[code]).toBeString()
      expect(fr.imapLogin[code]).toBeString()
    }
  })
})

describe("imapSyncSummary", () => {
  test("says what reaches the server from the recorded capabilities", () => {
    expect(
      imapSyncSummary({
        gmail: true,
        folders: {
          all: "[Gmail]/All Mail",
          archive: null,
          trash: "[Gmail]/Trash",
          sent: "[Gmail]/Sent Mail",
        },
      }),
    ).toEqual({
      readAndStar: true,
      archive: true,
      trash: true,
      sent: true,
      archiveReadBack: true,
      pollMinutes: 2,
    })
    expect(
      imapSyncSummary({
        gmail: false,
        folders: { all: null, archive: null, trash: "Trash", sent: null },
      }),
    ).toEqual({
      readAndStar: true,
      archive: false,
      trash: true,
      sent: false,
      archiveReadBack: true,
      pollMinutes: 2,
    })
    expect(imapSyncSummary(null)).toBeNull()
  })
})

describe("imapSyncSummary, an INBOX too large to track", () => {
  test("says archive done elsewhere is not read back", () => {
    const caps = { gmail: false, folders: { archive: "Archive", trash: "Trash", sent: "Sent" } }
    expect(imapSyncSummary(caps, { inboxTracked: false })?.archiveReadBack).toBe(false)
    expect(imapSyncSummary(caps, { inboxTracked: true })?.archiveReadBack).toBe(true)
    expect(imapSyncSummary(caps)?.archiveReadBack).toBe(true)
  })
})

describe("imapLoginFailure on a long server response", () => {
  test("280 KB of repeated words classifies in linear time", () => {
    const text = "enable ".repeat(40_000)
    const started = performance.now()
    expect(imapLoginFailure(text)).toBeNull()
    expect(performance.now() - started).toBeLessThan(50)
  })

  test("a refusal phrase still classifies when the server says it in a long response", () => {
    expect(imapLoginFailure(`${"x".repeat(100)} Please enable your account for IMAP access.`)).toBe(
      "imap_disabled",
    )
  })
})
