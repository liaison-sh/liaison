// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The constants that make the services world's GitHub connection inert.
//
// The services world reads its delivery traces (commits, pull requests) with
// the GitHub app. A demo org must never hold a real token for it and must never
// put a request on GitHub's wire, so:
//
//   * the seeder installs a connection whose token is the literal sentinel
//     below, a constant with no secret in it and no token shape (no `ghp_` or
//     `github_pat_` prefix): a leak of the demo database leaks nothing;
//   * every request carrying it is answered in-process by the stand-in
//     (provider.ts) for an org holding the world, refused for any other org,
//     and never forwarded, whatever mode the box runs in
//     (`modules/demo/fixture-credential.ts`);
//   * every link it hands out lives on a reserved `.example` host, so nothing
//     points at a real repository page.

/** The GitHub app, and its one connection, by the name the app declares. */
export const GITHUB_APP = "github"
export const GITHUB_CONNECTION = "github"
export const DEMO_GITHUB_IDENTIFIER = "demo-github"

/** The stand-in for the access token. Not a credential, and recognisably not one. */
export const DEMO_GITHUB_SENTINEL_TOKEN = "liaison-demo-fixture-not-a-github-token"

/** The account the services world's repositories belong to (the plan's `sourceRepos` owner). */
export const DEMO_GITHUB_OWNER = "haldenstudio"

/** The login the stand-in token reads as (`GET /user`). */
export const DEMO_GITHUB_READER_LOGIN = "haldenstudio-reader"

/** GitHub's API host: the only host the app calls. */
export const GITHUB_API_HOST = "api.github.com"

/** The host every link of the stand-in points at. */
export const GITHUB_STANDIN_HOST = "github-standin.example"
