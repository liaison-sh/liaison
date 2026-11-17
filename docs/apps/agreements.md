---
title: Prepare agreements
description: "Draft proposals, statements of work, contracts and any PDF, keep templates with versions, and decide who in the organization can see each agreement."
---

The Agreements app keeps your proposals, statements of work, contracts and any PDF you upload as drafts, checks them before they go out for a simple electronic signature, and keeps the templates they come from.

## Draft an agreement

Ask an agent, or use the app: an agreement starts as a draft from a template, a short brief, or an uploaded PDF (kind **other**, where a person says what the document is). Every agreement gets its number from its series: `PR-` for proposals, `DOC-` for an uploaded PDF, `AG-` for the rest, with the year.

An agent never sets a price. A person sets it on the agreement's page. A proposal, a statement of work or a retainer without a price cannot be prepared.

Clauses an agent wrote are marked as drafts. They block the checks until a person reads them and saves the text.

## Check before sending

**Prepare** runs the checks a document needs before it is sent:

- a document tagged as a guarantee, real estate, family or employment document cannot be signed here;
- a text that looks like a personal guarantee waits until a person changes its kind or says it is not one;
- minutes of a meeting, a written consultation or a filing pass with a note: check with your lawyer first, since some of these acts need a higher signature level, which Liaison does not offer;
- a proposal needs its price, a PDF needs a person's statement of what it is, and every agent clause needs a person's reading.

### Upload your own PDF

Upload the file first (from an agent's client, `kernel__files_upload_url` then `kernel__files_upload_confirm`), then pass its file id when you create the agreement or save its draft. Liaison keeps a copy of the file on the agreement, so whoever may read the agreement reads the file, and nobody else: an agreement closed to the organization hides it too.

**Prepare** freezes the file exactly as you uploaded it, byte for byte, after the server's own checks: the file is read by an isolated render service (see [Run with Docker](../self-hosting/docker.md)), refused when it holds active content or reads two ways, and pictured page by page for the signing page. A long check answers that the file is still being checked, and the version appears when the check ends. When the virus scanner is down or not set up, the file is kept and marked as not checked: sending it scans it again, a later scan runs every 15 minutes until the scanner answers, and until then the approval card says "Not checked for viruses". A file the scanner later finds is not sent, and its signing page no longer offers the download.

## Keep templates with versions

Saving a template makes a new version. An agreement copies the text of the version it was made from, so a later version never changes it. A template shows or hides a block on one field's equality only. An agent's template save waits for a person's approval.

## Decide who can see an agreement

Each agreement has an organization access (none, viewer, editor) and a list of named people. With **none**, only the people on the list can read the agreement, its drafts, versions, signatures and evidence, whatever role or permission anyone else holds, administrators included. The person who creates an agreement starts on its list as an editor. The list is never empty, a viewer cannot change it, and an agent's change waits for a person.

What comes from a closed agreement follows its list: Home items and notifications about it reach only the people on the list, a routine whose owner is not on the list does not run on its events, and what an agent writes after reading it can be read only by the people on the list.

An approval about a closed agreement goes only to the person who asked, and its Home line and notification say "A restricted document needs your decision" without the title. When an agreement is closed while requests about it wait for people who are not on its list, those requests are withdrawn and the people on the list get one Home line saying so. A colleague who signs a closed agreement but is not on its list signs with their own link and reads it only there; the send card says so before anyone approves.

Administrators see nothing of a closed agreement while anyone on its list is active. Once every person on the list has been deactivated for 7 days, an administrator with the user administration permission can add themselves with `POST /api/apps/agreements/agreements/:id/claim`. The claim is recorded in the audit log, everyone who was ever on the list gets a mail, and the agreement shows who claimed it and when. This is an access rule, not encryption: whoever runs the server can reach the data.

The audit log shows what it recorded about a closed agreement to the people on its list only. The whole-organization export names a closed agreement by its number and status and leaves out its title, versions, signatures, evidence and list.

## Send for signature

**Send** takes the version **Prepare** froze, with its fingerprint, and the signers: contacts or email addresses, in order (one after the other) or all at once, with links that last 7, 14 or 30 days. A contact signs at the address the directory holds for them; a send that names a contact with another address is refused (name that signer by email instead, or correct the contact). An agent's send waits for a person's approval; nothing goes out if the version changed since **Prepare**, and the approved send goes only to the addresses its card showed. Under "one after the other", the next signer gets a link only once the signer before them signed. A colleague who signs gets a line on their Home and signs in their own session, with no mailed link; their **Read and sign** opens only once their turn has come.

A signer opens the link, reads the document, proves the code sent to their address and types their name. A link whose code was never proved can read and decline, never sign. Each signature is recorded once; the agreement shows **partly signed**, then **signed** when the last signer signed. A decline closes it as **declined**.

A server signs only with a timestamp authority set up (`LIAISON_TSA_URL`). On the hosted edition, signatures are off unless the operator turns them on (`LIAISON_MANAGED_SIGNING_ENABLED`).

## Follow up a send

- **Remind** sends each named signer whose link is still open a fresh link; the one mailed before stops working. A signer who answered, or who waits for their turn, gets nothing.
- **New link** gives one signer a new link, at the same or a corrected address, in the same turn: after their link expired or was withdrawn, or after a decline made without the emailed code. Signatures already given stand, and the link it replaces no longer counts: the agreement is signed once every signer signed on their current link. A new link to a corrected address is no longer tied to the contact. After a decline made with the code, send a new version instead.
- **Void** withdraws every open link at once, with a reason. Signatures already given stay.

An agent's reminder, new link or void waits for a person's approval. **Agreement details** list every signing link with its signer, turn and state.

Every day, a signed agreement that enters its notice period before its renewal or end date raises one notice, and a send whose every link expired with nobody signed becomes **expired**. Every ten minutes, a signature the app missed is recorded.

## Keep the proof of a signature

When the last signer signs, the app seals the version:

- the **signed PDF** is the frozen document with signature pages added at the end: each signer, the capacity they stated, the words they typed when the sender asked for them, the date and time, the level (simple electronic signature) and the document's fingerprint. The pages are numbered on their own ("Signature page 1 of 2"), in the document's language, so the document's own page numbers stay true;
- the **seal** is a fingerprint over the document's and the signed PDF's fingerprints and the record of every signature;
- the **evidence file** is a zip of the signed PDF, the frozen document, the signature record, the seal, a signature certificate and a check page;
- the **outside timestamp** comes from the timestamp authority. When the authority does not answer, the seal stands without it, the app asks again every ten minutes and mails each signer the stamped evidence file when it arrives. After 24 hours without it, one notice goes to the people who can read evidence.

Each signer gets a copy by email: the signed PDF and their own copy of the evidence file, with the fingerprint and the seal written in the mail. A signer's copy lists only their own device; a copy for a colleague lists no device at all. A copy that fails to send is tried again, and after three failures one notice names the signer.

A signer's last page, and their signing link opened again afterwards, says where their copy stands: waiting for the other signers, on its way, sent, or not sent (the sender was told). A typed name the signature pages cannot draw is refused at the code step, before the code is used, with a request to type it in Latin letters.

A seal that fails is tried again every ten minutes; the version stays signed meanwhile, and one notice goes out after an hour. A stored document that no longer matches its fingerprint is never sealed: the app raises a mismatch notice instead.

### Check a document without Liaison

Anyone holding an evidence file (the staff file or a signer's copy) can check a PDF with no network and no Liaison account:

1. Unzip the evidence file and open `check.html` in a browser.
2. Choose or drop the PDF to check. The page says "This is the document they signed" when the file is the frozen document or the signed PDF, with its fingerprint, and "This is not the document they signed" otherwise, with both fingerprints.

The page also shows the seal (compare it with the one in the signer's mail), says whether the timestamp names this seal, and on the staff file whether the signature record is the sealed one. A signer's copy leaves other people's devices out, so its record is not checked. The page does not check the timestamp authority's signature: it shows the `openssl ts -verify` line for that.

`packages/evidence-check/verify-with-openssl.sh <evidence.zip> <tsa-chain.pem>` runs every check with openssl alone, the timestamp's signature included. `tsa-chain.pem` is the timestamp authority's published certificate chain (the one set as `LIAISON_TSA_CHAIN_FILE`); the zip does not carry it, so that the file cannot vouch for itself.

Evidence is kept at least ten years from the seal, or until the contract's end plus the organization's years after the end when that is later. Nothing in the app deletes it, and a set field never changes.

## Check a signed agreement

Ask an agent, with `agreements:evidence:read`:

- for an agreement's **evidence** (`agreement_evidence_get`): the fingerprints, the seal, the timestamp, each signature and whether each signer's copy was sent. Signers' IP addresses and browsers need `agreements:evidence:devices`.
- to **verify** it (`agreement_verify`): the app hashes the stored files again and recomputes the seal. A mismatch is recorded, shown and reported as an incident, and nothing is repaired: the signers' copies are the reference. The app also checks every sealed agreement once a week.

## Scopes

| Scope | Lets you |
|---|---|
| `agreements:agreements:read` | Read agreements and templates |
| `agreements:agreements:write` | Draft, change, price and prepare agreements |
| `agreements:evidence:read` | Read signature records and evidence |
| `agreements:evidence:devices` | See signers' device details |
| `agreements:templates:write` | Save templates |
| `agreements:approve` | Decide a card an agent's change is waiting on (who can see an agreement, a template save) |
| `agreements:internal` | Used by the app itself |
