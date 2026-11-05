// SPDX-License-Identifier: FSL-1.1-ALv2
import { defineConfig } from "drizzle-kit"

if (process.env.SCHEMA_PREFIX) {
  throw new Error(
    "SCHEMA_PREFIX must not be set when running drizzle-kit. " +
      "Unset it before running: bunx drizzle-kit generate / migrate",
  )
}

export default defineConfig({
  // Exclude colocated `*.test.ts` files — drizzle-kit's CJS resolver cannot
  // load their `bun:test` imports, and test files carry no schema definitions.
  schema: "./src/db/schema/**/!(*.test).ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.MIGRATION_DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/liaison_dev",
  },
})
