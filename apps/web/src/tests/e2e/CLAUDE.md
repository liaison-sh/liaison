# E2E Test Guidelines

## Element Location

**Always use `data-testid` attributes.** Never locate elements by CSS classes, DOM structure, or fragile selectors.

```typescript
// Good
await page.getByTestId("home-feed")
await row.getByTestId("thread-item")

// Bad — CSS classes change, DOM structure is fragile
await panel.locator("button.flex.items-center")
await panel.locator("button").filter({ has: page.locator("svg") })
```

If the target element lacks a `data-testid`, **add one to the component first**, then use it in the test.

## Model Pricing Seed

Model IDs MUST match the LiteLLM database — the single source of truth is `packages/shared/src/model-pricing-seed.ts`. Import `MODEL_PRICING_SEED` from there. Never hardcode model IDs in tests.

**Never use Anthropic models for E2E tests.** Auto mode selects the cheapest auto-eligible model from the seed — currently Gemini Flash-Lite.

## Test Data Seeding

- `seedModelPricing(env)` (`helpers/agent-seed.ts`, through `/api/_test/seed`) — seeds model pricing + ECB rate, idempotent, call in every test that uses agent functionality
- `seedCredits(env, orgId, opts)` — sets the org's credit balance (credits are metered in the managed edition only), call per test (not `beforeAll`)
- Credit and model seeding must happen BEFORE the page loads if the component reads balance on mount

## Waiting for Agent Responses

- Gate on `Stop` button appearing (streaming started), then `Send` returning (streaming complete)
- Use `toContainText()` for agent response assertions — streaming-markdown renders into `.prose-agent` which may not be "visible" to Playwright
- 30s default timeout for LLM responses, 10s for streaming start

## Fixtures

- `authenticatedPage` — pre-logged-in as the QA admin (Elodie, admin@test.com), use when balance is seeded before fixture runs
- `page` + `loginAs()` — use when you need to seed data BEFORE login (e.g., balance must be fresh on first panel load)
- `world.org.id` — org ID for credit seeding
- `qa.admin.token` — API token for server-side assertions


## Test failure artifacts

When a playwright test fails, per-test artifacts are at
`<run_dir>/tests/<safe-id>/`:
- `screenshot.png` — failure-moment screenshot
- `page-state.json` — URL, available selectors, console errors at failure
- `console.log` — full browser console output during the test
- `network.log` — request/response trail

Read these before rerunning — they capture everything you'd see by running again.
