# Store submission checklist

Everything on this page is a MANUAL step in somebody's browser or on this Mac. The pipeline
(`apps/mobile/ci/mobile-release.workflow.yml`) builds and, when the credentials exist, signs. It submits
nothing to Apple by itself unless a release is run with `dry_run` off, and it never submits to Play
at all.

## Operator specifics

The published app's App Store Connect record, Apple team, APNs key, reviewer account and upload
routine belong to its operator and are documented in the operator's own ops repository, not here.
A fork that publishes its own listing keeps the same things in its own.

## CI signing credentials (only for the unattended workflow)

| what | where it lives | the workflow reads it as |
|-|-|-|
| Apple distribution certificate (.p12) and its password | Apple Developer account, exported once | `APPLE_DISTRIBUTION_CERTIFICATE_P12`, `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD` |
| a keychain password for the runner | invented per repository | `APPLE_KEYCHAIN_PASSWORD` |
| App Store provisioning profile for `sh.liaison.mobile` | Apple Developer account | `APPLE_PROVISIONING_PROFILE` |
| Apple team identifier | Apple Developer account | `APPLE_TEAM_ID` |
| App Store Connect API key (.p8) with its key id and issuer id | App Store Connect, Users and Access | `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_PRIVATE_KEY` |
| Play upload keystore, its password, its alias and the alias password | generated once, kept off the repository | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEYSTORE_ALIAS`, `ANDROID_KEYSTORE_ALIAS_PASSWORD` |

Every value above is a GitHub Actions secret, by name. A build missing any one of them still runs
and produces a real artifact, labelled UNSIGNED in the log and in the marker file uploaded beside
it. There is no partial signing and there is no placeholder credential.

## The single build rule (D13)

ONE build serves every deployment. Nothing about a server is compiled into the app: the address is
entered on first launch and stored on the device, and the deployment's name, logo, flags and model
list are read from that server at boot (`GET /api/settings/branding`). So the binary submitted to
Apple and the bundle submitted to Play are the SAME artifact for every fork, and a fork that wants
its own listing submits its own copy of that artifact rather than a build of its own.

Consequences for a listing:

- screenshots are taken against one deployment and are illustrative, never a claim about the
  reviewer's own account,
- the review notes must say the app asks for a server address on first launch, and must give the
  reviewer an address and an account that work (Apple rejects an app that opens on a field the
  reviewer cannot get past),
- nothing in the listing names a specific customer's deployment.

## Identifiers

| field | value |
|-|-|
| bundle id (iOS) | `sh.liaison.mobile` |
| application id (Android) | `sh.liaison.mobile` |
| display name | Liaison |
| URL scheme | `liaison` (iOS `CFBundleURLTypes`, Android intent filter) |

The identifiers never change once a listing exists. The desktop shell uses a different bundle id on
purpose, so the two are signed and listed independently.

## App Store Connect

1. The app record exists ("liaison.sh"). A new fork that wants its own listing creates its own.
2. Upload the signed `.ipa` (the `Upload to App Store Connect` step, or Transporter by hand).
3. Screenshots for every required device size Apple currently asks for (6.9 inch and 6.5 inch
   iPhone at minimum, plus iPad if the listing claims iPad). Take them at the phone tier of the
   responsive shell.
4. Privacy nutrition label. What the app collects is what the deployment collects; what matters
   here is the PUSH payload, described in the privacy section below.
5. Push entitlement: the App ID has the Push Notifications capability and the app carries
   `aps-environment`; the archive's signed entitlements must show `production`. The APNs key (a
   .p8) is configured on each server (`APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_BUNDLE_ID`, see docs/notifications.md), never in the app.
6. Deep link: the app registers the `liaison` URL scheme only. It claims no associated domain:
   the app does not know which server it will talk to, so it names none.
7. Review notes must contain: the demo server address, the reviewer account,
   one sentence about the first launch address prompt, how to delete the account (Settings,
   Security, Delete my account; on the demo server the code is shown in the dialog), how to get a
   push (ask the agent to send you a message in one minute), and the business app sign in note for
   guideline 4.8 (accounts are created by the organisation, the app offers no sign up).
8. Submit to TestFlight first. The first external build takes a review of its own.
9. Export compliance: nothing to answer. `Info.plist` declares `ITSAppUsesNonExemptEncryption`
   false. See "Export compliance" below.

## Google Play

1. Create the Play Console listing with the application id above.
2. Upload the signed `.aab` by hand. The workflow builds it and uploads it as a run artifact; it
   has no Play publisher credential and invents none.
3. Data safety form. Same content as the Apple privacy label, same push payload reasoning.
4. Closed testing track BEFORE production. Play holds a new developer account on a closed test for
   a fixed period; starting that clock early is the only way to shorten it.
5. Push: Android delivery needs an FCM project and a `google-services.json` in
   `android/app/`. Neither exists yet. Without it the Android build installs and runs, and receives
   no push at all. This is recorded, not worked around.
6. Deep link: the `liaison` scheme intent filter only, no https link filter, for the same reason
   as iOS.

## Privacy, and what a notification may say

Both stores ask what the app sends. The answer is the push payload, and it is deliberately small.
The rule is in `apps/api/src/modules/push/redact.ts`:

- a message carrying any required scope produces a payload with NO text: no content, no title, no
  body, no scope name, no thread title, no author. The device shows the constant wording instead.
- only a message with no required scopes at all may carry a title and a truncated body.
- every payload carries the thread id, the deep link, a badge count and a type, and nothing else.

Say this in both forms. A notification is delivered by Apple or Google, rendered on a lock screen a
stranger can read, and kept by the operating system after the grant that justified it is gone.
None of those places re-check who may read it, which is why the payload is redacted at the source.

## Export compliance

**Decision: `ITSAppUsesNonExemptEncryption` is `false`** (pinned by `ios-config.test.ts`). The app
uses only encryption provided by the operating system: WebCrypto in WebKit, TLS, and CommonCrypto.
That is the first row of Apple's table, "Your app uses encryption limited to that within the Apple
operating system": no documentation, no French declaration, no per build questions, and it can be
listed in France with no ANSSI attestation.

### Inventory (`apps/web/dist-native` as copied into the iOS project)

| primitive | where | implementation |
|-|-|-|
| PBKDF2-HMAC-SHA256, 600 000 iterations, mailbox password key derivation | `wraps.ts` (`pbkdf2`) | WebCrypto |
| AES-256-GCM encrypt and decrypt of mail fields and blobs | `field-seal.ts`, `field-open.ts`, `stream-seal.ts`, `account-key.ts` | WebCrypto |
| AES-KW and AES-GCM key wrapping | `wraps.ts`, `keyring.ts`, `unseal.ts` | WebCrypto |
| ECDH P-256 (ECDH-ES seal) | `keyring.ts`, `seal.ts` | WebCrypto |
| Ed25519 sign and verify | `keyring.ts`, `ack.ts`, `keyring-attestation.ts` | WebCrypto |
| HKDF-SHA256 | `kdf.ts` | WebCrypto |
| HMAC, SHA-256 digest | `crypto-session.ts`, `ack.ts`, `bip39.ts`, `desktop-oauth.ts` (PKCE), `downgrade-detector.ts`, `worker-integrity.ts` | WebCrypto |
| passkey PRF | `passkey-ceremony.ts` (`navigator.credentials`) | WebAuthn, OS |
| TLS (HTTPS, WSS, APNs) | every request | WebKit and iOS |
| SHA-256 of the app UUID | Capacitor `AppUUID.swift` (`CC_SHA256`) | CommonCrypto, OS |
| biometric unlock | `@aparajita/capacitor-biometric-auth` (`LAContext.evaluatePolicy`) | LocalAuthentication, OS, authentication only |

Paths without a prefix are in `packages/mailbox-crypto/src/`. No crypto library is bundled into the
app (`@noble/*`, tweetnacl, libsodium, openpgp, scrypt-js, jose, argon2 and hash-wasm are absent).

### Why Argon2id is gone, and what keeps it out

Mailbox password wraps enrolled before 2026-09-29 derive their key with Argon2id through
`hash-wasm` (WebAssembly, not Apple's), which made the app non exempt. New wraps use PBKDF2 through
WebCrypto, and the row names its KDF. The legacy Argon2id code lives in one module,
`legacy-passphrase-kdf.ts`, which the native build (the `native` mode of the apps/web Vite build,
run by `bun run build:mobile`) replaces with a stand-in that carries none. The web app and the desktop
shell keep it, and when a legacy row is unlocked there it is silently re-wrapped under PBKDF2. On
the phone, a legacy row shows a message: unlock once on a computer, or use a passkey.

Guards: `build:mobile` and `ci/check-synced-assets.ts` (the step before signing) refuse any
`hash-wasm` or `argon2` trace or `.wasm` file in the synced assets, and `ios-config.test.ts` scans
the synced iOS assets for the same. Adding any crypto library, or any primitive WebCrypto does not
provide, puts the app back in Apple's second row: set the key to `true` and file the French
declaration before a French listing.

## Before each submission

- [ ] `bun run build:mobile` from `apps/mobile` exits 0 (the synced assets are scanned for host
      paths and for Argon2id as part of it).
- [ ] `bun run check:bundle-size` passes: the Home chunk is inside its budget.
- [ ] The mobile suite passes: `bun scripts/test-run.ts mobile` from the repository root.
- [ ] The marker file beside the artifact says `"signed": true`. If it says false, the artifact is
      a build, not a release.
- [ ] The version was bumped in `android/app/build.gradle` (`versionCode`, `versionName`) and in
      the iOS project, together.
