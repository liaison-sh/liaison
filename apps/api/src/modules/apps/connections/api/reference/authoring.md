# Writing an API connector adapter

The agent's reference for connecting a CRM, ERP or any HTTP API through the API
connector. `connector_adapter_reference` returns one section at a time (pass
`section`, the id in brackets); call it again for another section whenever you
need it.

## Overview [overview]

An adapter is one JSON document: the API's `baseUrl`, its `auth` type and a short
list of named `operations` (method, path, params, where the items are, which fields
to keep). Liaison sends every request itself, pinned to the `baseUrl` host, and
keeps only the fields the adapter allow-lists. You never write code and never see a
credential.

The flow, with your tools:

1. **Read the vendor's API docs.** Use `web_search` to find the official reference
   pages (authentication, the list or search endpoints you need), then `web_fetch`
   each page you found with `mode: "extract"`. If the user gave you a URL, fetch it.
2. **Read this reference**: `auth`, `operations`, `roles`, `format` and
   `fields-checklist` before you write; `field-table` when you need a field's exact
   constraints. `woocommerce` is a complete worked example (a shop's orders,
   products and best sellers).
3. **Draft the document** and save it with `connector_adapter_save` under a short
   slug (`crm`, `erp`). The save validates first: invalid documents are refused with
   each issue at its path, before anyone is asked to approve. Fix every issue and
   save again. A save is approved by an API connector admin.
4. **Ask for the credentials** with `request_secret` (the API connector credentials
   of that slug): the user types them into a secure card, never into the chat. Never
   ask for a key, token or password in a message.
5. **Test** each read operation with `connector_adapter_test` (one page, the stored
   credentials, the allow-listed fields only). Fix and save again until each answers.
6. **Report** what the connection can now answer, and which operations failed and why.

`connector_adapter_get` returns the stored document (large documents a page of
operations at a time, `operationsPage`); `connector_adapter_versions` lists the kept
previous documents and `connector_adapter_restore` puts one back.

Credentials belong to a target: the API's origin (scheme, host, port), the auth type
and where the secret goes (the apiKey header or query name, the oauth2 token URL).
A save or a restore that changes the target deletes the stored credentials. When
credentials are stored, such a save is refused until you pass
`confirmCredentialWipe: true`, after telling the user they will enter the
credentials again. A save that drops operations of the stored document is refused
unless `allowRemovingOperations` lists their names.

## Read the API description [read-the-api]

**From an OpenAPI document** (fetch the URL), note:

- `servers[].url`: the `baseUrl` candidate. It must be https, written in its
  normalized form: lower-case host, no default port, no trailing `?`/`#`, an IPv4
  host only as a dotted quad.
- `components.securitySchemes`: the auth type (section `auth`).
- For each candidate endpoint under `paths`: method, path, path and query
  parameters, and the 2xx response schema (where the item list sits, which fields
  exist, which are nested objects or arrays).

**From docs pages only:** find the base URL, the authentication page and the
endpoints you need. The response examples in the docs replace the response schema.
When they are missing, save a first adapter with a broad but safe field list, run
`connector_adapter_test`, and narrow the fields from what comes back.

Output of this step: a short list of endpoints with their method, path, params and
the response field paths you might expose.

## Auth and credentials [auth]

Map the API's scheme to `auth`:

| The API uses | `auth` | Credential fields stored |
|---|---|---|
| A key in a header (`X-Api-Key: ...`) | `{"type": "apiKey", "in": "header", "name": "X-Api-Key"}` | `apiKey` |
| A key in the query (`?api_key=...`) | `{"type": "apiKey", "in": "query", "name": "api_key"}` | `apiKey` |
| `Authorization: Bearer <token>` (a static token) | `{"type": "bearer"}` | `token` |
| HTTP Basic | `{"type": "basic"}` | `username`, `password` |
| OAuth2 client credentials | `{"type": "oauth2ClientCredentials", "tokenUrl": "https://...", "scope": "..."}` | `clientId`, `clientSecret` |

- `tokenUrl` lives in the adapter, never in the credentials. It must be https and on
  the `baseUrl` host; if the identity provider has its own host, declare it as
  `tokenHost`.
- Some header names are reserved and refused (`Host`, `Cookie`, `Content-Type`,
  `Proxy-Authorization`, ...).
- OAuth2 authorization-code flows (a person clicks "Allow") are not supported: see
  section `does-not-fit`.

How each auth type is sent:

| `auth.type` | Credential fields (all required) | Sent as |
|---|---|---|
| `apiKey` | `apiKey` | header or query parameter `auth.name` |
| `bearer` | `token` | `Authorization: Bearer <token>` |
| `basic` | `username`, `password` | `Authorization: Basic ...` |
| `oauth2ClientCredentials` | `clientId`, `clientSecret` | a client-credentials token from `auth.tokenUrl`, sent as a bearer token |

### HubSpot

HubSpot's REST API takes a service key (or a private app token) as a bearer token:
`auth: {"type": "bearer"}`, `baseUrl: "https://api.hubapi.com"`. The key needs the
read scopes of the objects the adapter reads, for example
`crm.objects.contacts.read` and `crm.objects.companies.read`. Contacts are listed by
`GET /crm/v3/objects/contacts` (items at `/results`, each with `id` and
`properties.*`; the `limit` query param sets the page size, the next page's cursor
is at `/paging/next/after` and is sent as the `after` query param). Finding a
contact by email is a search `POST` that needs a JSON body: see `search-body`.

## Choose the operations [operations]

Keep the list small and purposeful: each operation answers one recognisable
question. Ten is plenty. For each:

- `name`: snake_case, what it does (`list_orders`, `check_stock`).
- `kind`: `read` for anything that changes nothing (a `GET`, or a search `POST`
  marked `readOnlyPost: true`); `write` for anything else. Every write waits for a
  person's approval before it runs, but still ship as few as possible: one or two
  useful ones (add a note, create a task), never deletes unless the user insists.
  List `id` in a write's `fields` when the API answers with the record it created
  or updated: the write result then carries it as `record_id`, so a later step of
  the same approval (a quote for the new contact) can use it.
- `description`: written for the agent. Say when to use it and what each param means
  and looks like (`since = YYYY-MM-DD`). The agent picks operations from these
  descriptions alone.

Give the agent at least one read that needs no id: a question about "the latest" or
"the biggest" customer otherwise has nothing to start from.

## Search endpoints that take a JSON body [search-body]

Many APIs search with a `POST` whose JSON body carries the filters (HubSpot's
`/crm/v3/objects/{object}/search` is one). Such an endpoint answers 400 when the
body is missing or empty, so the operation needs a `body` template: a read `POST`
with `readOnlyPost: true` and the body the API's docs show, with `{param}`
placeholders where the agent's values go. A read `POST` that maps a param into
neither `query` nor `body` is refused at save, and one that sends no body at all is
saved with a warning.

```json
{
  "name": "search_contacts",
  "description": "Find contacts by email address. email = the full address.",
  "kind": "read",
  "method": "POST",
  "readOnlyPost": true,
  "path": "/crm/v3/objects/contacts/search",
  "params": {
    "type": "object",
    "properties": { "email": { "type": "string", "format": "email" } },
    "required": ["email"]
  },
  "body": {
    "filterGroups": [
      { "filters": [{ "propertyName": "email", "operator": "EQ", "value": "{email}" }] }
    ],
    "properties": ["email", "firstname", "lastname", "company"],
    "limit": 20
  },
  "items": "/results",
  "fields": { "id": "id", "email": "properties.email", "name": "properties.firstname" }
}
```

- Copy the body's shape from the docs' request example, then replace the values the
  agent chooses with placeholders. Literals (`"limit": 20`, the property list) pass
  through as written.
- An optional filter goes in an object with `"$when": "<param>"`, so it is dropped
  when the param is unset. Keep at least one filter that is not behind `$when` (or
  make a param `required`): otherwise a call without params searches everything.
- If `connector_adapter_test` answers `upstream_status` 400, read its `vendorError`:
  the API's own message usually names the missing or wrong body field.

## Map the roles [roles]

Roles let Liaison use the connection without knowing your operation names: the
customer card beside tickets and mail, and the customer summary the agent gets as
context there. The resolver calls `customer.lookup` with the participant's email
(then a phone when one is given, then the company domain, never a free-mail or the
org's own domain), takes each match's `id`, and calls the other roles with it as
`customerId`.

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

- Each role is filled by one `read` operation at most. Fill only the roles the API
  can answer; `customer.lookup` is the one that turns the card on.
- The `id` that `customer.lookup` returns must be what the per-customer operations
  take as `customerId`. If the API keys orders by a different id than its search
  returns, pick the endpoints that agree.
- Lookup by email and by domain usually share one operation with both params
  optional. In a search body, give each optional filter `"$when": "email"` so it is
  sent only when that param is set.
- A record that nests its values (`{"id": "1", "properties": {"name": "Acme"}}`):
  map the fields, `"fields": {"id": "id", "name": "properties.name"}`. The card
  titles a customer with `name` and a deal, order or invoice row with `title`,
  `name` or `subject`, and shows `status`, `stage` or `state` beside it.
- People and companies as separate records (the email is on a contact, the deals
  hang off its company): chain the lookup. It searches contacts by `email`, maps
  the contact's company id (`"companyId": "properties.associatedcompanyid"`), and
  `"chain": [{"operation": "get_company", "params": {"customerId": "{companyId}"}}]`
  reads the company. The last step returns the customer (`id`, `name`); a match is
  then an email match. At most 2 steps, each a read of this adapter.
- The parameter names are the role's (`customerId`, `email`, `sku`), not the API's:
  map them to the API's names in `path` / `query` (`"query": {"q": "{query}"}`).

## Write the adapter [format]

A skeleton:

```json
{
  "id": "example-crm",
  "name": "Example CRM",
  "version": "1.0.0",
  "baseUrl": "https://api.crm.example.com/v1",
  "auth": { "type": "apiKey", "in": "header", "name": "X-Api-Key" },
  "operations": [
    {
      "name": "find_customers",
      "description": "Find customer companies by a contact's email, phone, or the company's email domain.",
      "kind": "read",
      "method": "GET",
      "path": "/companies",
      "role": "customer.lookup",
      "params": {
        "type": "object",
        "properties": {
          "email": { "type": "string", "format": "email" },
          "phone": { "type": "string", "maxLength": 40 },
          "domain": { "type": "string", "maxLength": 253 }
        }
      },
      "query": { "email": "{email}", "phone": "{phone}", "domain": "{domain}" },
      "items": "/data",
      "fields": ["id", "name", "domain", "city", "country"]
    },
    {
      "name": "list_orders",
      "description": "One customer's sales orders, newest first. since = YYYY-MM-DD.",
      "kind": "read",
      "method": "GET",
      "path": "/companies/{customerId}/orders",
      "role": "customer.orders",
      "params": {
        "type": "object",
        "properties": {
          "customerId": { "type": "string", "maxLength": 64 },
          "since": { "type": "string", "format": "date" }
        },
        "required": ["customerId"]
      },
      "query": { "since": "{since}" },
      "items": "/data",
      "fields": ["id", "number", "date", "status", "currency", "total", "lines.sku", "lines.quantity"]
    },
    {
      "name": "create_note",
      "description": "Add a note to a customer company's timeline.",
      "kind": "write",
      "method": "POST",
      "path": "/companies/{customerId}/notes",
      "params": {
        "type": "object",
        "properties": {
          "customerId": { "type": "string", "maxLength": 64 },
          "text": { "type": "string", "minLength": 1, "maxLength": 2000 }
        },
        "required": ["customerId", "text"]
      },
      "body": { "note": { "body": "{text}" } },
      "items": "/note",
      "fields": ["id", "body", "created_at"]
    }
  ]
}
```

Bump `version` on every change.

The essentials:

- `path` is relative to `baseUrl`; `{param}` placeholders name `required` params,
  each value is URL-encoded as one segment.
- `params` is a JSON Schema subset: `string` (with `enum`, `format`,
  `minLength`/`maxLength`), `number`, `integer` (`minimum`/`maximum`), `boolean`,
  `array` of those. Bound your strings (`maxLength`), use `enum` for status filters.
  The agent is refused any param you did not declare.
- `query` maps the API's query keys to templates; an unset optional param drops its
  key. `body` is a value tree: `"{pinned}"` alone keeps the param's type.
- `items` is the JSON pointer to the list (`/data`) or the single object
  (`/company`) in the response.
- `pagination` when the endpoint pages: `{"type": "cursor", "param": "cursor",
  "cursorPointer": "/next_cursor"}` or `{"type": "page", "param": "page",
  "sizeParam": "per_page", "size": 50}`. At most 5 pages and 200 items per call.
- A document is at most 256 KB and 100 operations.

### Rules the JSON Schema cannot express

The save checks these too, each with the path of the offending value:

- **Read methods.** A `read` operation is `GET`, or `POST` with `readOnlyPost: true`
  (a search endpoint). `readOnlyPost` on anything else is refused. A `GET` carries
  no `body`. A read `POST` without a `body` is refused when a param is mapped to
  neither the path nor `query`, and warned about when it sends no body at all.
- **Placeholders.** Every `{name}` in `path`, `query` or `body` names a declared
  param. A path placeholder's param must be `required` and not an array. Stray
  braces are refused. `required` names only declared params.
- **Path shape.** Starts with `/`; no scheme, host, `//`, `.`/`..` segment, `%`, `?`
  or `#`.
- **Fields.** No wildcard, no index, no prototype key, no duplicate, and no path that
  is the prefix of another (`account_manager` together with `account_manager.name`
  is refused: list the leaves). A field map (`{"name": "properties.name"}`) follows
  the same rules for its names; its source paths may index a list (`emails.0.value`).
- **Enums** hold values of the param's own type.
- **Roles.** A role is filled by a `read` operation, at most once per adapter, and
  the operation declares the role's params and returns its fields, listed or mapped
  (for a chain, the last step's).
- **Chains** are on reads only, 1 or 2 steps; a step names another, unchained read
  of this adapter, and its params are literals or exactly `{field}` of the previous
  step's output, covering the step's required params.
- **`{$now}` / `{$nowMs}`** (the time of the request, RFC 3339 / epoch ms) and
  **`$when`** (an object sent only when the params it names are set) are body only.
- **Pagination** is for `read` operations; its `param` (and `sizeParam`) cannot also
  be a mapped `query` key.
- **baseUrl** carries no credentials, query, fragment or dot segment, and is written
  exactly as its normalized URL: no upper-case host, default port, backslash, `%2e`,
  or IPv4 host other than a dotted quad. Private and loopback hosts are refused
  unless the deployment allows them.
- **tokenUrl** (oauth2) is a URL on the `baseUrl` host or `tokenHost`, in the same
  normalized form, with no credentials or fragment.
- **Approval** (a write only, optional). Declare it on a write that posts or
  edits something a person must see in context (a forum reply, a comment, a
  note on a record): `"approval": {"link": "https://app.example.com/t/{threadId}",
  "linkLabel": "Open the thread", "context": {"read": "get_thread", "params":
  {"threadId": "{threadId}"}, "label": "Thread so far", "maxItems": 8}}`. The
  link is https, placeholders after the host naming the write's params, on the
  `baseUrl` host or a host listed in the top-level `linkHosts`. The context
  read is a read of this adapter, its params covering its required ones; at
  staging its last `maxItems` items are quoted on the approval card, above the
  full text of the draft. A failed context read never blocks the write.
- **Param formats** (`format` on a string param: `email`, `date` as `YYYY-MM-DD`,
  `date-time` as RFC 3339 with an offset, `uri`, `uuid`) are enforced on every call,
  before any request (`invalid_params`).

### Request rendering

- `query` maps a query key to a template. `"{since}"` (exactly one placeholder)
  sends the param's value, repeating the key for an array; an unset optional param
  drops the key. Other templates (`"name:{q}"`) interpolate, and are dropped when a
  placeholder is unset.
- `body` is a value tree. A string that is exactly `"{pinned}"` takes the param's
  typed value (a boolean stays a boolean); other strings interpolate as strings;
  literals pass through; unset params drop their key, at any depth (arrays too).
  An object with `"$when": "email"` is dropped when `email` is unset (an optional
  search filter); `"{$now}"` is the current time for a timestamp field.
- `items` is a JSON pointer to the item list; an object there counts as one item;
  empty means the whole response. A pointer that finds nothing gives zero items, not
  an error.
- Pagination: `cursor` sends `param=<value at cursorPointer>` until the value is
  empty or missing; `page` sends `param=1,2,...` (and `sizeParam=size`) until a page
  is shorter than `size`.

## The field checklist [fields-checklist]

`fields` is an allow-list: everything else in the response is dropped before the
agent, the card or a log sees it. It is the most important part of the adapter. For
every field you list:

- It ends at a value (a string, number, boolean, null or a list of those). For nested
  data list the leaves: `account_manager.name`, not `account_manager`; for a list of
  objects, `lines.sku`, `lines.quantity`.
- It is something a support or sales person may see about this customer. Never list
  secrets or internals: anything named like `*token*`, `*secret*`, `*password*`,
  `*hash*`, `api_key`, card or bank details (`*iban*`, `*card*`, `bank_reference`),
  internal notes, credit scores, cost prices and margins, staff private phone
  numbers.
- Prefer fewer fields: the customer summary the agent gets is capped at 2 KB.

## Field table [field-table]

Every field of the format, generated from the adapter JSON Schema. `[type=...]`
marks the fields of one variant of a union.

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
| `linkHosts` | array | no | items ≤ 10 | Hosts an operation's approval link may point to besides the baseUrl host (the product's web app when its API has a host of its own), under a registrable domain: never an IP address or a public suffix. Nothing is requested from them. |
| `linkHosts[]` | string | yes | pattern `^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`; length ≤ 253 |  |
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
| `operations[].approval` | object | no |  | A write only: what its approval card shows besides the request, so the person approving sees the record it writes to. Display only, never part of the request. |
| `operations[].approval.link` | string | no | length ≤ 2048 | An https URL template to the target record, `{param}` placeholders (after the host) naming the write's params, each value URL-encoded. Its host is the baseUrl host or one of `linkHosts`. Left off the card when a placeholder's param is unset. |
| `operations[].approval.linkLabel` | string | no | length 1..60 | The link's label on the card (default: Open the record). |
| `operations[].approval.context` | object | no |  | A read of this adapter run at staging with the stored credentials, its last items quoted on the card as the record's current content (author, date and text fields when present). A failed read never blocks the write: the card says the preview could not be loaded. |
| `operations[].approval.context.read` | string | yes | pattern `^[a-z][a-z0-9_]{0,63}$` | A read operation of this adapter. |
| `operations[].approval.context.params` | object | no | default `{}`; keys match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` | The read's params: a literal, exactly `{param}` (the write param's typed value) or a template of the write's params, covering the read's required params. |
| `operations[].approval.context.params.<key>` | string \| number \| boolean | no | string: length ≤ 2000 |  |
| `operations[].approval.context.label` | string | no | length 1..80 | The heading of the quoted items (default: Current content). |
| `operations[].approval.context.maxItems` | integer | no | value 1..20 | How many of the read's last items the card quotes (default 8). |
<!-- api-connector-schema:end -->

## Example: a WooCommerce shop [woocommerce]

A complete adapter for a WooCommerce store's REST API (v3): orders, one order,
products, and the best sellers of a period. Copy it, put the store's own host in
`baseUrl`, and test each read.

- **Base URL:** `https://<store>/wp-json/wc/v3`, the store's public https address
  (the one in WordPress's Site Address). WooCommerce accepts a consumer key over
  https only; on plain http it asks for OAuth 1.0a request signing, which the
  adapter cannot do (section `does-not-fit`).
- **Auth:** HTTP Basic with a REST API key that the store owner creates in
  WooCommerce > Settings > Advanced > REST API, permission Read: `auth:
  {"type": "basic"}`, `username` = the consumer key (`ck_...`), `password` = the
  consumer secret (`cs_...`). Ask for both with `request_secret`.
- **Lists are the whole response** (a JSON array): leave `items` out.
- **Pagination:** `orders` and `products` take `page` and `per_page` (at most 100).
  Declare them as `pagination` (`"param": "page", "sizeParam": "per_page", "size":
  100`), never as params: Liaison walks the pages itself from page 1, so one call
  returns up to 200 items (2 pages of 100). For more, narrow the window with
  `after` / `before` and call again per window.
- **Dates:** `date_created` is in the store's timezone, `date_created_gmt` in UTC,
  both without an offset. `after` / `before` take RFC 3339; the literal
  `dates_are_gmt=true` makes the store compare them in UTC.
- **Amounts** (`total`, `price`) are decimal strings in the order's `currency`.
- **Line items** are a list of objects: map their leaves. `line_item_ids` (every
  line's id) gives the line count as its length.
- **Revenue by day and order counts** come from `orders_list` over a date window
  (a dashboard groups its rows by `date_created`, by day, and sums `total`). **Top
  products** come from `reports_top_sellers`.
- **No `reports/sales` operation:** it answers one object whose per-day figures sit
  under `totals`, keyed by the date (`"2026-10-01": {"sales": ...}`). A field path
  cannot name a key that changes with the date, so those figures cannot be read as
  rows; use `orders_list` for anything per day.

```json
{
  "id": "woocommerce",
  "name": "WooCommerce",
  "version": "1.0.0",
  "baseUrl": "https://shop.example.com/wp-json/wc/v3",
  "auth": { "type": "basic" },
  "operations": [
    {
      "name": "orders_list",
      "description": "The store's orders, newest first, up to 200 per call. status = one order status (omit for all). after / before = RFC 3339 times in UTC (2026-10-01T00:00:00Z) bounding the order date; for a long period call once per shorter window.",
      "kind": "read",
      "method": "GET",
      "path": "/orders",
      "params": {
        "type": "object",
        "properties": {
          "status": {
            "type": "string",
            "enum": ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]
          },
          "after": { "type": "string", "format": "date-time" },
          "before": { "type": "string", "format": "date-time" }
        }
      },
      "query": {
        "status": "{status}",
        "after": "{after}",
        "before": "{before}",
        "dates_are_gmt": "true",
        "orderby": "date",
        "order": "desc"
      },
      "pagination": { "type": "page", "param": "page", "sizeParam": "per_page", "size": 100, "maxPages": 2 },
      "fields": {
        "id": "id",
        "number": "number",
        "status": "status",
        "date_created": "date_created",
        "date_created_gmt": "date_created_gmt",
        "total": "total",
        "currency": "currency",
        "customer_email": "billing.email",
        "line_item_ids": "line_items.id"
      }
    },
    {
      "name": "orders_get",
      "description": "One order by its id (the id from orders_list, not the order number shown to the customer), with its lines.",
      "kind": "read",
      "method": "GET",
      "path": "/orders/{id}",
      "params": {
        "type": "object",
        "properties": { "id": { "type": "integer", "minimum": 1 } },
        "required": ["id"]
      },
      "fields": {
        "id": "id",
        "number": "number",
        "status": "status",
        "date_created": "date_created",
        "total": "total",
        "currency": "currency",
        "customer_email": "billing.email",
        "customer_first_name": "billing.first_name",
        "customer_last_name": "billing.last_name",
        "line_product_ids": "line_items.product_id",
        "line_names": "line_items.name",
        "line_quantities": "line_items.quantity",
        "line_totals": "line_items.total"
      }
    },
    {
      "name": "products_list",
      "description": "The store's products, up to 200 per call. search = words in the name or description; sku = one exact SKU; status = publish, draft or private (omit for all).",
      "kind": "read",
      "method": "GET",
      "path": "/products",
      "params": {
        "type": "object",
        "properties": {
          "search": { "type": "string", "maxLength": 100 },
          "sku": { "type": "string", "maxLength": 100 },
          "status": { "type": "string", "enum": ["publish", "draft", "private"] }
        }
      },
      "query": { "search": "{search}", "sku": "{sku}", "status": "{status}" },
      "pagination": { "type": "page", "param": "page", "sizeParam": "per_page", "size": 100, "maxPages": 2 },
      "fields": ["id", "name", "sku", "status", "price", "stock_status", "stock_quantity", "total_sales"]
    },
    {
      "name": "reports_top_sellers",
      "description": "Best-selling products of a period, by quantity sold. Either period = week, month, last_month or year, or date_min and date_max = YYYY-MM-DD (both, inclusive).",
      "kind": "read",
      "method": "GET",
      "path": "/reports/top_sellers",
      "params": {
        "type": "object",
        "properties": {
          "period": { "type": "string", "enum": ["week", "month", "last_month", "year"] },
          "date_min": { "type": "string", "format": "date" },
          "date_max": { "type": "string", "format": "date" }
        }
      },
      "query": { "period": "{period}", "date_min": "{date_min}", "date_max": "{date_max}" },
      "fields": { "product_id": "product_id", "title": "title", "quantity": "quantity" }
    }
  ]
}
```

## Test and troubleshoot [troubleshooting]

`connector_adapter_test` runs one read operation with the stored credentials (one
page) and returns the allow-listed fields, or a code. A test the API refused comes
back with `result: "FAILED"`, the API's `status`, its error text in `vendorError`
(clipped, credentials redacted) and a `next` step: the connection does not work
until a test passes.

| Code | Cause | Fix |
|---|---|---|
| `host_refused` | The host resolves to a private, loopback or blocked address, or a redirect left the `baseUrl` host | Use the API's public https host and its final URL (no redirect to another host) |
| `upstream_status` 401 / 403 | Wrong key, wrong auth type, or wrong header/query `name`; or the key lacks a scope | Check `auth` against the API's docs; ask the user to check the key's scopes and enter it again |
| `upstream_status` 400 / 404 | A param mapped to the wrong query key, a wrong path, an id from another system, or a search `POST` with no body | Read `vendorError` (the API's own message); compare the operation with the API docs (a search body: section `search-body`); check the lookup's `id` is what the per-customer endpoints take |
| `too_large` | The response passed 2 MB | Add server-side filters (`since`, `status`), a smaller page size, or pagination |
| `timeout` | No complete answer in 15 s | Same as above; check the API's status page |
| `invalid_response` | The API did not answer JSON (or an oauth2 token endpoint returned no `access_token`) | Check the path and the docs' response examples |
| `not_configured` | No credentials stored for that slug yet | Ask for them with `request_secret` |
| `unknown_connection` / `unknown_operation` | No adapter saved under that slug, or no operation of that name | Check the names with `connector_adapter_get` |
| `invalid_params` | A param not declared by the operation, missing, mistyped or out of range | Match the operation's `params` |
| `write_not_testable` | The operation is a write | Writes run only through `connector_write`, with approval |
| `demo_restricted` | A demo workspace: only its seeded connection answers | Nothing to fix; use a real workspace |

- No items where you expected some: the `items` pointer finds nothing (that gives
  zero items, not an error), or the filter matched nothing. Compare `items` with the
  docs' response example.
- An item comes back empty, or a field is missing: the `fields` path does not match
  the response, or it points at an object or a list of objects (dropped). List the
  leaf paths.
- If the agent later picks the wrong operation or misreads a param, improve that
  operation's `description`, bump `version` and save again.

## When the format does not fit [does-not-fit]

If the API needs something the adapter cannot express (an OAuth2 flow with a
person's consent, request signing, XML or SOAP, a GraphQL endpoint, file uploads),
do not work around the safety stack: no proxy, no second host, no secret in the
adapter. Tell the user what is missing and stop. A search-style GraphQL or JSON-RPC
query can sometimes be expressed as a `readOnlyPost` read with a fixed body.
