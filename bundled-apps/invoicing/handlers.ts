// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task C1 — Freeze entrypoint.
//
// `liaison/scripts/freeze-app.ts` resolves `<appDir>/handlers.ts` as the
// Bun.build entrypoint. The real handler source lives under `src/handlers.ts`
// for code-organization reasons (mirrors the Shopify bundled app pattern).
// This file is a thin re-export so freeze can locate the bundle entry without
// ad-hoc path overrides.
export * from "./src/handlers"
