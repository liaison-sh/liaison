# The `api-connector` app

Connects Liaison's agents to a company's own CRM, ERP or any HTTP API,
without writing an app. You describe the API once as an **adapter**: a JSON
or YAML document listing the operations the agent may call, how each one maps
to a request, and which response fields it may see. Liaison does the rest:
credentials stay on the host, every request goes only to the adapter's host,
responses are cut down to the allow-listed fields, writes wait for a human
approval.

An org holds several connections (a CRM and an ERP, say), each identified by
a slug and carrying its own adapter and its own encrypted credentials.
Operations that fill a **role** (`customer.lookup`, `customer.orders`, ...)
also feed the customer card beside tickets and mail, and the agent's context
on those screens.

To write an adapter for your API, follow the
[`api-connector-authoring` skill](../.claude/skills/api-connector-authoring/SKILL.md);
this document is its reference. The worked example throughout is the fixture
CRM in `apps/api/src/apps/api-connector/__fixtures__/fixture-crm/`.

---

## 1. Architecture

```
agent ──tool call──▶ execute-tool (scope check, params schema, approvals for writes)
                        │
                  connector tools        connector_list_operations
                        │                connector_read   (read ops, taint source)
                        │                connector_write  (write ops, always gated)
                        │                (sandboxed handlers: thin delegators that
                        │                 never see credentials)
                        ▼
                  host bridge  (HOST SIDE)
                        │  resolve the connection: adapter row + org credentials
                        │  render(op, params)  → method, path, query, body
                        │  apply auth          → header / query / basic / bearer /
                        │                        oauth2 client-credentials token
                        │  audit row           → connection, operation, actor,
                        │                        status, ms (never the URL or body)
                        ▼
                  egress  fetchWithPinnedHost
                        │  https only (http only to loopback, with the private-hosts
                        │  flag), DNS pinned, private/metadata IPs refused,
                        │  every redirect hop must stay on the adapter's host,
                        │  15 s timeout, 2 MB streamed cap
                        ▼
                  the company's API  ──response──▶ project(response, op)
                                                    allow-listed leaf fields only,
                                                    ≤ 200 items, wrapped as
                                                    untrusted external content
```

The adapter format, templating, projection and pagination live in the pure
package `packages/api-connector-core` (no I/O): the app, the CLI and the
tests all import it, so the rules are enforced the same way everywhere.

### Demo orgs

On a demo instance (`LIAISON_DEMO_MODE`), the demo seeder gives each demo org
one connection, `crm`: the fixture CRM adapter with its `baseUrl` set to
`https://fixture-crm.example/v1` (a reserved name that never resolves) and a
sentinel API key, written by the seeder only
(`apps/api/src/modules/demo/api-connector/`). The transport asks the demo
responder first: a request to that origin from an org carrying the demo
marker is answered in-process by the fixture CRM's request handler (no
socket, zero outbound requests). Each demo org has its own fixture store,
shared by its reads and writes, so a contact the agent creates is found by
the next lookup; another org never sees it. A store lives for one UTC day,
is dropped when the org is reset or purged, and is bounded in memory (200
orgs, least recently used dropped; 500 created records per store, then a
429). Any other request from a demo org is
refused before it leaves the box (`demo_restricted`), and a normal org is
never answered from the fixture, whatever URL its adapter carries. Adapter
upload and removal and credential posts answer 403 in a demo org ("This is a
demo workspace: connections are pre-configured and cannot be changed."), and
the connection list says `readOnly`, so the settings page is read-only there
from its first paint; the Test panel and the agent tools work.

### Tools

| Tool | Kind | What it does |
|---|---|---|
| `connector_list_operations({connection?})` | read | Lists each connection's operations: name, kind, role, description, params schema, returned fields. The agent instructions tell the agent to call it first. |
| `connector_read({connection, operation, params})` | read | Runs one `read` operation and returns the projected items. Output is wrapped as untrusted external content and taints the turn. |
| `connector_write({connection, operation, params})` | write, gated | Runs one `write` operation after a person approves it. Checked at staging, then pinned (below). The approval names the connection, the operation, the request (method, host and path) and the params. |
| `connector_adapter_reference({section?})` | read, admin | The agent's authoring guide (`apps/api/src/apps/api-connector/reference/authoring.md`), one section per call (at most 30,000 characters); without `section`, the list of sections and the overview. Its field and roles tables are generated like this page's. Section `woocommerce` is a complete example adapter for a WooCommerce shop (orders, one order, products, best sellers). |
| `connector_adapter_get({identifier, operationsPage?})` | read, admin | The stored adapter document and its credential status, with `bytes` and `truncated`. A document over 30,000 characters comes with one page of its operations at a time. |
| `connector_adapter_test({identifier, operation, params})` | read, admin | One page of one `read` operation with the stored credentials, as `POST /test` runs it; items fenced as external content (it taints the turn). A `write` is refused (`write_not_testable`). |
| `connector_adapter_versions({identifier})` | read, admin | The kept previous adapters (the last 20 saves): id, version, who saved it and when, and whether restoring it moves the credential target. |
| `connector_adapter_save({identifier, adapter, confirmCredentialWipe?, allowRemovingOperations?})` | write, gated | Validates the document with the server parser and saves it after an `api-connector:admin` approves (below). |
| `connector_adapter_restore({identifier, versionId, confirmCredentialWipe?})` | write, gated | Puts a kept version back, checked and approved like a save. |

**Adapter authoring by the agent.** An admin can ask the agent to connect a
system: it reads the vendor's API docs with `web_search` and `web_fetch`,
reads the guide with `connector_adapter_reference`, saves the adapter, asks
for the credentials with `request_secret` and tests each read. The agent
instructions for this sit in a guide section loaded with the authoring tools.
`connector_adapter_save` and `connector_adapter_restore` are host tools
(`authoring-tools.ts`) whose approvals are decided by `api-connector:admin`,
never `api-connector:approve`, and re-checked when they run; neither is ever
auto-approved. At staging the preflight validates the document (an invalid
one is refused with every issue, before any approval exists), compares it
with the stored one and pins `priorHash`, `priorTarget`, `newTarget` and
`credentialsPresent` onto the call; the approval card is rendered from those
(the API's origin and auth type, the operations, and a warning when stored
credentials will be deleted). The card is built from the document itself and a
fresh comparison with what is stored, never from the call's pinned values; it
lists each operation's method and path, every read-only POST on a line of its
own. A call that reaches execution without its pins (its preflight never ran)
runs nothing, and pins that differ from a fresh plan refuse it. A save that
moves the credential target while credentials are stored is refused until the
call carries `confirmCredentialWipe: true`, and credentials entered after the
plan refuse the save rather than being deleted by it; a save that drops operations of the stored
document is refused unless `allowRemovingOperations` names them. At execution
a stored document other than the one the approval was asked for refuses the
save (`adapter_changed`, nothing written). The saver recorded is the approver
(or the admin, for a direct call). Every save, by any path, keeps the
replaced document in `app_api_connector.adapter_versions` (the last 20 per
connection; deleting the connection deletes them).

**`connector_write` at staging and at execution.** Before an approval is
parked, the tool's preflight checks everything knowable without calling the
API: the connection and the operation exist, the operation is a `write`, the
params match its schema (formats included), the rendered URL stays under the
base URL, and the connection has credentials. Any failure is refused at once
(`unknown_connection`, `unknown_operation`, `write_not_allowed`,
`invalid_params`, `host_refused`, `not_configured`) and no approval is left
for a person to decide in vain. A param the operation does not declare, or a
required one left out, is refused with the operation's required and optional
param names (`create_contact accepts required: email, firstName, lastName;
optional: …`), so the caller corrects the call in one retry. On success the preflight pins the canonical
target onto the staged call as `target: {method, host, path, adapterHash}`
(path = the rendered path with its query, never an auth value): a `target`
the caller passed is dropped (the tool declares `pinnedParams: ["target"]`),
a call naming an earlier step with `@ref:` is refused at staging, and the
approval card is titled with the operation in words, the connection and who it
is about (`Create contact in CRM: Ines Duarte`, from `name`, `firstName` and
`lastName`, `title`, `subject` or `email`) and shows
`METHOD host/path` above the params. When the approval runs, the write is
refused with `write_not_allowed` (nothing sent, audited) unless the stored
adapter still has that hash and the params still render to that method,
host and path: an adapter replaced, or the params edited, between approval
and execution never sends a request the approver did not see. A write staged
without a pinned target (a sequenced step whose params carry references) is
refused the same way.

**The record a write made.** A write's result carries `record_id`: the `id` of
the record it created or updated, read from the API's answer when the
operation lists `id` in its `fields` and the value is a plain id (letters,
digits and `. _ : @ -`, at most 128 characters). Otherwise it is `null` and
`record_id_note` says why. `record_id` is a referenceable output, so a later
step proposed in the same approval (a quote for the new contact) can take it
as `@ref:<approvalRequestId>:record_id` before anyone approves.

The tools are deferred: an agent finds them with `tool_search` (only with the
app's read scope; without it they are at most listed as locked). Every tool
declares a 60 s tool timeout; pagination stops at 5 pages, 200 items or a 45 s
total budget, whichever comes first. Failures come back as
`{error: {code, message, status, upstreamStatus?}}` with the codes of section 6
(`status` is the code's HTTP class, `upstreamStatus` the API's own answer).

**What the agent knows before it loads a tool.** On every turn whose scopes
hold `api-connector:read`, the agent's prompt carries a "Connected business
systems" block with one line per connection, on any page, not only a ticket:
the system's name and slug, its read operations, and, with
`api-connector:write`, its write operations through `connector_write`,
approval required (six operations per kind, then a count). The block says a
note or change for one of those systems' records (a company, contact, deal or
order) is a `connector_write` there, never a Liaison ticket note or contact
edit. The deferred-tool catalog's `api-connector` line names each system's
write operations too. `tool_search` weighs each connection's operation names,
system name and slug like a tool name (and, for `connector_write`, the words
update, change and write), and starts the tool's search result with the
system and its operations: "add a note to a company in the CRM", "add note
company" and "update CRM" find `connector_write` first. Liaison's own
`tickets addNote` says it writes an internal note on a Liaison ticket, and its
result names the ticket and says nothing was written to an external system.

### Customer card and agent context

`GET /api/api-connector/customer` asks every connection whose adapter fills
`customer.lookup`: by email first, then by phone (when one is given), then by
the company domain (the email's, or the one given), each only when the lookup
operation declares that param. Only a plain addr-spec
(`^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$`) is looked up at all; a
phone is digits with an optional `+` (spaces, dots, dashes and brackets are
dropped). The domain fallback is skipped for a consumer mail domain (a
committed list: gmail.com, googlemail.com, outlook.com, hotmail.com, live.com,
msn.com, yahoo.\*, icloud.com, me.com, proton.me, protonmail.com, gmx.\*,
web.de, orange.fr, free.fr, laposte.net, wanadoo.fr, sfr.fr, aol.com,
yandex.\*, mail.ru, qq.com, 163.com; `consumer-domains.ts`) and for the
domains of the org's own mailboxes and ticket inboxes: such a domain names no
company. Each match says how it was found (`matchedBy`: `email`, `phone` or
`domain`). The resolver keeps at
most 3 matches per connection, and calls that connection's
`customer.summary`, `customer.orders`, `customer.invoices` and `deal.list`
operations in parallel for each match (one page each, at most 20 list items).
When the lookup is chained (section 3, Chained reads), its matches are the
chain's last step's records: an email search of contacts that follows each
contact's company id returns companies, and they count as email matches.
Each connection gets at most 20 upstream requests per resolution (every
page and chain step counts), shared by the lookup and every role call of
every match; the lookup goes first, and a role call the budget cannot cover is
left out of the match (no list, no error). The budget is per connection, so a
connection's cached answer never depends on another's.
The whole lookup has a 10 s budget and 8 s per call; each connection's answer
is cached for 60 s (keyed on the adapter hash and the credential version,
dropped on any adapter or credential change). A connection that fails is
reported in `errors` and never hides the others.

The card sits in the ticket details panel and under the mail conversation
header. On a ticket it is keyed on the ticket's participant as `tickets:get`
reports it (`participantEmail`): the requester, else the linked contact's
address (the contact linked now), else the first inbound sender by received
time that is not one of the org's inboxes, a plain addr-spec only
(`ticketParticipantEmail` in `packages/shared`, loaded by
`loadTicketParticipantEmail`). On a mail conversation it is the first inbound
sender that is not one of the org's own mailboxes, so a thread we started
still shows the customer. A record found by the company domain is labelled
"Matched by company domain": it is the company, and the card never presents
it as the sender. When a `connector_write` approval for that person (or one
naming no email, such as a note on a company) is approved and has run, the
card reads the customer again in place, without the loading skeleton, so a
contact the agent just created shows at once; it also re-reads after a
reconnect. A write drops the connection's cached lookups first, so that read
is fresh.

When the user is viewing one of those, the agent gets the first connection's
(by slug) `customer.summary` for the same person, found by the same loader:
looked up by **email only** (no phone, no domain fallback), and used only for
an email match, so a domain match never reaches the agent as the sender. The
block is at most 2 KB, a 1.5 s budget, nothing on a miss or an error; the
sender's address is named inside the untrusted fence with the record, never
outside it, and an address that is not a plain addr-spec yields no block. It
is added only when the turn's effective scopes hold `api-connector:read`.
A turn with that block loads `connector_list_operations`, `connector_read`
and, with the write scope, `connector_write`; never the adapter authoring
tools.

A list row on the card shows its title (with the full title as a tooltip when
it is cut), its date in the short numeric style on one line, its amount and its
status.

---

## 2. Safety stack

No single layer is trusted on its own; each one below is enforced in code and
covered by its own test.

| Layer | Mechanism | Where |
|---|---|---|
| 1 | Scopes, app-wide: `api-connector:read` (members), `api-connector:write` (members, gated tools), `api-connector:admin` (admins: adapters), `api-connector:accounts:admin` (admins: credentials) | manifest + `execute-tool` |
| 2 | Adapter validation: one schema for every entry point (upload, `config apply`, CLI); a path-precise issue list on refusal | `packages/api-connector-core` (`validateAdapter`) |
| 3 | Host pinning: requests go only to the `baseUrl` host; a path template cannot carry a scheme, a host, `..`, `%`, `?` or `#`, and every rendered URL is re-checked to stay under the base URL | core `render` / `buildRequestUrl` |
| 4 | Templating: params validated against the operation's schema (unknown, missing, mistyped, out of range refused); path values URL-encoded one segment each, `.`/`..`/control characters refused; query through `URLSearchParams`; body built as a value tree, never string-spliced JSON; the built-ins `{$now}`/`{$nowMs}` and `$when` exist in the body only and carry no caller text | core `render` |
| 5 | SSRF guard: DNS pinned for the request; private, loopback and link-local addresses refused unless the deployment sets `LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true`; cloud metadata and other always-blocked addresses refused even then | `fetchWithPinnedHost` |
| 6 | Redirects: every hop is validated and must stay on the adapter's host; an off-host redirect is refused (`host_refused`) | `fetchWithPinnedHost` `onHopValidate` |
| 7 | https only: `baseUrl` and `tokenUrl` are https; http is accepted by the schema only for a loopback host, and reachable only with the private-hosts flag (development). Both are written in their own normalized form (what an admin reads is what is requested): no backslash, userinfo or `%2e`, an IPv4 host only as a dotted quad (no hex, octal, decimal or short form), no IPv6 literal embedding an IPv4 address without the private-hosts flag. The token host is checked at upload with the egress classifiers (link-local and metadata always refused, private ones unless the flag is set) | schema + `adapter-policy.ts` + egress |
| 8 | Field projection, leaf only: each item keeps only the `fields` paths (or, with a field map, only the mapped output names), and a value must be a scalar or an array of scalars (an object-valued path is refused at validation, an object found at a mapped path is dropped); arrays are walked explicitly or indexed; inherited and prototype keys are never copied | core `project` |
| 9 | Size and time caps: 15 s per request, 2 MB streamed response cap (`too_large`), 200 items per call, 5 pages per call, 45 s pagination budget; at most 4 requests in flight per connection (in this process); 20 upstream requests per connection per customer resolution | bridge + core + transport + resolver |
| 10 | Credential redaction: credentials are decrypted host side only, never reach the sandbox, a tool result, a log line, an error or an audit row; every non-empty secret credential value (API key, token, password, client secret; raw and URL-encoded, whatever its length), the Basic header built from them and the oauth2 token are redacted from the projected items, while an identifier (a Basic username, an OAuth client id) is not a secret and passes through, so the account's own email in an answer stays readable, so an API that echoes the key in an allowed field still never hands it to a tool result, the Test panel or the card; an upstream error returns its status and a fixed message, never the body; query-auth values are stripped from every URL before it is logged | transport |
| 11 | Write approvals: every `write` operation runs only through `connector_write`, which is `gated: true` (`connector_read` refuses a write operation, `write_not_allowed`), checked at staging and pinned to the method, host, path and adapter hash the approver saw (section 1, Tools); the `/test` route and the CLI `test` refuse writes (`write_not_testable`) with zero upstream requests | manifest + preflight + service + routes |
| 12 | Scope taint: connector output (and the customer summary injected as context) is untrusted external content; it adds `api-connector:read` to the turn's accumulated scopes and marks the turn tainted, so an ungated write to a sink a non-holder can read is refused or parked | agent scope taint |
| 13 | Demo isolation: in a demo org the seeded fixture connection is answered in-process (no outbound request at all), any other egress is refused (`demo_restricted`), and adapter uploads and credential creation are refused (403) | transport + routes |
| 14 | Audit: every call writes an audit row (connection, operation name, actor, status, duration), built from the operation name, never from the URL | bridge |
| 15 | OAuth2 tokens: `tokenUrl` lives in the adapter (never a credential field), on the `baseUrl` host or the declared `tokenHost`; the token request is pinned to that host, and refused for a demo org before it leaves the box (`demo_restricted`); tokens are cached per connection, keyed on the adapter hash and the credential version, and dropped on any adapter or credential change. The credential version is an HMAC-SHA256, under the server secret, of the credential account's row id and update time: no cache key is derived from a credential value | schema + transport + store |
| 16a | Chained reads: a chain step is an operation of the same adapter (same host, auth, params schema and projection), a read, not itself chained; at most 2 steps, at most 3 distinct calls per step, one page each, within the call's one time budget; a step's params come from the previous step's projected output only (never the raw response) and pass the step's params schema like any caller value | core `validateAdapter` + `chain` + service |
| 16 | Credential binding: a stored credential is bound to its target, the API origin (scheme, host, port), the auth type, the apiKey `in`/`name` and the oauth2 `tokenUrl`/`tokenHost`. An adapter re-upload (Settings or `config apply`) that changes any of these deletes the identifier's credentials in the same transaction, and the connection reads `needs_credentials`: an `api-connector:admin` without `accounts:admin` can re-point an adapter, never redirect a secret someone else entered | store (`credentialTarget`) |

---

## 3. Adapter format reference

An adapter is one JSON or YAML document (YAML is parsed with unique keys, no
custom tags and a small alias budget; at most 256 KB, 100 operations). The
JSON Schema is `packages/api-connector-core/adapter.schema.json`: point your
editor at it with a `$schema` key for completion.

```yaml
$schema: ../packages/api-connector-core/adapter.schema.json
id: fixture-crm
name: Fixture CRM
version: "1.0.0"
baseUrl: http://127.0.0.1:4010/v1      # a real API: https://api.yourcrm.example/v1
auth: { type: apiKey, in: header, name: X-Api-Key }
operations:
  - name: list_orders
    description: One customer's sales orders, newest first. since = YYYY-MM-DD.
    kind: read
    method: GET
    path: /companies/{customerId}/orders
    role: customer.orders
    params:
      type: object
      properties:
        customerId: { type: string, maxLength: 64 }
        since: { type: string, format: date }
      required: [customerId]
    query: { since: "{since}" }
    items: /data
    fields: [id, number, date, status, total, currency, lines.sku, lines.quantity]
```

### Rules the JSON Schema cannot express

`validateAdapter` checks these too, each with the path of the offending value:

- **Read methods.** A `read` operation is `GET`, or `POST` with
  `readOnlyPost: true` (a search endpoint). `readOnlyPost` on anything else is
  refused. A `GET` carries no `body`. A read `POST` without a `body` is refused
  when one of its params is mapped to neither the path nor `query` (it would be
  sent nowhere); one that sends no body at all is saved with a warning, since a
  search endpoint usually needs one. An adapter saved before this rule keeps
  loading and working; reading it reports the issue in `warnings`.
- **Placeholders.** Every `{name}` in `path`, `query` or `body` names a
  declared param. A path placeholder's param must be `required` and not an
  array. Stray braces are refused. `required` names only declared params.
- **Path shape.** Starts with `/`; no scheme, host, `//`, `.`/`..` segment,
  `%`, `?` or `#`.
- **Fields.** No wildcard, no index, no prototype key, no duplicate, and no
  path that is the prefix of another (`account_manager` together with
  `account_manager.name` is refused: list the leaves). A field map's output
  names follow the same rules; its source paths may also hold an array index
  (`0` to `999`) after the first segment.
- **Enums** hold values of the param's own type.
- **Roles.** A role is filled by a `read` operation, at most once per
  adapter, and the operation declares the role's params and returns its
  fields, listed or mapped (section 4); for a chained operation the fields
  are the last step's. A role field that is neither listed nor mapped is
  refused, with the map to add in the message.
- **Chains** (`chain`) are on `read` operations only, 1 or 2 steps. Each step
  names a `read` of this adapter other than the operation itself and not
  chained itself; its `params` are params that step declares, each a literal
  or exactly `{field}`, an output field of the previous step (the operation
  for the first step), and they cover every required param of the step.
- **No unfiltered search by accident.** A body whose every param sits under
  `$when`, in an operation with no required param and no query placeholder,
  is refused: called without params it would send no filter at all. Make a
  param required or keep one filter without `$when`. A role answering "at
  least one of" params (`customer.lookup`, `stock.check`) is exempt, because
  the host refuses such a role called without one of them (`invalid_params`,
  before any request), whoever calls it.
- **Body built-ins and `$when`.** `{$now}` and `{$nowMs}` are the only `$`
  placeholders, and only in `body` (in a `query` or `path` they are refused,
  so a write's pinned target never changes between approval and execution).
  `$when` names a declared param, or a list of 1 to 10.
- **Pagination** is for `read` operations; its `param` (and `sizeParam`)
  cannot also be a mapped `query` key.
- **baseUrl** carries no credentials, query, fragment or dot segment, and is
  written exactly as its normalized URL (`new URL(raw).href`; the root `/` may
  be left out): no upper-case host, default port, backslash, `%2e`, or IPv4
  host other than a dotted quad (`https://0x7f000001`, `https://2130706433`,
  `https://0177.0.0.1` and `https://127.1` are refused). An IPv6 literal
  embedding an IPv4 address (`[::ffff:7f00:1]`) is refused unless the
  deployment sets the private-hosts flag.
- **tokenUrl** (oauth2) is a URL on the `baseUrl` host or `tokenHost`, in the
  same normalized form, with no credentials or fragment; `tokenHost` is a
  normalized hostname. On the server both are checked with the egress
  classifiers: a link-local or metadata address is always refused, a private
  one unless the private-hosts flag is set. The token request goes through the
  same egress checks, pinned to that host, with no redirect.
- **Param formats** (`format` on a string param: `email` as a plain addr-spec,
  `date` as an existing `YYYY-MM-DD`, `date-time` as RFC 3339 with an offset,
  `uri` as an absolute URI, `uuid`) are enforced on every call, before any
  request (`invalid_params`).

### Request rendering

- `query` maps a query key to a template. `"{since}"` (exactly one
  placeholder) sends the param's value, repeating the key for an array; an
  unset optional param drops the key. Other templates (`"name:{q}"`)
  interpolate, and are dropped when a placeholder is unset.
- `body` is a value tree. A string that is exactly `"{pinned}"` takes the
  param's typed value (a boolean stays a boolean); other strings interpolate
  as strings; literals pass through; unset params drop their key (in an
  array, the element). Placeholders render at any depth, inside arrays too.
- **Optional filters.** An object of the body that carries `$when: email`
  (or `$when: [email, since]`) is sent only when every param it names is set,
  and the `$when` key is never sent. A search body whose filters sit in an
  array (`filterGroups: [{filters: [{propertyName: email, value: "{email}"}]}]`)
  puts `$when` on the filter, or on its group, so an unset param removes the
  whole filter instead of leaving one without a value.
- **Current time.** `{$now}` renders the time the request is built as RFC
  3339 UTC (`2026-10-26T09:30:00.000Z`); `{$nowMs}` as epoch milliseconds, a
  number when it is the whole string. Use them for a note's or activity's
  timestamp; body only.
- `items` is a JSON pointer (`/data`, `/company`) to the item list; an object
  there counts as one item; empty means the whole response. A pointer that
  finds nothing gives zero items, not an error.

### Field maps

`fields` is either a list of dotted paths, each returned under its own path,
or a map from the name an item carries to the path it is read from:

```yaml
fields:
  id: id
  name: properties.name          # a nested value under a flat name
  email: emails.0.value          # an index picks one element of a list
  tags: tags.label               # a list of objects is walked: the labels, as a list
  owner.name: properties.owner   # an output name may nest too
```

Only the mapped names come out; a source path that finds nothing, or finds an
object, leaves its name out of the item. Use a map when the API nests the
values a role needs (`customer.lookup` needs `id` and `name`) or when the card
should title and label rows: it titles a customer with `name`, a deal, order
or invoice row with `title`, `name` or `subject`, and shows `status`,
`stage` or `state` beside it.

### Chained reads

A `read` may chain up to 2 further reads of the same adapter. The operation
runs its own request; then, for each step, the host takes the first items of
the previous step's projected output that carry the referenced fields (at
most 3 distinct param sets: two contacts of one company make one call), calls
the step's operation with them (one page each), and the last step's items are
the call's result. A step's params are literals, or exactly `{field}`, a field
the previous step returns; a number feeds a string param as its digits.
Items without the field are not followed (a contact without a company). Every
step is an ordinary operation of the adapter: the same host, auth, params
schema (formats and bounds apply to the upstream values), projection, caps
and budget. One audit row covers the call. `connector_read`, the Test panel,
the CLI `test` and the customer resolver all run the whole chain.

The usual case is an email lookup where people and companies are separate
records:

```yaml
- name: find_customer
  kind: read
  method: POST
  readOnlyPost: true
  path: /contacts/search
  role: customer.lookup
  params: { type: object, properties: { email: { type: string, format: email } } }
  body: { filters: [{ $when: email, field: email, value: "{email}" }] }
  items: /results
  fields: { contactId: id, companyId: company.id }
  chain:
    - operation: get_company            # a read with role customer.summary, say
      params: { customerId: "{companyId}" }
```

The role's fields (`id`, `name`) are checked against the last step.
- Pagination: `cursor` sends `param=<value at cursorPointer>` until the value
  is empty or missing; `page` sends `param=1,2,...` (and `sizeParam=size`)
  until a page is shorter than `size`. Both stop at `maxPages` (≤ 5).

### Credentials per auth type

| `auth.type` | Credential fields (all required) | Sent as |
|---|---|---|
| `apiKey` | `apiKey` | header or query parameter `auth.name` |
| `bearer` | `token` | `Authorization: Bearer <token>` |
| `basic` | `username`, `password` | `Authorization: Basic ...` |
| `oauth2ClientCredentials` | `clientId`, `clientSecret` | a client-credentials token from `auth.tokenUrl`, sent as a bearer token |

### HubSpot

HubSpot's REST API takes a **service key** as a bearer token (`auth.type: "bearer"`). Free
accounts can create one; legacy private apps are no longer offered to new accounts.

1. In HubSpot, open **Development › Keys › Service keys** and create a key.
2. Grant the scopes the adapter's operations need:

   | Operations | Scopes |
   |---|---|
   | `customer.lookup` (contact search by email, then the contact's company) | `crm.objects.contacts.read`, `crm.objects.companies.read` |
   | `customer.summary`, company search and list | `crm.objects.companies.read` |
   | `deal.list` | `crm.objects.deals.read` |
   | Notes on a company, read and write | `crm.objects.companies.read`, `crm.objects.companies.write` |
   | `create_company` / `create_contact` | `crm.objects.companies.write` / `crm.objects.contacts.write` |
   | `customer.orders` / `customer.invoices`, when the account has them | `crm.objects.orders.read` / `crm.objects.invoices.read` (without them those endpoints answer 403) |

3. Copy the key (`pat-<region>-…`) into the connector's `token` field on **Settings ›
   Connectors**, or into `apiConnectors[].credentials.token` with `liaison config apply`.
4. Point the adapter's `baseUrl` at `https://api.hubapi.com`.

Rotate the key from the same page; a rotated key takes effect on the next call after you
update the credential. A free account has one company currency, so amounts arrive in it.

What the adapter has to know about HubSpot's CRM v3 API:

- A record nests its values under `properties` (`{id, properties: {name, domain}}`):
  map them with a field map. Ask for the properties you map (`properties` in a search
  body, the `properties` query parameter on a get); HubSpot returns only a few by default.
- Search is a `POST /crm/v3/objects/<object>/search` (mark it `readOnlyPost: true`); its
  filters sit in `filterGroups[].filters[]`, and a filter without a `value` is a 400, so
  each optional filter carries `$when`. `associations.company` with the company id
  filters deals, contacts and notes by company.
- The email is on a contact, not a company: the lookup searches contacts and chains to
  the contact's primary company (`associatedcompanyid`). The contact property
  `hs_email_domain` lets the same lookup answer a domain. Companies a contact is not
  attached to are found by `domain` on the company search instead.
- A note needs `hs_timestamp` (`{$now}`) and an association to its company:
  `associationTypeId` 190 (note to company, `HUBSPOT_DEFINED`).
- List endpoints page with `after` at `/paging/next/after`.

A complete adapter (customer = a HubSpot company):

```yaml
id: hubspot
name: HubSpot CRM
version: "1.0.0"
baseUrl: https://api.hubapi.com
auth: { type: bearer }
operations:
  - name: find_customer
    description: >-
      The customer company of a person, by their exact email address, or the companies of
      the people at an email domain. Returns the companies (at most 3); their id is the
      customerId of the other operations.
    kind: read
    method: POST
    readOnlyPost: true
    path: /crm/v3/objects/contacts/search
    role: customer.lookup
    params:
      type: object
      properties:
        email: { type: string, format: email, maxLength: 254 }
        domain: { type: string, minLength: 3, maxLength: 253 }
    body:
      filterGroups:
        - $when: email
          filters: [{ propertyName: email, operator: EQ, value: "{email}" }]
        - $when: domain
          filters: [{ propertyName: hs_email_domain, operator: EQ, value: "{domain}" }]
      properties: [email, associatedcompanyid]
      limit: 5
    items: /results
    fields: { contactId: id, companyId: properties.associatedcompanyid }
    chain:
      - operation: get_company
        params: { customerId: "{companyId}" }

  - name: get_company
    description: One customer company by customerId (a HubSpot company id, digits only).
    kind: read
    method: GET
    path: /crm/v3/objects/companies/{customerId}
    role: customer.summary
    params:
      type: object
      properties: { customerId: { type: string, maxLength: 32 } }
      required: [customerId]
    query: { properties: "name,domain,city,country,industry,lifecyclestage" }
    items: ""
    fields:
      id: id
      name: properties.name
      domain: properties.domain
      city: properties.city
      country: properties.country
      industry: properties.industry
      stage: properties.lifecyclestage

  - name: list_company_deals
    description: One customer company's deals, most recently modified first.
    kind: read
    method: POST
    readOnlyPost: true
    path: /crm/v3/objects/deals/search
    role: deal.list
    params:
      type: object
      properties: { customerId: { type: string, maxLength: 32 } }
      required: [customerId]
    body:
      filterGroups:
        - filters: [{ propertyName: associations.company, operator: EQ, value: "{customerId}" }]
      properties: [dealname, amount, dealstage, closedate, hs_lastmodifieddate]
      sorts: [{ propertyName: hs_lastmodifieddate, direction: DESCENDING }]
      limit: 50
    items: /results
    fields:
      id: id
      name: properties.dealname
      amount: properties.amount
      stage: properties.dealstage
      close_date: properties.closedate

  - name: list_company_notes
    description: The notes on one customer company's timeline, newest first.
    kind: read
    method: POST
    readOnlyPost: true
    path: /crm/v3/objects/notes/search
    params:
      type: object
      properties: { customerId: { type: string, maxLength: 32 } }
      required: [customerId]
    body:
      filterGroups:
        - filters: [{ propertyName: associations.company, operator: EQ, value: "{customerId}" }]
      properties: [hs_note_body, hs_timestamp]
      sorts: [{ propertyName: hs_timestamp, direction: DESCENDING }]
      limit: 20
    items: /results
    fields: { id: id, body: properties.hs_note_body, created_at: properties.hs_timestamp }

  - name: list_companies
    description: All customer companies, page by page. Use for "which customers do we have".
    kind: read
    method: GET
    path: /crm/v3/objects/companies
    params: { type: object, properties: {} }
    query: { limit: "50", properties: "name,domain,city,country" }
    pagination: { type: cursor, param: after, cursorPointer: /paging/next/after, maxPages: 2 }
    items: /results
    fields: { id: id, name: properties.name, domain: properties.domain }

  - name: add_company_note
    description: Add a note to a customer company's timeline, stamped now. text is plain text.
    kind: write
    method: POST
    path: /crm/v3/objects/notes
    params:
      type: object
      properties:
        customerId: { type: string, maxLength: 32 }
        text: { type: string, minLength: 1, maxLength: 2000 }
      required: [customerId, text]
    body:
      properties: { hs_note_body: "{text}", hs_timestamp: "{$now}" }
      associations:
        - to: { id: "{customerId}" }
          types: [{ associationCategory: HUBSPOT_DEFINED, associationTypeId: 190 }]
    items: ""
    fields: { id: id, body: properties.hs_note_body }

  - name: create_company
    description: Create a customer company. Look it up by domain and name first.
    kind: write
    method: POST
    path: /crm/v3/objects/companies
    params:
      type: object
      properties:
        name: { type: string, minLength: 1, maxLength: 200 }
        domain: { type: string, maxLength: 253 }
      required: [name]
    body:
      properties: { name: "{name}", domain: "{domain}" }
    items: ""
    fields: { id: id, name: properties.name, domain: properties.domain }

  - name: create_contact
    description: Create a person, attached to their company when customerId is given.
    kind: write
    method: POST
    path: /crm/v3/objects/contacts
    params:
      type: object
      properties:
        email: { type: string, format: email }
        firstName: { type: string, maxLength: 200 }
        lastName: { type: string, maxLength: 200 }
        title: { type: string, maxLength: 200 }
        customerId: { type: string, maxLength: 32 }
      required: [email]
    body:
      properties:
        email: "{email}"
        firstname: "{firstName}"
        lastname: "{lastName}"
        jobtitle: "{title}"
      associations:
        - $when: customerId
          to: { id: "{customerId}" }
          types: [{ associationCategory: HUBSPOT_DEFINED, associationTypeId: 1 }]
    items: ""
    fields: { id: id, email: properties.email }
```

HubSpot creates one object per call, so a customer new to it takes two approvals:
`create_company`, then `create_contact` with the company id it returned
(`associationTypeId` 1 makes it the contact's primary company).

With it, a mail or ticket from a contact's address shows the company on the customer
card as an email match, titled with its name, with its deals named and staged; the
agent's context gets the company's summary. Check it:

```sh
liaison api-connector test hubspot find_customer --param email=anna@northwind.example
liaison api-connector test hubspot list_companies --all-pages
liaison api-connector test hubspot add_company_note --dry-run --param customerId=<id> --param text="Called about the order"
```

`list_companies` is a cheap param-less read, so `config verify` probes it rather than
the lookup.

### Field table

Generated from the JSON Schema by `scripts/api-connector-schema-doc.ts`
(`--write` regenerates, `--check` fails when stale; a test keeps it in sync).
`[type=...]` marks the fields of one variant of a union.

<!-- api-connector-schema:begin (generated by scripts/api-connector-schema-doc.ts; do not edit) -->
| Field | Type | Required | Constraints | Notes |
|---|---|---|---|---|
| `$schema` | string | no | length ≤ 512 | Editor hint only (path or URL of adapter.schema.json); ignored at runtime. |
| `id` | string | yes | pattern `^[a-z0-9][a-z0-9-]{0,63}$` | Adapter id, a lowercase slug. |
| `name` | string | yes | pattern `^[^\u0000-\u001f\u007f-\u009f\u2028\u2029<>\u0060"]+$`; length 1..80 | Display name, shown to people and named in the agent's prompt: one line, ≤ 80 characters, no `<`, `>`, backtick or double quote. |
| `version` | string | yes | pattern `^[0-9A-Za-z.+-]{1,32}$` | Your adapter's version; bump it on every change (caches are keyed on it). |
| `description` | string | no | length ≤ 2000 |  |
| `baseUrl` | string | yes | length ≤ 2048 | https, written as its own normalized URL (no backslash, userinfo, `%2e`, query or fragment; an IPv4 host only as a dotted quad). http only for a loopback host, and only reachable when LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true. Changing its origin deletes the stored credentials. |
| `redirectHosts` | array | no | items ≤ 10 | Hosts a download from this API may be redirected to (a media or storage host), under a registrable domain: never an IP address or a public suffix. https only; credentials are never sent to them. |
| `redirectHosts[]` | string | yes | pattern `^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`; length ≤ 253 |  |
| `auth` | object | yes | `type` one of `apiKey`, `bearer`, `basic`, `oauth2ClientCredentials` |  |
| `auth[type=apiKey].in` | string | yes | one of `header`, `query` |  |
| `auth[type=apiKey].name` | string | yes |  | Header or query parameter name the key is sent in. |
| `auth[type=oauth2ClientCredentials].tokenUrl` | string | yes | length ≤ 2048 | Lives in the adapter, never in the credentials. https, in normalized form, on the baseUrl host or `tokenHost`; never a link-local, metadata or (without the private-hosts flag) private address. |
| `auth[type=oauth2ClientCredentials].tokenHost` | string | no | pattern `^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`; length ≤ 253 | A second host allowed for tokenUrl (an identity provider on its own domain), in normalized form, checked like tokenUrl. |
| `auth[type=oauth2ClientCredentials].scope` | string | no | length ≤ 1000 |  |
| `headers` | object | no |  | Literal headers sent with every request, on the first hop only, like auth (an API's opt-in flag such as `X-ExperimentalApi: opt-in`). At most 10. Never a credential: auth, cookie, host, length, hop-by-hop, proxy and forwarding headers are refused, and a value is 1 to 256 characters with no line break, `{`, `}` or `$`. |
| `headers.<key>` | string | no |  |  |
| `operations` | array | yes | items 1..100 |  |
| `operations[]` | object | yes |  |  |
| `operations[].name` | string | yes | pattern `^[a-z][a-z0-9_]{0,63}$` | What the agent calls (`connector_read` / `connector_write`). |
| `operations[].description` | string | yes | length 1..1000 | Shown to the agent; say when to use it and what the params mean. |
| `operations[].kind` | string | yes | one of `read`, `write` | `read` (GET, or POST with readOnlyPost) or `write` (always approval-gated). |
| `operations[].method` | string | yes | one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |  |
| `operations[].readOnlyPost` | boolean | no |  | Marks a search-style POST as a read. |
| `operations[].path` | string | yes | length ≤ 1024 | Relative to baseUrl; `{param}` placeholders name required, non-array params; each value is URL-encoded as one segment. |
| `operations[].params` | object | yes |  | A JSON Schema subset; unknown params are refused, and a string's `format` (email, date, date-time, uri, uuid) is enforced before any request. |
| `operations[].params.type` | string | yes | = `object` |  |
| `operations[].params.description` | string | no | length ≤ 500 |  |
| `operations[].params.properties` | object | no | default `{}`; keys match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` |  |
| `operations[].params.properties.<key>` | object | no | `type` one of `string`, `number`, `integer`, `boolean`, `array` |  |
| `operations[].params.properties.<key>[type=string].description` | string | no | length ≤ 500 |  |
| `operations[].params.properties.<key>[type=string].enum` | array | no | items 1..100 |  |
| `operations[].params.properties.<key>[type=string].enum[]` | string \| number | yes | string: length ≤ 200 |  |
| `operations[].params.properties.<key>[type=string].format` | string | no | one of `date`, `date-time`, `email`, `uri`, `uuid` |  |
| `operations[].params.properties.<key>[type=string].minLength` | integer | no | value ≥ 0 |  |
| `operations[].params.properties.<key>[type=string].maxLength` | integer | no | value 1..10000 |  |
| `operations[].params.properties.<key>[type=number].description` | string | no | length ≤ 500 |  |
| `operations[].params.properties.<key>[type=number].enum` | array | no | items 1..100 |  |
| `operations[].params.properties.<key>[type=number].enum[]` | string \| number | yes | string: length ≤ 200 |  |
| `operations[].params.properties.<key>[type=number].minimum` | number | no |  |  |
| `operations[].params.properties.<key>[type=number].maximum` | number | no |  |  |
| `operations[].params.properties.<key>[type=integer].description` | string | no | length ≤ 500 |  |
| `operations[].params.properties.<key>[type=integer].enum` | array | no | items 1..100 |  |
| `operations[].params.properties.<key>[type=integer].enum[]` | string \| number | yes | string: length ≤ 200 |  |
| `operations[].params.properties.<key>[type=integer].minimum` | integer | no |  |  |
| `operations[].params.properties.<key>[type=integer].maximum` | integer | no |  |  |
| `operations[].params.properties.<key>[type=boolean].description` | string | no | length ≤ 500 |  |
| `operations[].params.properties.<key>[type=array].description` | string | no | length ≤ 500 |  |
| `operations[].params.properties.<key>[type=array].items` | object | yes | `type` one of `string`, `number`, `integer`, `boolean` |  |
| `operations[].params.properties.<key>[type=array].items[type=string].description` | string | no | length ≤ 500 |  |
| `operations[].params.properties.<key>[type=array].items[type=string].enum` | array | no | items 1..100 |  |
| `operations[].params.properties.<key>[type=array].items[type=string].enum[]` | string \| number | yes | string: length ≤ 200 |  |
| `operations[].params.properties.<key>[type=array].items[type=string].format` | string | no | one of `date`, `date-time`, `email`, `uri`, `uuid` |  |
| `operations[].params.properties.<key>[type=array].items[type=string].minLength` | integer | no | value ≥ 0 |  |
| `operations[].params.properties.<key>[type=array].items[type=string].maxLength` | integer | no | value 1..10000 |  |
| `operations[].params.properties.<key>[type=array].items[type=number].description` | string | no | length ≤ 500 |  |
| `operations[].params.properties.<key>[type=array].items[type=number].enum` | array | no | items 1..100 |  |
| `operations[].params.properties.<key>[type=array].items[type=number].enum[]` | string \| number | yes | string: length ≤ 200 |  |
| `operations[].params.properties.<key>[type=array].items[type=number].minimum` | number | no |  |  |
| `operations[].params.properties.<key>[type=array].items[type=number].maximum` | number | no |  |  |
| `operations[].params.properties.<key>[type=array].items[type=integer].description` | string | no | length ≤ 500 |  |
| `operations[].params.properties.<key>[type=array].items[type=integer].enum` | array | no | items 1..100 |  |
| `operations[].params.properties.<key>[type=array].items[type=integer].enum[]` | string \| number | yes | string: length ≤ 200 |  |
| `operations[].params.properties.<key>[type=array].items[type=integer].minimum` | integer | no |  |  |
| `operations[].params.properties.<key>[type=array].items[type=integer].maximum` | integer | no |  |  |
| `operations[].params.properties.<key>[type=array].items[type=boolean].description` | string | no | length ≤ 500 |  |
| `operations[].params.properties.<key>[type=array].maxItems` | integer | no | value 1..100 |  |
| `operations[].params.required` | array | no | items ≤ 64 |  |
| `operations[].params.required[]` | string | yes |  |  |
| `operations[].params.additionalProperties` | boolean | no | = `false` |  |
| `operations[].query` | object | no | keys match `^[A-Za-z0-9_.\-[\]]{1,128}$` | Query key to template (`{param}`); an unset param drops its key. |
| `operations[].query.<key>` | string | no | length ≤ 2000 |  |
| `operations[].body` | object | no | keys ≤ 128 chars | A JSON value tree; a string that is exactly `{param}` takes the param's typed value. `{$now}` (RFC 3339) and `{$nowMs}` (epoch ms) are the time of sending; an object with `$when: <param>` is sent only when that param is set. |
| `operations[].body.<key>` | string \| number \| boolean \| null \| array \| object | no | string: length ≤ 2000; array: items ≤ 100; object: keys ≤ 128 chars |  |
| `operations[].items` | string | no | pattern `^(\/([^~/]\|~[01])*)*$`; length ≤ 512 | JSON pointer to the item list (or one object) in the response. |
| `operations[].fields` | array \| object | yes | array: items 1..200; object: keys ≤ 512 chars | Allow-list of dotted paths ending at a scalar or an array of scalars; everything else is dropped. Or a map from an output name to its source path (`name: properties.name`; an index picks one array element: `emails.0.value`): only the mapped names come out. |
| `operations[].role` | string | no | one of `customer.lookup`, `customer.summary`, `customer.orders`, `customer.invoices`, `deal.list`, `stock.check` | Fills a role of the fixed registry (see Roles). |
| `operations[].pagination` | object | no | `type` one of `cursor`, `page` |  |
| `operations[].pagination[type=cursor].param` | string | yes | pattern `^[A-Za-z0-9_.\-[\]]{1,128}$` |  |
| `operations[].pagination[type=cursor].cursorPointer` | string | yes | pattern `^(\/([^~/]\|~[01])*)*$`; length ≤ 512 | JSON pointer to the next cursor in the response; empty or missing stops. |
| `operations[].pagination[type=cursor].maxPages` | integer | no | value 1..5 |  |
| `operations[].pagination[type=page].param` | string | yes | pattern `^[A-Za-z0-9_.\-[\]]{1,128}$` |  |
| `operations[].pagination[type=page].sizeParam` | string | no | pattern `^[A-Za-z0-9_.\-[\]]{1,128}$` |  |
| `operations[].pagination[type=page].size` | integer | yes | value 1..200 | Items per page; a shorter page stops. |
| `operations[].pagination[type=page].maxPages` | integer | no | value 1..5 |  |
| `operations[].chain` | array | no | items 1..2 | A read only: up to 2 further reads of this adapter, each fed by one item of the previous step's output (at most 3 distinct calls per step); the last step's items are the result. |
| `operations[].chain[]` | object | yes |  |  |
| `operations[].chain[].operation` | string | yes | pattern `^[a-z][a-z0-9_]{0,63}$` | A read operation of this adapter that is not itself chained. |
| `operations[].chain[].params` | object | yes | keys match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` | The step's params: a literal, or exactly `{field}`, an output field of the previous step. |
| `operations[].chain[].params.<key>` | string \| number \| boolean | no | string: length ≤ 2000 |  |
<!-- api-connector-schema:end -->

---

## 4. Roles reference

Roles let Liaison use a connection without knowing its operation names. The
customer resolver calls the `customer.lookup` operation with the email of the
ticket's or mail's external participant (then a phone, when the caller gives
one, then the company domain, never a consumer mail or own domain), takes
each match's `id`, and passes it as `customerId` to the other roles present.
The customer card shows the result; the agent receives the `customer.summary`
of an email match only (at most 2 KB, as untrusted content). The card keys on
the participant's email (and its domain); `phone` is used when a caller of
`GET /customer` passes one, and the agent can always call the lookup with a
phone through `connector_read`. Fill only the roles your API can answer.

<!-- api-connector-roles:begin (generated by scripts/api-connector-schema-doc.ts; do not edit) -->
| Role | What it answers | Params (all required) | Params (at least one) | Fields (must be allow-listed) |
|---|---|---|---|---|
| `customer.lookup` | Find customers by email, phone or domain. |  | `email`, `phone`, `domain` | `id`, `name` |
| `customer.summary` | One customer's summary, by customerId. | `customerId` |  |  |
| `customer.orders` | One customer's orders, by customerId. | `customerId` |  | `id` |
| `customer.invoices` | One customer's invoices, by customerId. | `customerId` |  | `id` |
| `deal.list` | One customer's deals, by customerId. | `customerId` |  | `id` |
| `stock.check` | Stock levels, by sku or a free-text query. |  | `sku`, `query` |  |
<!-- api-connector-roles:end -->

**Roles are reads; writes have none.** A role exists so that Liaison's own
surfaces (the customer card, the agent's customer context) can call a
connection without knowing its operation names, and nothing in Liaison
writes to an external system on its own. A write is a plain `kind: write`
operation that only the agent runs, through `connector_write`, behind a
person's approval (section 1, Tools). A note on a company maps to a write
whose `customerId` param is the id the lookup returned: the agent takes it
from the card's record, the context block or a `connector_read`, and the
approval shows the rendered `METHOD host/path` and the params before anything
is sent. Check its request with `liaison api-connector test <connection>
<write> --dry-run --param ...` (section 6).

In the fixture CRM: `find_customers` (lookup, by email, phone or domain),
`get_customer_summary`, `list_orders`, `list_invoices`, `list_deals`,
`check_stock`; plus two operations without a role (`list_companies` with
cursor pagination, `list_contacts`) and three writes: `create_note` (a note
on a company), `create_company`, and `create_contact` (a person at an existing
company by `customerId`, or at a new one created in the same call from
`companyName` and `companyDomain`, so a brand new customer is one approval).

---

## 5. Worked example: the fixture CRM

The fixture is a small fictional CRM/ERP (six companies, including "Acme
Instruments" with contacts on `acme-instruments.example`; deals; orders with
lines over the last 60 days; invoices; stock):

| File | What |
|---|---|
| `data.ts` | The dataset, computed from a reference date (deterministic in tests) |
| `handler.ts` | `createFixtureCrmHandler({apiKey})`: a pure `Request -> Response` handler, also used in-process by the demo |
| `server.ts` | `startFixtureCrm({port?, apiKey})`: the handler on `127.0.0.1` |
| `openapi.json` | Its OpenAPI 3.1 description (the authoring skill's input) |
| `fixture-crm.adapter.yaml` | The adapter, written from `openapi.json` with the skill |
| `fixture-crm.test.ts`, `openapi-drift.test.ts` | Each role against the live server, projection, pagination, auth; the OpenAPI document checked against both the adapter and the server's real responses |

Run it locally:

```sh
FIXTURE_CRM_API_KEY=dev-key bun run apps/api/src/apps/api-connector/__fixtures__/fixture-crm/server.ts
# fixture CRM listening on http://127.0.0.1:4010/v1 (header X-Api-Key;
# without FIXTURE_CRM_API_KEY it answers to fixture-crm-dev-key)
```

Its `baseUrl` is a loopback http host, so every process that calls it needs
`LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true` in its own environment: the
CLI for `liaison api-connector test` and `liaison config verify` (they run the
connector in process), the API server for the agent tools and the customer
card. The authoring skill (`.claude/skills/api-connector-authoring`, Step 7,
"From a checkout") gives the full loop from a checkout against a private
database, with the environment the CLI needs.

Its responses carry fields no adapter should expose (`internal_notes`,
`credit_check.raw_score`, `account_manager.phone_private`, `lines.cost_price`,
`margin`, `bank_reference`, `unit_cost`); the tests prove projection drops
them.

---

## 6. Config and CLI reference

### `liaison config apply`: the `apiConnectors` section

```yaml
apps:
  - name: api-connector
    enable: true

apiConnectors:
  - identifier: crm                      # the connection slug, ^[a-z0-9][a-z0-9-]{0,39}$
    adapter: connectors/crm.adapter.yaml # a path relative to this config file, or the adapter inline
    credentials:
      apiKey: "${CRM_API_KEY}"           # fields per auth type (section 3); secrets only as ${VAR}
  - identifier: erp
    adapter: connectors/erp.adapter.yaml
    credentials:
      clientId: "${ERP_CLIENT_ID}"
      clientSecret: "${ERP_CLIENT_SECRET}"
```

Stored credentials name the person who connected them. Without an `admin`
section in the file, the run acts as the org's earliest active admin; an org
with no active admin gets its adapters but its credentials are refused, with
a message saying to add an `admin` section.

Each entry loads its adapter (a path must be relative to the config file's
directory and stay inside it; an absolute path or one that escapes is refused),
validates it (exit 2 with the issues before anything is written), checks the
credential fields against the adapter's auth type, stores the adapter when it
changed, then the credentials when they changed (compared decrypted, never
printed). An adapter whose credential target changed (origin, auth type,
apiKey placement, token URL or host) deletes the stored credentials with it;
the plan says so, and apply enters the config's credentials again when the
entry has them, or reports them pending. A credentials block whose values are all empty (`${VAR:-}`) is
reported pending. Applying the same file twice changes nothing the second
time; `--dry-run` plans without writing. `config verify` probes each
connection with one page of a `read` operation that has no required params and
is not a role answering "at least one of" params (`customer.lookup`,
`stock.check`, which the connector refuses without one): give the adapter a
cheap param-less list. A connection without one is reported skipped.

### CLI

```
liaison api-connector validate <adapter file>
liaison api-connector test <identifier> <operation> [--param name=value ...] [--pages N | --all-pages] [--dry-run] [--org <slug>]
```

Both print one JSON report on stdout.

- `validate` runs the full schema and role checks offline: it needs no
  environment (no `JWT_SECRET`, `ENCRYPTION_KEY`, database or Redis), so it
  works from a bare checkout once its dependencies are installed
  (`bun install --frozen-lockfile`; without them it fails with `Cannot find
  package ...`). Clean: exit 0 and
  `{"ok":true,"adapter":{id, name, version, baseUrl, auth, roles,
  operations}}`. Invalid: exit 1 and `{"ok":false,"issues":[{"path":
  "operations.3.path","message":"..."}]}`. An unreadable file: exit 2.
  A relative path resolves from the CLI's working directory, which is
  `apps/api` for `bun run --cwd apps/api liaison ...`: pass an absolute path.
- `test` runs one page of one **read** operation of a stored connection,
  through the same service as the agent tools and the Test panel (a chained
  read runs its whole chain). Success: exit 0 and
  `{"ok":true,"status","items","truncated","pages","ms"}`. `--pages N` (1 to
  5) fetches up to N pages and `--all-pages` every page the operation's
  `maxPages` allows (at most 5), within the 45 s budget: check `pages` and the
  item count to see the pagination work.
- `--dry-run` sends nothing and reads no credential, for any operation, a
  write included: exit 0 and `{"ok":true,"dryRun":true,"kind","request":
  {method, url, headers, body, chain?}}`, the request as the first page would
  be sent, with the auth value (header, basic, bearer or query key) shown as
  `REDACTED` and `{$now}` filled. A param that fails the schema is refused as
  usual (`invalid_params`, exit 1). For a chained read, `chain` lists the
  steps that would follow. A connector
  error (including a write operation, refused as `write_not_testable` before
  any request): exit 1 and `{"ok":false,"code","message","status"?}`. A usage
  error, several orgs without `--org`, or a missing or invalid environment
  (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`): exit 2. It
  runs the connector in the CLI's own process, so a loopback or private
  `baseUrl` needs `LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true` in the
  CLI's environment (the API server's own setting does not reach it).
- `--param name=value` repeats, one per param
  (`--param customerId=cmp_001 --param since=2026-05-01`). Each value is
  typed by the operation's params schema: `number`/`integer` as numbers,
  `boolean` as `value == "true"`, an `array` param as a comma-separated list.
  A name the operation does not declare is refused (`invalid_params`).

### HTTP routes

Every body is the usual envelope (`{data}` or `{error: {code?, message}}`);
the shapes are the types in `packages/api-connector-core/src/contract.ts`
(`@liaison/api-connector-core/contract`), which the routes and the web client
both use.

| Route | Scope | What |
|---|---|---|
| `GET /api/api-connector/adapters` | `api-connector:read` | `{connections, readOnly, readOnlyReason?}`. Each connection: identifier, name, adapter id and version, baseUrl, auth shape (type; `in`/`name` for apiKey, never a secret), roles, operations (name, kind, role, description, params, fields), status (`ok`, `needs_credentials`, `error`). `readOnly` is true in a demo org (`readOnlyReason: "demo"`): the settings page renders no add, replace, delete or credentials control from it |
| `PUT /api/api-connector/adapters/:identifier` | `api-connector:admin` | Store an adapter (JSON, or YAML text); 200 with the connection summary and `credentialsCleared` (true, and `status: needs_credentials`, when the credential target changed and the credentials were deleted). A change of the credential target while credentials are stored answers 409 `confirm_credential_wipe` with `priorTarget` and `newTarget` unless the request carries `?confirmCredentialWipe=true`; credentials entered or removed after that check refuse the save with 409, 422 `invalid_adapter` with `issues: [{path, message}]`, 400 for a bad slug, 403 in a demo org |
| `GET /api/api-connector/adapters/:identifier/versions` | `api-connector:admin` | `{identifier, current, versions}`: the kept previous adapters, newest first (id, adapterVersion, name, savedBy, savedByName, savedAt, target, `targetDiffers`) |
| `POST /api/api-connector/adapters/:identifier/restore` | `api-connector:admin` | `{versionId, confirmCredentialWipe?}`: restore a kept adapter (the current one is kept in turn); 200 with the connection summary and `credentialsCleared`, 409 `confirm_credential_wipe` with `priorTarget` and `newTarget` when stored credentials would be deleted without the confirmation, 404 for an unknown version, 403 in a demo org |
| `DELETE /api/api-connector/adapters/:identifier` | `api-connector:admin` | Remove the adapter and its credentials; 404 when there is neither, 403 in a demo org |
| `POST /api/api-connector/adapters/:identifier/test` | `api-connector:admin` | `{operation, params}`, one page of a read operation. The call ran: 200 `{ok: true, status, items, truncated, ms}`, or 200 `{ok: false, status, code, message, ms}` when the API failed (`upstream_status`, `timeout`, `too_large`, `invalid_response`, `host_refused`, `not_configured`, `demo_restricted`). Refused before any request: 422 `write_not_testable`, 404 `unknown_connection` / `unknown_operation`, 400 `invalid_params` |
| `GET /api/api-connector/customer?email=&phone=&domain=` | `api-connector:read` | The resolver behind the customer card (one of the three required): `{matches: [{connection, connectionName, matchedBy, summary, currency?, orders?, invoices?, deals?}], configured, connections, errors}`. `summary` maps dotted field paths to typed values (number, string, boolean; a list of scalars joined); `currency` is the record's own `currency` / `currency_code` field, which the card formats amounts in |
| `POST /api/connections/api-connector/api/credentials` | `api-connector:accounts:admin` | Credentials, always org-owned: `identifier` = the slug (top level or inside `credentials`) plus exactly the adapter's auth fields. 404 when no adapter is stored for the slug, 400 for a missing or extra field or a bad slug, 403 in a demo org |

In the web app: Settings → API connector (list, add by pasting or uploading
the adapter with each issue shown at its path, a credentials form derived from
the adapter's auth, a Test panel offering read operations only, a History
panel that restores an earlier adapter and warns first when that deletes the
credentials, delete with an inline confirmation).

### Environment

| Variable | Effect |
|---|---|
| `LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS` | `true` lets this connector reach private and loopback addresses (an on-premise ERP, or the fixture in development). Cloud metadata and always-blocked addresses stay refused. Off by default. |

### Error codes

The HTTP status is what a route answers the code with.

| Code | HTTP | Meaning | Usual fix |
|---|---|---|---|
| `invalid_adapter` | 422 | The adapter failed validation | Fix each `path: message`; rerun `validate` |
| `unknown_connection` | 404 | No adapter stored under that identifier | Store the adapter (`config apply` or Settings) |
| `unknown_operation` | 404 | The adapter has no operation of that name | Call `connector_list_operations`; check the name |
| `not_configured` | 422 | The connection has no credentials yet, or they lack a field the auth type needs | Store the credentials |
| `invalid_params` | 400 | A param is unknown, missing, mistyped, out of range or not in its declared `format` for the operation's schema, or a role answering "at least one of" (`customer.lookup`, `stock.check`) got none of them | Match the operation's `params` |
| `host_refused` | 422 | The host resolves to a private or blocked address, a redirect, the token URL or a rendered request URL left the host or the base URL, or plain http without the private-hosts flag | Use the public https host; for an on-premise or local API set the private-hosts flag |
| `upstream_status` | 502 | The API answered non-2xx (status included; the body never, except in the agent's `connector_adapter_test`, which shows a clipped, redacted excerpt as `vendorError`), or could not be reached | 401/403: credentials or the auth `name`; 404: path or id; 400: params, or a search `POST` with no body |
| `timeout` | 504 | No complete answer in 15 s, or the call's 45 s budget ran out | Narrow the request (filters, smaller page) |
| `too_large` | 502 | The response passed 2 MB, or a customer lookup needed more than its 20 upstream requests | Filter server-side, page smaller; keep chains short |
| `invalid_response` | 502 | The API did not answer JSON, or the token endpoint returned no `access_token` | Look at a raw response |
| `demo_restricted` | 403 | A demo org tried to reach anything but its seeded fixture connection | None: demo orgs keep to the fixture |
| `write_not_testable` | 422 | `/test` or CLI `test` was asked to run a write | Writes run only through the agent, with approval |
| `write_not_allowed` | 422 | `connector_read` was given a write operation, or `connector_write` a read; or an approved write's adapter or rendered target changed since it was approved (nothing was sent) | Use the tool matching the operation's kind; for a changed write, ask for approval again |

---

## 7. Related docs

- [`.claude/skills/api-connector-authoring/SKILL.md`](../.claude/skills/api-connector-authoring/SKILL.md): write an adapter step by step.
- [Provisioning CLI](provisioning-cli.md): `liaison config apply` and the other sections.
- [The `database` connector](database-connector.md): the read-only SQL counterpart.
