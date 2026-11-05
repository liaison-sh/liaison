// SPDX-License-Identifier: FSL-1.1-ALv2
import { describeAdapterConformance } from "~/modules/mailbox/search-index/adapter-conformance"
import { createFlexSearchIndexAdapter } from "~/modules/mailbox/search-index/flexsearch-adapter"

describeAdapterConformance("flexsearch", () => createFlexSearchIndexAdapter())
