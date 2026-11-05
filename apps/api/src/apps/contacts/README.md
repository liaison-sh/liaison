# contacts — contact registry

The kernel-owned people-and-companies directory. Resolve who someone is, or look
up a customer/dealer before acting. Resolution is idempotent — the same email
always maps to the same contact, so resolve rather than create duplicates. An
unknown contact returns empty (not an error).

## Tools / surface

Contacts is a kernel-registered UI surface (contact list + detail tabs) with a
JSON/CSV export handler (`exportContacts`). Contact reads/writes used by agents
(`contacts_search`, `contacts_read`, `contacts_write`, `resolveContact`) are
kernel primitives available to every app.

## Connecting

**No connection required** — contacts owns local, kernel-managed data and reaches
no external system. There is no `connections` block in its manifest. For the
shared connection machinery other apps use, see
[`docs/connecting-apps.md`](../../../../../docs/connecting-apps.md).
