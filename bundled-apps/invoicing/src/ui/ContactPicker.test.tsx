// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ContactPicker: the editor links a document to a contact by name, never by
// typing or showing its raw id.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { contactLabel, pickedContactPatch } from "./ContactPicker"

const contact = {
  id: "c0000000-0000-0000-0000-000000000001",
  name: "Claire Martin",
  email: "claire@acme.example",
  company: "Acme SAS",
}

describe("contactLabel", () => {
  it("reads the name, then the company, then the email", () => {
    expect(contactLabel(contact)).toBe("Claire Martin")
    expect(contactLabel({ ...contact, name: " " })).toBe("Acme SAS")
    expect(contactLabel({ ...contact, name: null, company: null })).toBe("claire@acme.example")
    expect(contactLabel({ name: null, company: null, email: null })).toBe("Unnamed contact")
  })

  it("never falls back to the contact id", () => {
    expect(contactLabel({ name: null, company: null, email: null })).not.toContain("c0000000")
  })
})

describe("pickedContactPatch", () => {
  it("links the contact and fills an empty customer name and email", () => {
    expect(pickedContactPatch(contact, { counterparty_name: "", counterparty_email: null })).toEqual({
      counterparty_contact_id: contact.id,
      counterparty_name: "Acme SAS",
      counterparty_email: "claire@acme.example",
    })
  })

  it("uses the person's name when the contact has no company", () => {
    expect(pickedContactPatch({ ...contact, company: null }, {}).counterparty_name).toBe("Claire Martin")
  })

  it("never overwrites what the operator already typed", () => {
    expect(
      pickedContactPatch(contact, {
        counterparty_name: "Acme Europe",
        counterparty_email: "billing@acme.example",
      }),
    ).toEqual({ counterparty_contact_id: contact.id })
  })
})

describe("Editor wiring", () => {
  const editor = readFileSync(join(import.meta.dir, "Editor.tsx"), "utf-8")
  it("the editor uses the picker and has no raw contact-id input", () => {
    expect(editor).toContain("<ContactPicker")
    expect(editor).not.toContain("editor-field-counterparty-contact-id")
    expect(editor).not.toContain('tr("Contact ID")')
  })
})
