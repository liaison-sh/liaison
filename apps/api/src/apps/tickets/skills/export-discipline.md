---
name: export-discipline
type: skill
description: How to export ticket data safely without leaking or overscoping.
requiredScopes: tickets:tickets:read
---

Exporting ticket data on request:

1. Confirm exactly what the user needs (which tickets, which fields, what date range) before exporting — a broad export is a privacy risk.
2. Export only within the user's dimension and scope; rows outside it are silently excluded, so state the filter you applied so the user knows the export's boundary.
3. Never include internal-only fields (assignee notes, raw contact PII) unless the user explicitly needs them and holds the scope.
4. For a large export, summarize the row count and columns first and let the user confirm before producing the file.
5. The export reflects only what you can read — if it comes back empty, say the filter matched nothing rather than implying there is no data at all.
