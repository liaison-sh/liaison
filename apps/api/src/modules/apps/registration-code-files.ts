// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The source files that turn an app manifest into DDL, relative to `apps/api/src`.
// One list for both readers: the registration's own code identity (runtime.ts,
// `appRegistrationCodeIdentity`: a release that changes any of them re-applies
// every app once) and the test template's key (scripts/lib/test-template.ts: a
// change to any of them rebuilds the template, whose app schemas they produce).
// Kept free of imports so a script outside apps/api can read it.

export const APP_REGISTRATION_CODE_FILES: readonly string[] = [
  "modules/apps/runtime.ts",
  "modules/apps/ddl.ts",
  "modules/apps/trigger-review.ts",
  "modules/permissions/rls-generator.ts",
  "modules/mailbox-crypto/post-sync-assertions.ts",
]
