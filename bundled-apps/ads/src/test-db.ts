// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ads suite's in-memory DB mock: the shared bridge-shaped mock from
// @liaison/test-helpers/mock-db.
import {
  createMockDb as createSharedMockDb,
  type MockDb,
  type MockDbOptions,
} from "@liaison/test-helpers/mock-db"

export type { MockDb, MockDbOptions }

export function createMockDb(opts: MockDbOptions = {}): MockDb {
  // Mirror the real bridge: created_at is a kernel-managed base column with a
  // DB-side DEFAULT NOW(), never caller-supplied (callers omit it deliberately,
  // see google-pause.ts's pause_ledger insert). Without this, a findMany right
  // after insert would see no created_at at all, unlike production.
  return createSharedMockDb(opts, { stampCreatedAt: true })
}
