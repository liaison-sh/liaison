# agreements

Proposals, statements of work, contracts and any PDF a person uploads, kept as
drafts, frozen into versions and signed with a simple electronic signature.

## Who can see an agreement

Each agreement has `org_access` (`none`, `viewer`, `editor`) and a list of
named people. With `none`, only the people on the list read it, at the data
layer: every table of the app (`agreements`, drafts, versions, signature
events, evidence packages, the list itself) declares `sharedRows`, so no scope
or grant, `*` included, reads a closed agreement. The list is never empty; its
creator starts on it as an editor; a viewer cannot change it; an agent's change
waits for a person (`src/access.ts`, the one writer).

## Tools

| Tool | What it does |
|---|---|
| `agreements_search` | Agreements in the order of what needs someone first. |
| `agreement_get` | One agreement with its versions and its list. |
| `agreement_create` | A draft, from a template, a brief or an uploaded PDF. Never a price. |
| `agreement_update` | Changes a draft (optimistic `lock_version`). |
| `agreement_prepare` | The checks before a send: blanks, price, fit, agent clauses. |
| `templates_list`, `template_get`, `template_save` | Templates with versions. |

The price is set by a person only (`agreement_price_set`, hidden from agents).
Rows are never deleted: the app's source holds no delete (a guard test).
