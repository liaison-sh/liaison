// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The routine the services world's sales scenario starts: its name and
// instructions. Written for a small model that follows steps literally: the
// exact tool names, the order and the @ref forms are spelled out, and there is
// one path per case. Every write waits for the visitor's approval, as one
// request for the whole chain, and no step sets a price: the proposal is
// drafted without one and the person sets it.
import { STUDIO_PROSPECT_ROUTINE_NAME } from "@liaison/shared"

export const STUDIO_PROSPECT_SCENARIO_ROUTINE_NAME = STUDIO_PROSPECT_ROUTINE_NAME

/** The sales routine's instructions: company, deal, a proposal with no price, and the reply. */
export function studioProposalRoutinePrompt(): string {
  return (
    "An email has just arrived from a prospect with a project brief. The event data names the " +
    "message, its conversation and its sender.\n\n" +
    "You prepare ONE request that I approve once: the company, the deal, a proposal draft and " +
    "the reply. Each write below waits for my approval; it returns `outputs` with @ref tokens. " +
    "Do NOT wait for an approval between the steps: make the next call at once, with the token " +
    "copied exactly where the step says.\n\n" +
    "1. Read the email. Look the sender up with kernel__contacts_search by their email, then " +
    "their company with kernel__companies_search by its domain, then by its name. Then call " +
    "agreements__templates_list (it only reads) and note the statement of work template's id: " +
    "once the first write is proposed, a call that only reads is not run.\n" +
    "2. If the firm is not there yet, read its website with web_fetch, at exactly " +
    "https://DOMAIN/ where DOMAIN is the part of the sender's address after the @, with " +
    "nothing after the last slash. If the fetch fails, go on without it and say so in the " +
    "brief.\n" +
    "3. Company. A NEW firm: call kernel__companies_write with its name, its domain and one " +
    "line on what it does. Its result has outputs.id and outputs.name, tokens like " +
    "@ref:<id>:id. A firm ALREADY there: make no call; its id is the id the search returned.\n" +
    "4. Deal. Call projects__create in the Sales pipeline: title the firm's name and what they " +
    "ask for, companyId the id token from step 3, whole.\n" +
    "5. Proposal. Call agreements__agreement_create with kind sow, the statement of work " +
    "template's id from step 1, the " +
    "title of what they ask for, company_id the id token from step 3, whole, and the scope " +
    "taken from the brief. Set NO price: the price is mine to set.\n" +
    "6. Reply. Call mail__reply with conversationId (from the event data) and a textBody that " +
    "thanks them for the brief, names their firm with the name token from step 3, restates " +
    "what they ask for in two lines, and says a proposal with its price follows. No price, no " +
    "figure of money.\n" +
    "Then stop: the run waits for my decision and comes back to you with the results.\n" +
    "7. Once I have decided, close with a short brief: who they are, what the firm does (say " +
    "where you learned it), what they want, and what became of the company, the deal, the " +
    "proposal and the reply. If a step failed, propose the corrected calls as the error says " +
    "instead. End with it as your answer.\n\n" +
    "If a call is refused, read its error, fix the call as it says and make it again. Report " +
    "only what the results show."
  )
}
