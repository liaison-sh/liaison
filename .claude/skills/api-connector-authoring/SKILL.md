---
name: api-connector-authoring
description: Walk a developer through connecting Liaison to their own CRM, ERP or other HTTP API with the `api-connector` app - read its OpenAPI document or docs, pick the operations, map the customer roles, write the adapter (YAML/JSON), validate it, live-test each read, load it with `liaison config apply`, and smoke-test it through the agent. Use when the user wants Liaison's agents or the customer card to read from (or write to) an external API, or wants to write, fix or extend an API connector adapter.
---

# API connector authoring

You are pairing with a developer to connect Liaison to an HTTP API they own
or use (a CRM, an ERP, an order system) by writing an **adapter**: one YAML
or JSON document that lists the operations the agent may call. No app code,
no Liaison source to read: everything you need is here and in
`docs/api-connector.md`.

Drive the conversation one step at a time. Each step ends in a concrete,
checkable artifact or command; don't skip the validation loop. A first
adapter with `customer.lookup` and `customer.orders` working takes well under
an hour.

## Before you start

Open `docs/api-connector.md` once: it holds the architecture, the safety
stack, the full format reference (a field table generated from the JSON
Schema) and the error codes. If this skill and that doc disagree, the doc
wins.

Worked example, used throughout: the fixture CRM in
`apps/api/src/apps/api-connector/__fixtures__/fixture-crm/`, its
`openapi.json` (the input) and `fixture-crm.adapter.yaml` (the result, written
by following this skill). Read the adapter when you want to see what "done"
looks like.

Ask up front:

- *"Which API, and do you have its OpenAPI (Swagger) document, as a URL or a
  file? If not, a link to its API docs."*
- *"How does it authenticate (API key, bearer token, user/password, OAuth2
  client credentials)? Do you have a test key?"* Never ask them to paste the
  secret into the chat: it goes into an environment variable (Step 7).
- *"What should the agent be able to answer?"* (e.g. "what did this customer
  order last month", "is this invoice paid", "do we have X in stock").
- *"Where does Liaison run?"* A deployed instance reaches only public https
  hosts unless the operator sets `LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true`
  (for an on-premise ERP on a private network).

**Where the loopback/private flag goes.** `LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true`
is read by the process that makes the call. `liaison api-connector test` and
`liaison config verify` run the connector inside the CLI process, so the flag
must be in the CLI's environment; the agent tools and the customer card run in
the API server, so it must be in the server's environment too. Setting it on
one does not reach the other.

To practise or demo the loop end to end, start the fixture CRM (it serves
`http://127.0.0.1:4010/v1`; `FIXTURE_CRM_API_KEY` sets its key, otherwise it
answers to `fixture-crm-dev-key`):

```sh
FIXTURE_CRM_API_KEY=dev-key bun run apps/api/src/apps/api-connector/__fixtures__/fixture-crm/server.ts
```

and run Steps 6 to 8 from a checkout against a **private** database (see
"From a checkout" in Step 7), never the shared `liaison_dev` that `bun run dev`
and other sessions use. A dev server is only needed for Step 9 and the
customer card; start it on the same private database with the flag:
`DATABASE_URL=... LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true bun run dev`.

## Step 1: Read the API description

**From an OpenAPI document** (fetch the URL or open the file), note:

- `servers[].url`: the `baseUrl` candidate. It must be https (http only for
  a loopback development host such as the fixture's `http://127.0.0.1:4010/v1`),
  written in its normalized form: lower-case host, no default port, no
  trailing `?`/`#`, an IPv4 host only as a dotted quad. Changing the API's
  host, port or auth later deletes the stored credentials (they are entered
  again).
- `components.securitySchemes`: the auth type (Step 2).
- For each candidate endpoint under `paths`: method, path, path and query
  parameters, and the 2xx response schema (where the item list sits, which
  fields exist, which are nested objects or arrays).

**From docs only:** find the base URL, the auth section and the endpoints
you need. Ask the developer to run one request per endpoint with their own
key (`curl -H 'X-Api-Key: ...' https://.../customers?email=...`) and paste
the response **with secrets removed**; that sample replaces the response
schema.

Output of this step: a short list of endpoints with their method, path,
params and the response field paths you might expose.

## Step 2: Auth

Map the API's scheme to `auth`:

| The API uses | `auth` | Credential fields stored |
|---|---|---|
| A key in a header (`X-Api-Key: ...`) | `{type: apiKey, in: header, name: X-Api-Key}` | `apiKey` |
| A key in the query (`?api_key=...`) | `{type: apiKey, in: query, name: api_key}` | `apiKey` |
| `Authorization: Bearer <token>` (a static token) | `{type: bearer}` | `token` |
| HTTP Basic | `{type: basic}` | `username`, `password` |
| OAuth2 client credentials | `{type: oauth2ClientCredentials, tokenUrl: https://..., scope?: ...}` | `clientId`, `clientSecret` |

- `tokenUrl` lives in the adapter, never in the credentials. It must be
  https and on the `baseUrl` host; if the identity provider has its own host,
  declare it as `tokenHost`.
- Some header names are reserved and refused (`Host`, `Cookie`,
  `Content-Type`, `Proxy-Authorization`, ...).
- OAuth2 authorization-code flows (a person clicks "Allow") are not supported
  by this connector; see "When the format doesn't fit".

## Step 3: Choose the operations

Keep the list small and purposeful: each operation answers one recognisable
question. Ten is plenty. For each:

- `name`: snake_case, what it does (`list_orders`, `check_stock`).
- `kind`: `read` for anything that changes nothing (a `GET`, or a search
  `POST` marked `readOnlyPost: true`); `write` for anything else. Every write
  waits for a person's approval before it runs, but still ship as few as
  possible: one or two useful ones (add a note, create a task), never deletes
  unless the developer insists.
- `description`: written for the agent. Say when to use it and what each
  param means and looks like (`since = YYYY-MM-DD`). The agent picks
  operations from these descriptions alone.

The fixture adapter: six role operations, `list_companies` (paginated),
`list_contacts`, `list_recent_orders` (no id needed: it answers "our latest
customer"), and three writes: `create_note`, `create_company` and
`create_contact` (which can create the company in the same call, so a new
customer is one approval). Give the agent at least one read
that needs no id: a question about "the latest" or "the biggest" customer
otherwise has nothing to start from.

## Step 4: Map the roles

Roles let Liaison use the connection without knowing your operation names:
the customer card beside tickets and mail, and the customer summary the agent
gets as context there. The resolver calls `customer.lookup` with the
participant's email (then a phone when one is given, then the company domain,
never a free-mail or the org's own domain), takes each match's `id`, and
calls the other roles with it as `customerId`. The card labels a domain
match "Matched by company domain"; the agent's context uses email matches
only.

| Role | Fill it with | Params the operation must declare | Fields it must allow-list |
|---|---|---|---|
| `customer.lookup` | Search customers (companies or people) | at least one of `email`, `phone`, `domain` | `id`, `name` |
| `customer.summary` | One customer record | `customerId` | (your choice) |
| `customer.orders` | A customer's orders | `customerId` | `id` |
| `customer.invoices` | A customer's invoices | `customerId` | `id` |
| `deal.list` | A customer's deals / opportunities | `customerId` | `id` |
| `stock.check` | Stock levels | at least one of `sku`, `query` | (your choice) |

- Each role is filled by one `read` operation at most. Fill only the roles
  the API can answer; `customer.lookup` is the one that turns the card on.
- The `id` that `customer.lookup` returns must be what the per-customer
  operations take as `customerId`. If the API keys orders by a different id
  than its search returns, pick the endpoints that agree, or the lookup's
  `id` field that matches.
- Lookup by email and by domain usually share one operation with both params
  optional (the fixture's `find_customers`). In a search body, give each
  optional filter `$when: <param>` so it is sent only when that param is set
  (Step 5).
- **The record nests its values** (`{id, properties: {name, domain}}`): map
  the role's fields to their paths, `fields: {id: id, name: properties.name}`.
  The card titles the customer with `name` and each deal, order or invoice
  row with its own `title`/`name`/`subject`, and shows `status`/`stage`/
  `state` beside it, so map those names too (`name: properties.dealname`,
  `stage: properties.dealstage`).
- **People and companies are separate objects** (the email is on a contact,
  the orders and deals hang off its company): make the lookup a chain. The
  lookup searches contacts by `email` and maps the contact's company id
  (`companyId: properties.associatedcompanyid`); its `chain` then reads the
  company with that id (`chain: [{operation: get_company, params:
  {customerId: "{companyId}"}}]`). The chain's last step returns the
  customer, so it carries `id` and `name`, and its `id` is the `customerId`
  the other roles take. A lookup by email is then an email match: the card
  says so, and the agent gets the customer summary. At most 2 steps after the
  lookup, each a read of the same adapter, following at most 3 distinct
  values.
- The parameter names are the role's (`customerId`, `email`, `sku`), not the
  API's: map them to the API's names in `path`/`query`
  (`query: {q: "{query}"}`).

## Step 5: Write the adapter

Write `<api>.adapter.yaml` next to the deployment's config (for example
`deploy/setup/connectors/crm.adapter.yaml`). Skeleton, from the fixture:

```yaml
$schema: <path to>/packages/api-connector-core/adapter.schema.json   # editor completion
id: fixture-crm
name: Fixture CRM
version: "1.0.0"                       # bump on every change
baseUrl: http://127.0.0.1:4010/v1      # https://api.yourcrm.example/v1 for a real API
auth: { type: apiKey, in: header, name: X-Api-Key }
operations:
  - name: find_customers
    description: Find customer companies by a contact's email, phone, or the company's email domain.
    kind: read
    method: GET
    path: /companies
    role: customer.lookup
    params:
      type: object
      properties:
        email: { type: string, format: email }
        phone: { type: string, maxLength: 40 }
        domain: { type: string, maxLength: 253 }
    query: { email: "{email}", phone: "{phone}", domain: "{domain}" }
    items: /data
    fields: [id, name, domain, city, country, tier]

  - name: list_orders
    description: One customer's sales orders, newest first, with their lines. since = YYYY-MM-DD.
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
    fields: [id, number, date, status, currency, total, lines.sku, lines.description, lines.quantity, lines.unit_price]

  - name: create_note
    description: Add a note to a customer company's timeline.
    kind: write
    method: POST
    path: /companies/{customerId}/notes
    params:
      type: object
      properties:
        customerId: { type: string, maxLength: 64 }
        text: { type: string, minLength: 1, maxLength: 2000 }
        pinned: { type: boolean }
      required: [customerId, text]
    body: { note: { body: "{text}", pinned: "{pinned}" } }
    items: /note
    fields: [id, body, pinned, created_at]
```

The essentials (full reference: `docs/api-connector.md` section 3):

- `path` is relative to `baseUrl`; `{param}` placeholders name `required`
  params, each value is URL-encoded as one segment.
- `params` is a JSON Schema subset: `string` (with `enum`, `format`,
  `minLength`/`maxLength`), `number`, `integer` (`minimum`/`maximum`),
  `boolean`, `array` of those. Bound your strings (`maxLength`), use `enum`
  for status filters. The agent is refused any param you did not declare.
- `query` maps the API's query keys to templates; an unset optional param
  drops its key. `body` is a value tree: `"{pinned}"` alone keeps the param's
  type; placeholders render inside arrays too.
- An object in the body with `$when: email` (or `$when: [email, since]`) is
  sent only when every param it names is set; the `$when` key itself is never
  sent. Use it for an optional filter in a search body, which an API refuses
  with no `value`.
- `{$now}` (RFC 3339, `2026-10-26T09:30:00.000Z`) and `{$nowMs}` (epoch
  milliseconds, a number when alone in the string) are the time the request
  is built: a note's or an activity's timestamp, without a param the agent
  must fill. Body only.
- `fields` is a list of paths, or a map from the name an item carries to the
  path it is read from: `fields: {id: id, name: properties.name, email:
  emails.0.value}` (an index picks one element of a list).
- `items` is the JSON pointer to the list (`/data`) or the single object
  (`/company`) in the response.
- `pagination` when the endpoint pages: `{type: cursor, param: cursor,
  cursorPointer: /next_cursor}` or `{type: page, param: page, sizeParam:
  per_page, size: 50}`. At most 5 pages and 200 items per call.

### The field checklist (do this before writing any `fields`)

`fields` is an allow-list: everything else in the response is dropped before
the agent, the card or a log sees it. It is the most important part of the
adapter. For every field you list:

- It ends at a value (a string, number, boolean, null or a list of those).
  For nested data list the leaves: `account_manager.name`, not
  `account_manager`; for a list of objects, `lines.sku`, `lines.quantity`.
  With a field map, only the mapped names come out, whatever else the record
  holds.
- It is something a support or sales person may see about this customer.
  Never list secrets or internals: anything named like `*token*`, `*secret*`,
  `*password*`, `*hash*`, `api_key`, card or bank details (`*iban*`,
  `*card*`, `bank_reference`), internal notes, credit scores, cost prices and
  margins, staff private phone numbers. The fixture's responses contain
  exactly such fields (`internal_notes`, `credit_check.raw_score`,
  `account_manager.phone_private`, `lines.cost_price`, `margin`,
  `bank_reference`, `unit_cost`) and its adapter lists none of them.
- Prefer fewer fields: the customer summary the agent gets is capped at 2 KB.

## Step 6: Validate

```sh
# from a checkout, at the repo root: install the dependencies once (else
# validate fails with "Cannot find package ..."); validate is then offline:
# no env, database or secrets needed
bun install --frozen-lockfile
bun run --cwd apps/api liaison api-connector validate "$PWD/deploy/setup/connectors/crm.adapter.yaml"
# in the app container
docker compose exec -T app liaison api-connector validate /setup/connectors/crm.adapter.yaml
```

A relative path resolves from the CLI's working directory, and
`--cwd apps/api` makes that `apps/api`, not the repo root: pass an absolute
path (`"$PWD/..."` from the root, as above), or a path relative to `apps/api`
(`../../deploy/setup/connectors/crm.adapter.yaml`).

It prints one JSON report. While issues remain it exits 1 with
`{"ok":false,"issues":[{"path":"operations.3.path","message":"..."}]}`, each
issue at the path of the offending value; clean, it exits 0 with
`{"ok":true,"adapter":{...}}` (id, version, auth type, roles, operations).
Fix each issue and rerun until it is clean. Don't hand-wave "looks right":
the validator also checks the role requirements (Step 4) and the field rules
(Step 5). Exit 2 means the command itself failed (usage, an unreadable file),
not the adapter.

## Step 7: Load it and connect the credentials

Put the secrets in the environment (the setup playbook's gitignored
`deploy/.setup-secrets.env`, or your secret store), never in the config file
or on the command line. Then add the connector to the deployment's
`liaison config apply` file:

```yaml
apps:
  - name: api-connector
    enable: true

apiConnectors:
  - identifier: crm                          # the connection slug: lowercase, digits, -
    adapter: connectors/crm.adapter.yaml     # relative to this config file, inside its directory (or inline)
    credentials:
      apiKey: "${CRM_API_KEY}"               # the fields of your auth type (Step 2)
```

```sh
docker compose exec -T -e CRM_API_KEY app liaison config apply --config /setup/liaison-config.yaml --dry-run
docker compose exec -T -e CRM_API_KEY app liaison config apply --config /setup/liaison-config.yaml
```

Read the dry-run plan first (per connection: adapter write/unchanged,
credentials write/unchanged/pending); a second apply of the same file changes
nothing. Credentials whose values are all empty are reported pending, not
written. An org can hold several connectors (a CRM and an ERP): one entry
each, with its own `identifier` and credentials. `liaison config verify`
then probes each connection with one page of a read operation that needs no
params, preferring one that is not `customer.lookup`: called with no filter, a
lookup can return (or page through) every customer, which a real CRM may
refuse or take long to answer. Give the adapter a cheap param-less list
(`list_companies` in the fixture) so verify probes that.

### From a checkout

Steps 7 and 8 run the API internals in the CLI process, so they need what the
server needs. From the repo root, with the fixture CRM running:

```sh
# a private database, created and migrated (never the shared liaison_dev)
DATABASE_URL=postgres://localhost:5432/liaison_test_crm LIAISON_RESET_EXPECT_DB=liaison_test_crm \
  bun run scripts/db-reset.ts test

export DATABASE_URL=postgres://localhost:5432/liaison_test_crm
export REDIS_URL=redis://localhost:6379
export JWT_SECRET=$(openssl rand -hex 32) ENCRYPTION_KEY=$(openssl rand -hex 32)
export LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true   # the CLI calls a loopback host
export CRM_API_KEY=dev-key                                # the fixture's key
liaison() { bun run --cwd apps/api liaison "$@"; }
liaison config apply --config "$PWD/deploy/setup/liaison-config.yaml" --dry-run
```

Keep `ENCRYPTION_KEY` for the life of that database (the stored credentials
are encrypted with it). A fresh database has no org: give the config file an
`org` and an `admin` block and `config apply` creates both, as the browser's
first Register would (`docs/provisioning-cli.md`, "Headless first boot"):

```yaml
org: { slug: crm-practice, name: "CRM practice" }
admin: { email: owner@crm-practice.example, name: "Owner" }
```

Then the same `liaison config apply`, `liaison config verify --config ...`
and Step 8's `liaison api-connector test ...` commands, without the
`docker compose exec -T app` prefix. Drop the database when you are done.

Without a config file, an admin does the same in Settings → API connector:
add a connection (slug + the adapter, pasted or uploaded), then fill the
credentials form, which asks for exactly the fields the adapter's auth needs
(the adapter must be stored first).

## Step 8: Live-test every read operation

```sh
docker compose exec -T app liaison api-connector test crm find_customers --param email=jane.doe@acme-instruments.example
docker compose exec -T app liaison api-connector test crm list_orders --param customerId=cmp_001 --param since=2026-05-01
```

From a checkout, run the same commands with the environment of "From a
checkout" above (the loopback flag included). Add `--org <slug>` when the
instance holds more than one org. `--param` takes
`name=value`, typed by the operation's schema (numbers and integers as
numbers, booleans as `true`/`false`, an array as a comma-separated list); a
name the operation does not declare is refused (`invalid_params`). The report
is JSON: `{"ok":true,"status","items","truncated","pages","ms"}` (exit 0), or
`{"ok":false,"code","message","status"?}` (exit 1). Or use the Test panel of
the connection in Settings. For each read operation, with realistic params,
confirm:

- `ok` and a 2xx status; items come back and match what the API's own UI
  shows for the same customer.
- Only your `fields` are present, at the nesting you expect. A field you
  listed but don't see means the path is wrong (compare with a raw response).
- A param with no match returns no items, not an error; a wrong id returns
  `{"ok":false,"code":"upstream_status","status":404}` with no body echoed.
- Paginated operations return more than one page when the data allows it:
  run them with `--pages 2` (or `--all-pages`, up to the operation's
  `maxPages`) and check `pages` and the item count.
- A chained lookup returns the last step's records (the customer), not the
  first step's.

`test` runs read operations only; a write is refused (`write_not_testable`)
without sending anything. To check a write's request before anyone approves
it, add `--dry-run`: nothing is sent and no credential is read, and the report
is the rendered request, `{"ok":true,"dryRun":true,"kind","request":{method,
url, headers, body}}`, with the auth value shown as `REDACTED`:

```sh
docker compose exec -T app liaison api-connector test crm create_note --dry-run --param customerId=cmp_001 --param text="Called about the order"
```

Writes themselves run through the agent, behind an approval (Step 9).

## Step 9: Smoke-test through the agent

```sh
docker compose exec -T app liaison agent ask --as <member email> "What did Acme Instruments order last month?"
```

Expect the agent to find the connector tools (`tool_search`), list the
operations, look the customer up, read the orders, and answer from them: three
connector calls (`connector_list_operations`, then two `connector_read`).
Then:

- Open a ticket or mail from a known customer contact: the customer card
  shows the match; from an unknown sender it shows "no match".
- Ask for a write ("add a note to Acme's timeline saying we called"): an
  approval appears naming the connection, the operation, the request
  (`POST host/path`) and the params; nothing reaches the API until it is
  approved, and nothing at all if the adapter changed meanwhile.
- A member without the app's read scope sees no card, and their agent gets no
  customer context.

If the agent picks the wrong operation or misreads a param, improve that
operation's `description`, bump `version`, validate and apply again.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `host_refused` | The host resolves to a private, loopback or blocked address, or a redirect left the `baseUrl` host | Use the API's public https host and its final URL (no redirect to another host). For an on-premise API or the local fixture, set `LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true` on the process making the call: the CLI's for `test` / `config verify`, the API server's for the agent and the card; metadata addresses stay refused |
| `Invalid environment configuration`, exit 2 | `test`, `config apply` or `config verify` from a checkout without the server's environment | Export the variables of "From a checkout" (Step 7); `validate` needs none |
| `baseUrl must be https` at validate | An http URL on a non-loopback host | Use https; http is accepted only for `localhost` / `127.x` / `[::1]` in development |
| `upstream_status` 401 / 403 | Wrong key, wrong auth type, or wrong header/query `name` | Check `auth` against the API's security scheme; re-store the credentials |
| `upstream_status` 400 / 404 | A param mapped to the wrong query key, a wrong path, or an id from another system | Compare the operation with the API docs; check the lookup's `id` is what the per-customer endpoints take |
| `too_large` | The response passed 2 MB | Add server-side filters (`since`, `status`), a smaller page size, or pagination |
| `timeout` | No complete answer in 15 s | Same as above; check the API's status |
| `invalid_response` | The API did not answer JSON (or an oauth2 token endpoint returned no `access_token`) | Look at a raw response |
| No items where you expected some | The `items` pointer finds nothing (that gives zero items, not an error), or the filter matched nothing | Compare `items` with a raw response |
| An item comes back empty, or a field is missing | The `fields` path does not match the response, or it points at an object or a list of objects (dropped) | List the leaf paths (`owner.name`, `lines.sku`) |
| A field you did not list appears | It cannot: projection keeps only `fields`. Check you are reading the connector's output, not a raw API call | |
| `unknown_connection` / `unknown_operation` | No adapter stored under that identifier, or no operation of that name | Rerun `config apply`; check the names with `validate` |
| `not_configured` | No credentials stored for that identifier yet, or they lack a field the auth type needs | Rerun `config apply` with the credentials, or add them in Settings |
| `invalid_params` | A param not declared by the operation, missing, mistyped or out of range | Match the operation's `params` |
| `demo_restricted` | A demo org: only its seeded fixture connection answers | Nothing to fix; use a real instance |
| `invalid_adapter` on apply or upload | The same issues `validate` reports | Run Step 6 |

## When the format doesn't fit

If the API needs something the adapter can't express (an OAuth2 flow with a
person's consent, request signing, XML or SOAP, a GraphQL endpoint, file
uploads), don't work around the safety stack (no proxy, no second host, no
secrets in the adapter). Record the gap in `docs/sdk-gaps.md` and stop; a
search-style GraphQL or JSON-RPC query can sometimes be expressed as a
`readOnlyPost` read with a fixed body.

## Reference

- `docs/api-connector.md`: architecture, safety stack, format reference,
  roles, config, CLI, routes, error codes.
- `packages/api-connector-core/adapter.schema.json`: the JSON Schema (for
  editors; `validateAdapter` is the authority).
- `apps/api/src/apps/api-connector/__fixtures__/fixture-crm/`: the fixture
  CRM (`openapi.json`) and the adapter built from it with this skill
  (`fixture-crm.adapter.yaml`).
- `docs/provisioning-cli.md`: `liaison config apply` and its other sections.
- `docs/sales/connect-your-crm.md`: the user-facing page for a connected CRM or ERP.
  A change to the connector's roles, tools or customer card updates it and
  `docs/api-connector.md` (`.claude/docs-map.ts`, `bun run check:docs`).
