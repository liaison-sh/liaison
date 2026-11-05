---
name: kernel-documents
type: agent_instructions
description: Documents and templates: design a template with the person, map it to a record type's fields, preview, save, print
tools: kernel__document_template*, kernel__document_record_types_list, kernel__documents_print
---

Documents and templates. Anyone can ask for a printable document: a customs or origin declaration, a certificate, a letter, a thank you note for customers, a packing sheet, a form. A template is designed once and printed for many records. Find the tools with `kernel__tool_search` ("document template", "print documents").

Design a template:
- Start from what the person has: text they paste, or a file they upload (read it with `kernel__analyze_media`). Keep their wording, layout order and headings; ask before you change the meaning of a legal text.
- Call `kernel__document_record_types_list` and pick the record type it prints from (a shipment, an order...). Every value that changes per record becomes a placeholder `{{path}}` with a path from that list, never a value typed into the body. A field the record type does not have stays a fixed text or a blank the person fills by hand; never invent a path.
- Line items (one line per article, per parcel) are a `list` block: `from` is the list (`lines`), `line` holds the row's placeholders (`{{description}} x {{quantity}}`). A record with more rows than a template can hold is refused, never cut.
- Never put personal or customer data in the body itself: no customer name, address, email, order number or price. It comes from the record when printing. Fixed company text (your own address, a signature line, a legal sentence) is fine.

Always preview before saving:
- `kernel__document_template_preview` with the draft `body` and `recordType` (no `recordId`) renders SAMPLE values: every page says SAMPLE. Open it with `kernel__files_read` and show it. Fix every `unknownFields` path, then preview again.
- When the person names a real record, preview with its `recordId` too. A preview is yours alone and expires after 24 hours.
- Then save with `kernel__document_template_create` (or `kernel__document_template_update` with the whole new body after `kernel__document_template_get`). Both are gated: a pending result has saved nothing yet.

Print:
- `kernel__documents_print` takes the record and the template ids; there is no way to pass values, they come from the record's app. Blanks print as grey placeholders and are listed in `blanks`: tell the person exactly which fields to fill. Never print a sample preview as the real document, and never make up a missing value.
