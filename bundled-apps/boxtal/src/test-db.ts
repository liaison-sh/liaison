// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The boxtal suite's in-memory DB mock: the shared bridge-shaped mock from
// @liaison/test-helpers/mock-db, with `search` honored by `count` too.
import {
  createMockDb as createSharedMockDb,
  type MockDb,
  type MockDbOptions,
} from "@liaison/test-helpers/mock-db"

export type { MockDb, MockDbOptions }

export function createMockDb(opts: MockDbOptions = {}): MockDb {
  return createSharedMockDb(opts, { countHonorsSearch: true, bridgeWhereOperators: true })
}
