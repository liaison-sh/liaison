// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reference transform: a Freshdesk "Export Tickets" XML backup into tickets.ticket.
//
// Input (uploads): the people directories first (Users*.xml, AllAgents*.xml:
// <users><user><id/><name/><email/></user></users>, an agent file may wrap each
// user in <agent>), then the ticket files (Tickets0.xml .. TicketsN.xml:
// <helpdesk-tickets><helpdesk-ticket>...<notes><helpdesk-note/>...</notes>).
// Preview and start it with file rules that read the directories first, e.g.
//   files: [{ match: "Users*.xml" }, { match: "*Agents*.xml" }, { match: "Tickets*.xml" }]
//
// Each ticket keeps its whole conversation: the ticket's <description> is the
// customer's first message, then every <helpdesk-note> in export order. A note
// is inbound when <incoming> is true (the customer wrote it); an agent's note is
// an outbound reply when public and an internal note when <private> is true, so
// an internal note never becomes a reply. Authors come from the directories
// (Freshdesk user ids are unique across agents and contacts); an unknown author
// imports with no email rather than failing the ticket.
//
// The directories travel in `state` between batches as id -> [email, name]
// (state holds up to 4 MB: tens of thousands of people).

const STATUS = { 2: "open", 3: "awaiting_followup", 4: "closed", 5: "closed" }

/** The text of a parsed XML value: a string, or an element object's #text; nil is null. */
function text(v) {
  if (v === undefined || v === null) return null
  if (typeof v === "string") return v.trim()
  if (Array.isArray(v)) return text(v[0])
  if (v["@nil"] === "true") return null
  return typeof v["#text"] === "string" ? v["#text"].trim() : ""
}

function list(v) {
  if (v === undefined || v === null || typeof v === "string") return []
  return Array.isArray(v) ? v : [v]
}

function person(people, id) {
  const hit = id ? people[id] : undefined
  return hit ? { email: hit[0] || null, name: hit[1] || null } : { email: null, name: null }
}

function noteKind(note) {
  if (text(note.incoming) === "true") return "inbound"
  return text(note.private) === "true" ? "note" : "outbound"
}

function toTicket(t, people) {
  const requester = person(people, text(t["requester-id"]))
  const createdAt = text(t["created-at"])
  const subject = text(t.subject) || "(no subject)"
  const messages = []
  const description = text(t.description)
  const descriptionHtml = text(t["description-html"])
  if (description !== null || descriptionHtml !== null) {
    messages.push({
      kind: "inbound",
      fromEmail: requester.email,
      fromName: requester.name,
      textBody: description,
      htmlBody: descriptionHtml,
      sentAt: createdAt,
    })
  }
  const notes = t.notes && typeof t.notes === "object" ? list(t.notes["helpdesk-note"]) : []
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    const author = person(people, text(note["user-id"]))
    messages.push({
      kind: noteKind(note),
      fromEmail: author.email,
      fromName: author.name,
      textBody: text(note.body),
      htmlBody: text(note["body-html"]),
      sentAt: text(note["created-at"]),
    })
  }
  // A ticket with no description and no note still needs one message.
  if (messages.length === 0)
    messages.push({ kind: "inbound", textBody: subject, sentAt: createdAt })

  const code = Number(text(t.status))
  let status = STATUS[code]
  // Answered tickets are often left "Open": when an agent spoke last, the
  // ticket is awaiting the customer.
  if (status === undefined || status === "open") {
    let last = null
    for (let j = 0; j < messages.length; j++) {
      const m = messages[j]
      if (m.kind === "note") continue
      if (!last) {
        last = m
        continue
      }
      const prev = last.sentAt ? Date.parse(last.sentAt) : NaN
      const cur = m.sentAt ? Date.parse(m.sentAt) : NaN
      if (Number.isNaN(prev) || (!Number.isNaN(cur) && cur >= prev)) last = m
    }
    if (last && last.kind === "outbound") status = "awaiting_customer"
  }

  const record = {
    subject: subject,
    externalRef: `freshdesk-${text(t.id)}`,
    contactEmail: requester.email,
    contactName: requester.name,
    channel: "email",
    createdAt: createdAt,
    messages: messages,
  }
  if (status) record.status = status
  return record
}

async function transform(batch, ctx) {
  const people = batch.state?.people || {}
  const tickets = []
  for (let i = 0; i < batch.records.length; i++) {
    const r = batch.records[i]
    const name = r["#name"]
    if (name === "user" || name === "agent") {
      const u = name === "agent" && r.user && typeof r.user === "object" ? r.user : r
      const id = text(u.id)
      if (id) people[id] = [text(u.email) || "", text(u.name) || ""]
    } else if (name === "helpdesk-ticket") {
      tickets.push(toTicket(r, people))
    }
  }
  if (tickets.length > 0) await ctx.emitRecords("tickets.ticket", tickets)
  return { state: { people: people } }
}
