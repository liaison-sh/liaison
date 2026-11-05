// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reference transform: Jira Service Management (Jira Cloud) into tickets.category
// (request types), contacts.contact (customers, with their organization) and
// tickets.ticket (requests, with public replies, internal notes and
// attachments), pulled through an api-connector connection.
//
// The connection: baseUrl https://<site>.atlassian.net, basic auth (an agent's
// email and API token: internal comments are visible to agents only, saved
// through a secret card), redirectHosts ["api.media.atlassian.com"] for the
// attachment downloads, and the static header the service desk API's customer
// and organization endpoints require:
//   headers: { "X-ExperimentalApi": "opt-in" }
// Save the transform with sourceType "api" and the connection's identifier.
//
// What it reads, one page per call of pull, for each service desk
// (GET /rest/servicedeskapi/servicedesk):
//   1. its request types (/servicedesk/{id}/requesttype): one tickets.category each;
//   2. its organizations (/servicedesk/{id}/organization) and their members
//      (/organization/{id}/user): who belongs to which;
//   3. its customers (/servicedesk/{id}/customer): one contacts.contact each,
//      with their organization as company;
//   4. its requests: the project's issues, oldest first, through the platform
//      search (GET /rest/api/3/search/jql, paged by nextPageToken; the service
//      desk's own request list can come back empty for an agent), each read as a
//      request (/request/{key}; an issue that is not a request is skipped), with
//      the issue's description, assignee, priority and attachments
//      (/rest/api/3/issue/{key}) and its comments (/request/{key}/comment).
//
// Each request becomes a ticket: the description is the customer's first
// message, then every comment in order. A comment the service desk marks not
// public is an internal note; a public one is the customer's when written by
// the reporter or a customer account, else an agent's reply. An attachment goes
// on the message that shows it (an image or file embedded in the description,
// or `!name!` / `[^name]` in a comment); a file no message shows goes on one
// internal note at the end, never on a public reply. Statuses map by category:
// done is closed, "waiting for customer" awaits the customer, the rest is open.
//
// A customer whose email Jira hides keeps their display name and no email.
//
// To limit the import to some service desks, list their project keys in DESK_KEYS.

const DESK_KEYS = [] // e.g. ["SUP"]; empty: every service desk
const PAGE = 50
const REQUESTS_PER_PAGE = 20

function Throttled() {}

async function get(ctx, path) {
  const answer = await ctx.apiGet(path)
  if (answer.status === 429) throw new Throttled()
  if (answer.status === 404) return null
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`GET ${path.split("?")[0]} answered HTTP ${answer.status}`)
  }
  return answer.data
}

/** All the values of a servicedesk list (start/limit/isLastPage). */
async function allValues(ctx, path, limit) {
  const out = []
  let start = 0
  for (;;) {
    const sep = path.indexOf("?") >= 0 ? "&" : "?"
    const page = await get(ctx, `${path}${sep}start=${start}&limit=${limit}`)
    const values = page?.values || []
    for (let i = 0; i < values.length; i++) out.push(values[i])
    start += values.length
    if (page?.isLastPage !== false || values.length === 0) return out
  }
}

/** Atlassian Document Format to plain text; `media` collects the files it embeds. */
function adfText(node, media) {
  if (!node) return ""
  if (typeof node === "string") return node
  const kids = Array.isArray(node.content) ? node.content.map((k) => adfText(k, media)) : []
  switch (node.type) {
    case "text": {
      const link = (node.marks || []).filter((m) => m.type === "link" && m.attrs && m.attrs.href)[0]
      return link && link.attrs.href !== node.text
        ? `${node.text} (${link.attrs.href})`
        : node.text || ""
    }
    case "media":
      if (node.attrs?.alt) media.push(node.attrs.alt)
      return ""
    case "hardBreak":
      return "\n"
    case "mention":
      return node.attrs?.text || "@someone"
    case "emoji":
      return (node.attrs && (node.attrs.text || node.attrs.shortName)) || ""
    case "inlineCard":
    case "blockCard":
      return node.attrs?.url || ""
    case "listItem":
      return `- ${kids.join("").trim()}\n`
    case "bulletList":
    case "orderedList":
      return `${kids.join("")}\n`
    case "codeBlock":
      return `\`\`\`\n${kids.join("")}\n\`\`\`\n\n`
    case "paragraph":
    case "heading":
    case "blockquote":
      return `${kids.join("")}\n\n`
    default:
      return kids.join("")
  }
}

function plain(adf, media) {
  const t = adfText(adf, media)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return t.length > 0 ? t : null
}

/** File names a comment's wiki text shows: `!name!`, `!name|thumbnail!`, `[^name]`. */
function wikiFiles(text) {
  const out = []
  const re = /!([^!|\n]+)(\|[^!\n]*)?!|\[\^([^\]\n]+)\]/g
  let m = re.exec(text)
  while (m) {
    out.push((m[1] || m[3]).trim())
    m = re.exec(text)
  }
  return out
}

function priorityOf(p) {
  const name = (p?.name ? p.name : "").toLowerCase()
  if (name === "highest" || name === "blocker") return "urgent"
  if (name === "high" || name === "critical") return "high"
  if (name === "low" || name === "lowest" || name === "trivial") return "low"
  return "normal"
}

function statusOf(s) {
  const category = s ? String(s.statusCategory || "").toUpperCase() : ""
  const name = s ? String(s.status || "") : ""
  if (category === "DONE") {
    const n = name.toLowerCase()
    return {
      status: "closed",
      closedReason:
        n.indexOf("cancel") >= 0 || n.indexOf("declin") >= 0 ? "no_response" : "resolved",
    }
  }
  if (/waiting for customer|pending customer/i.test(name)) return { status: "awaiting_customer" }
  return { status: "open" }
}

function isoOf(d) {
  return d ? d.iso8601 || null : null
}

async function ticketOf(ctx, request) {
  const key = request.issueKey
  const issue = (await get(
    ctx,
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=description,assignee,priority,attachment`,
  )) || { fields: {} }
  const f = issue.fields || {}
  const reporter = request.reporter || null
  const reporterId = reporter ? reporter.accountId : null
  const summary = (request.requestFieldValues || []).filter((v) => v.fieldId === "summary")[0]
    ?.value
  const createdAt = isoOf(request.createdDate)
  const descriptionFiles = []
  const messages = [
    {
      kind: "inbound",
      fromEmail: reporter ? reporter.emailAddress || null : null,
      fromName: reporter ? reporter.displayName || null : null,
      textBody: plain(f.description, descriptionFiles) || summary || key,
      sentAt: createdAt,
    },
  ]
  const shows = [descriptionFiles]
  const comments = await allValues(
    ctx,
    `/rest/servicedeskapi/request/${encodeURIComponent(key)}/comment`,
    100,
  )
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i]
    const author = c.author || {}
    const customer = author.accountId === reporterId || author.accountType === "customer"
    const body = typeof c.body === "string" ? c.body : plain(c.body, []) || ""
    messages.push({
      kind: c.public === false ? "note" : customer ? "inbound" : "outbound",
      fromEmail: author.emailAddress || null,
      fromName: author.displayName || null,
      textBody: body,
      sentAt: isoOf(c.created),
    })
    shows.push(wikiFiles(body))
  }
  const unplaced = []
  const attachments = f.attachment || []
  for (let j = 0; j < attachments.length; j++) {
    const att = attachments[j]
    const file = {
      filename: att.filename,
      mimeType: att.mimeType || "application/octet-stream",
      fileId: await ctx.downloadToFile(
        `/rest/api/3/attachment/content/${encodeURIComponent(att.id)}?redirect=false`,
        { filename: att.filename },
      ),
    }
    let target = -1
    for (let k = 0; k < shows.length && target < 0; k++) {
      if (shows[k].indexOf(att.filename) >= 0) target = k
    }
    if (target < 0) {
      unplaced.push(file)
      continue
    }
    if (!messages[target].attachments) messages[target].attachments = []
    messages[target].attachments.push(file)
  }
  if (unplaced.length > 0) {
    // Files no message shows stay internal: never on a public reply.
    messages.push({
      kind: "note",
      textBody: "Files attached to the request in Jira",
      sentAt: messages[messages.length - 1].sentAt,
      attachments: unplaced,
    })
  }

  const st = statusOf(request.currentStatus)
  const typeName = request.requestType ? request.requestType.name : null
  const ticket = {
    subject: summary || key,
    externalRef: key,
    contactEmail: reporter ? reporter.emailAddress || null : null,
    contactName: reporter ? reporter.displayName || null : null,
    channel: "web_form",
    priority: priorityOf(f.priority),
    status: st.status,
    assigneeEmail: f.assignee ? f.assignee.emailAddress || null : null,
    createdAt: createdAt,
    messages: messages,
  }
  if (st.closedReason) ticket.closedReason = st.closedReason
  if (typeName) ticket.categoryPath = typeName
  return ticket
}

function next(cursor, patch) {
  return Object.assign({}, cursor, patch)
}

async function pull(page, ctx) {
  const cursor = page.cursor
  const state = page.state || { categories: {}, orgOf: {} }
  try {
    if (!cursor) {
      const desks = (await allValues(ctx, "/rest/servicedeskapi/servicedesk", PAGE)).filter(
        (d) => DESK_KEYS.length === 0 || DESK_KEYS.indexOf(d.projectKey) >= 0,
      )
      if (desks.length === 0) return { nextCursor: null }
      return {
        nextCursor: {
          desks: desks.map((d) => ({ id: d.id, key: d.projectKey })),
          d: 0,
          phase: "types",
          start: 0,
        },
        state: state,
      }
    }
    const desk = cursor.desks[cursor.d].id
    const listPage = async (path, limit) => {
      const sep = path.indexOf("?") >= 0 ? "&" : "?"
      const res = await get(ctx, `${path}${sep}start=${cursor.start}&limit=${limit}`)
      const values = res?.values || []
      return { values: values, last: res?.isLastPage !== false || values.length === 0 }
    }
    if (cursor.phase === "types") {
      const res = await listPage(`/rest/servicedeskapi/servicedesk/${desk}/requesttype`, PAGE)
      const records = []
      for (let i = 0; i < res.values.length; i++) {
        const name = res.values[i].name
        if (name && !state.categories[name]) {
          state.categories[name] = true
          records.push({ path: name })
        }
      }
      if (records.length > 0) await ctx.emitRecords("tickets.category", records)
      return {
        nextCursor: res.last
          ? next(cursor, { phase: "orgs", start: 0, orgs: [] })
          : next(cursor, { start: cursor.start + res.values.length }),
        state: state,
      }
    }
    if (cursor.phase === "orgs") {
      const res = await listPage(`/rest/servicedeskapi/servicedesk/${desk}/organization`, PAGE)
      const orgs = (cursor.orgs || []).concat(res.values.map((o) => ({ id: o.id, name: o.name })))
      if (!res.last)
        return {
          nextCursor: next(cursor, { orgs: orgs, start: cursor.start + res.values.length }),
          state: state,
        }
      return {
        nextCursor:
          orgs.length > 0
            ? next(cursor, { phase: "members", orgs: orgs, o: 0, start: 0 })
            : next(cursor, { phase: "customers", orgs: [], start: 0 }),
        state: state,
      }
    }
    if (cursor.phase === "members") {
      const org = cursor.orgs[cursor.o]
      const res = await listPage(
        `/rest/servicedeskapi/organization/${encodeURIComponent(org.id)}/user`,
        PAGE,
      )
      for (let i = 0; i < res.values.length; i++) {
        const id = res.values[i].accountId
        if (id && !state.orgOf[id]) state.orgOf[id] = org.name
      }
      if (!res.last)
        return {
          nextCursor: next(cursor, { start: cursor.start + res.values.length }),
          state: state,
        }
      return {
        nextCursor:
          cursor.o + 1 < cursor.orgs.length
            ? next(cursor, { o: cursor.o + 1, start: 0 })
            : next(cursor, { phase: "customers", start: 0 }),
        state: state,
      }
    }
    if (cursor.phase === "customers") {
      const res = await listPage(`/rest/servicedeskapi/servicedesk/${desk}/customer`, PAGE)
      const contacts = res.values
        .filter((c) => c.accountId)
        .map((c) => ({
          externalId: c.accountId,
          name: c.displayName || c.emailAddress || c.accountId,
          email: c.emailAddress || null,
          company: state.orgOf[c.accountId] || null,
        }))
      if (contacts.length > 0) await ctx.emitRecords("contacts.contact", contacts)
      return {
        nextCursor: res.last
          ? next(cursor, { phase: "requests", start: 0 })
          : next(cursor, { start: cursor.start + res.values.length }),
        state: state,
      }
    }
    // Requests: the desk's project issues, oldest first, a page at a time.
    const jql = `project = "${cursor.desks[cursor.d].key}" ORDER BY created ASC, key ASC`
    const found = await get(
      ctx,
      "/rest/api/3/search/jql?jql=" +
        encodeURIComponent(jql) +
        `&fields=key&maxResults=${REQUESTS_PER_PAGE}` +
        (cursor.token ? `&nextPageToken=${encodeURIComponent(cursor.token)}` : ""),
    )
    const issues = found?.issues || []
    const tickets = []
    for (let i = 0; i < issues.length; i++) {
      const request = await get(
        ctx,
        `/rest/servicedeskapi/request/${encodeURIComponent(issues[i].key)}?expand=requestType`,
      )
      if (request) tickets.push(await ticketOf(ctx, request))
    }
    if (tickets.length > 0) await ctx.emitRecords("tickets.ticket", tickets)
    if (found?.nextPageToken && !found.isLast && issues.length > 0)
      return { nextCursor: next(cursor, { token: found.nextPageToken }), state: state }
    if (cursor.d + 1 < cursor.desks.length) {
      return {
        nextCursor: { desks: cursor.desks, d: cursor.d + 1, phase: "types", start: 0, token: null },
        state: state,
      }
    }
    return { nextCursor: null, state: state }
  } catch (err) {
    if (err instanceof Throttled) return { nextCursor: cursor, state: state }
    throw err
  }
}
