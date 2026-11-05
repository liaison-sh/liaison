// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The alarm's copy is tested like code, for the same reason the pending jobs
// badge's is: it makes a promise about what the product can and cannot see, and
// a wrong sentence here is a security claim the design cannot keep.
//
// Three properties are pinned: the alarm renders every finding, it offers no
// way to dismiss it (its owner's clear is behind a proof of the mailbox secret,
// see MailboxAlarmClearDialog.test.tsx), and it never presents rotation as the repair (spec section
// 15 A15), which the settings page already asserts in its own words.

import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import type { DowngradeFinding } from "~/modules/mailbox/downgrade-detector"
import {
  downgradeFindingLabel,
  MailboxDowngradeAlarm,
} from "~/modules/mailbox/MailboxDowngradeAlarm"
import {
  DOWNGRADE_ALARM_KIND_KEYS,
  downgradeAlarmFooter,
  downgradeAlarmIntro,
  downgradeAlarmKindCopy,
  downgradeAlarmLimitNote,
  FORBIDDEN_MAILBOX_PHRASES,
} from "~/modules/mailbox/mailbox-copy"

const DOWNGRADE_ALARM_FOOTER = downgradeAlarmFooter()
const DOWNGRADE_ALARM_INTRO = downgradeAlarmIntro()
const DOWNGRADE_ALARM_LIMIT_NOTE = downgradeAlarmLimitNote()

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ get: vi.fn(() => new Promise(() => {})), post: vi.fn(), delete: vi.fn() }),
}))

function finding(overrides: Partial<DowngradeFinding> = {}): DowngradeFinding {
  return {
    kind: "unsealed-row",
    subject: "msg-1",
    detectedAt: "2026-08-27T10:00:00.000Z",
    ...overrides,
  }
}

describe("MailboxDowngradeAlarm", () => {
  it("renders nothing when there is nothing to report", () => {
    render(() => <MailboxDowngradeAlarm findings={() => []} />)
    expect(screen.queryByTestId("mailbox-downgrade-alarm")).toBeNull()
  })

  it("names every finding, one line each", () => {
    render(() => (
      <MailboxDowngradeAlarm
        findings={() => [
          finding(),
          finding({ kind: "unopenable-seal", subject: "msg-2" }),
          finding({ kind: "unattested-identity", subject: "keyring" }),
        ]}
      />
    ))
    expect(screen.getByTestId("mailbox-downgrade-alarm.list").children).toHaveLength(3)
    expect(screen.getByTestId("mailbox-downgrade-alarm.item.unsealed-row").textContent).toContain(
      "msg-1",
    )
    expect(screen.getByTestId("mailbox-downgrade-alarm.item.unattested-identity").textContent).toBe(
      downgradeAlarmKindCopy("unattested-identity"),
    )
  })

  it("offers no way to dismiss itself", () => {
    render(() => <MailboxDowngradeAlarm findings={() => [finding()]} />)
    const alarm = screen.getByTestId("mailbox-downgrade-alarm")
    expect(alarm.querySelectorAll("button")).toHaveLength(0)
    expect(alarm.querySelectorAll("[role='button']")).toHaveLength(0)
    expect(alarm.textContent?.toLowerCase()).not.toContain("dismiss")
  })

  it("for its owner, the only control is the proof gated clear, and it hides nothing", () => {
    render(() => <MailboxDowngradeAlarm findings={() => [finding()]} userId="user-1" />)
    const alarm = screen.getByTestId("mailbox-downgrade-alarm")
    const buttons = alarm.querySelectorAll("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0].getAttribute("data-testid")).toBe("mailbox-downgrade-alarm.clear")
    fireEvent.click(buttons[0])
    // Opening the clear dialog is not a clear: the alarm is still there.
    expect(screen.getByTestId("mailbox-downgrade-alarm")).toBeTruthy()
    expect(alarm.textContent?.toLowerCase()).not.toContain("dismiss")
  })

  it("is announced rather than left for the reader to notice", () => {
    render(() => <MailboxDowngradeAlarm findings={() => [finding()]} />)
    const alarm = screen.getByTestId("mailbox-downgrade-alarm")
    expect(alarm.getAttribute("role")).toBe("alert")
    expect(alarm.getAttribute("aria-live")).toBe("assertive")
  })

  it("never presents a new key as the repair, spec section 15 A15", () => {
    expect(DOWNGRADE_ALARM_FOOTER).toContain("Adding a new key does not repair it")
    for (const phrase of ["rotate to fix", "rotating fixes", "rotate your key to recover"]) {
      expect(DOWNGRADE_ALARM_FOOTER.toLowerCase()).not.toContain(phrase)
    }
  })

  it("states the bound of the check rather than overselling it, spec section 9.6", () => {
    expect(DOWNGRADE_ALARM_LIMIT_NOTE).toContain("cannot see")
    expect(DOWNGRADE_ALARM_LIMIT_NOTE).toContain("added by someone")
    expect(DOWNGRADE_ALARM_LIMIT_NOTE).toContain("held back")
  })

  it("uses no forbidden phrase and no dash punctuation", () => {
    const all = [
      DOWNGRADE_ALARM_INTRO,
      DOWNGRADE_ALARM_FOOTER,
      DOWNGRADE_ALARM_LIMIT_NOTE,
      ...Object.keys(DOWNGRADE_ALARM_KIND_KEYS).map((kind) =>
        downgradeAlarmKindCopy(kind as keyof typeof DOWNGRADE_ALARM_KIND_KEYS),
      ),
    ]
    for (const text of all) {
      for (const phrase of FORBIDDEN_MAILBOX_PHRASES) {
        expect(text.toLowerCase()).not.toContain(phrase)
      }
      expect(text).not.toMatch(/[–—]/)
      expect(text).not.toContain("--")
    }
  })

  it("labels a keyring finding without a message id", () => {
    expect(
      downgradeFindingLabel(finding({ kind: "unattested-identity", subject: "keyring" })),
    ).toBe(downgradeAlarmKindCopy("unattested-identity"))
    expect(downgradeFindingLabel(finding())).toContain("(msg-1)")
  })
})
