// SPDX-License-Identifier: FSL-1.1-ALv2
import { describeAdapterConformance } from "~/modules/mailbox/search-index/adapter-conformance"
import { createMemorySearchIndexAdapter } from "~/modules/mailbox/search-index/memory-adapter"

describeAdapterConformance("memory", () => createMemorySearchIndexAdapter())
