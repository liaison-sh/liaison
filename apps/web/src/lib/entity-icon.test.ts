// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  Calendar,
  Contact,
  FileText,
  ListTodo,
  Mail,
  MessageSquare,
  Ticket,
  User,
} from "lucide-solid"
import { describe, expect, it } from "vitest"
import { entityIcon } from "~/lib/entity-icon"

describe("entityIcon", () => {
  it("maps thread and message to the channel bubble", () => {
    expect(entityIcon("thread")).toBe(MessageSquare)
    expect(entityIcon("message")).toBe(MessageSquare)
  })

  it("maps conversation and mail to the mail glyph", () => {
    expect(entityIcon("conversation")).toBe(Mail)
    expect(entityIcon("mail")).toBe(Mail)
  })

  it("maps ticket to the ticket glyph", () => {
    expect(entityIcon("ticket")).toBe(Ticket)
  })

  it("maps task to the checklist glyph, not the channel hash", () => {
    expect(entityIcon("task")).toBe(ListTodo)
  })

  it("maps contact to the address-card glyph", () => {
    expect(entityIcon("contact")).toBe(Contact)
  })

  it("maps user to the person glyph", () => {
    expect(entityIcon("user")).toBe(User)
  })

  it("maps event to the calendar glyph", () => {
    expect(entityIcon("event")).toBe(Calendar)
  })

  it("falls back to the generic document glyph for an unknown type", () => {
    expect(entityIcon("something-unrecognized")).toBe(FileText)
  })
})
