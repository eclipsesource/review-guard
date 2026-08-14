# Contributing to ReviewGuard MCP

Contributions are welcome. Contributions are accepted under the project's
[MIT license](LICENSE).

## Contributor License Agreement (CLA)

All contributors are required to sign a CLA, which will be checked automatically
when you open a pull request.

## Development setup

Development requires **npm >= 12** and a Node.js version npm 12 supports: 22.22.2
or newer on the 22 line, 24.15.0 or newer on the 24 line, or any later major.
Both are enforced through the `devEngines` field in `package.json`. `.nvmrc`
selects Node 24, the recommended version, for `nvm use`.

```sh
git clone https://github.com/eclipsesource/review-guard.git
cd review-guard
npm ci
```

> **npm 12 note:** dependency install scripts are blocked by default. The ones this
> project needs are pre-approved in the `allowScripts` field of `package.json`, so a
> plain `npm ci` works. If a future dependency needs a script, review it first and
> approve it with `npm install-scripts approve <pkg>` so the allowance is committed.

## Scripts

| Command                    | Purpose                                                 |
| -------------------------- | ------------------------------------------------------- |
| `npm run build`            | Compile TypeScript to `dist/`                           |
| `npm run dev`              | Watch mode via tsx (requires a GitHub token)            |
| `npm start`                | Run the HTTP server from source                         |
| `npm run typecheck`        | Type-check sources, tests, and configs                  |
| `npm run lint`             | ESLint (`lint:fix` to autofix)                          |
| `npm run format`           | Prettier write (`format:check` to verify only)          |
| `npm test`                 | Run the vitest suite (`test:watch` for watch)           |
| `npm run test:coverage`    | Test with V8 coverage                                   |
| `npm run test:integration` | Manual run against a real GitHub repository (see below) |

## Integration tests (manual)

The unit suite mocks the GitHub API, so it verifies what the code sends but
not how GitHub actually behaves. `npm run test:integration` closes that gap:
it drives every MCP tool against a real repository and verifies each step
with direct API reads independent of the code under test. Run it manually
before a release or after dependency updates. It never runs in CI and the
regular `npm test` does not pick it up.

It needs a **private throwaway repository** and **two GitHub accounts** with
write access to it, because several checks involve a second user: draft
invisibility, the foreign-thread resolve refusal, and reaction visibility.
Configure it through environment variables:

| Variable                           | Meaning                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `REVIEW_GUARD_TEST_REPO`           | The test repository as `owner/name`                     |
| `REVIEW_GUARD_TEST_TOKEN_REVIEWER` | Token of the reviewer account under test                |
| `REVIEW_GUARD_TEST_TOKEN_AUTHOR`   | Token of a second account that authors the pull request |

```sh
REVIEW_GUARD_TEST_REPO=me/review-guard-testbed \
REVIEW_GUARD_TEST_TOKEN_REVIEWER=ghp_... \
REVIEW_GUARD_TEST_TOKEN_AUTHOR=ghp_... \
npm run test:integration
```

The suite creates a branch and a pull request (authored by the second
account), walks the full tool surface (pending review lifecycle, submit with
the fixed disclaimer, own-thread resolution, the foreign-thread refusal,
reaction visibility, PR scoping), and then closes the pull request and
deletes the branch. Set `REVIEW_GUARD_TEST_KEEP=1` to keep both for
inspection. Leftovers from crashed runs are cleaned up at the start of the
next run.

## Pull requests

- CI must pass: lint, format check, typecheck, build, tests, and a package dry-run.
- New behavior needs tests. The safety guarantees in `src/github.ts` and the CLI
  validation in `src/args.ts` are covered by `test/`. Changes to either must keep
  or extend that coverage.
- Keep the safety invariants documented in the README intact. Never add a second
  call site for `submitPullRequestReview` and never make the submit disclaimer
  removable.
- Write plain sentences in docs, comments, and user-facing strings. No em dashes
  and no semicolons in prose.

## Use of AI tools

Contributors can use whatever tools they would like to craft their
contributions, but there must be a human in the loop. Contributors must read
and review all LLM-generated code or text before they ask other project members
to review it. The contributor is always the author and is fully accountable for
their contributions. Contributors should be sufficiently confident that the
contribution is high enough quality that asking for a review is a good use of
scarce maintainer time, and they should be able to answer questions about their
work themselves during review.

## Releasing

Maintainers release through the **Release** GitHub Actions workflow. It bumps
the version in both `package.json` and `server.json`, publishes to npm, and
then calls **Publish to MCP Registry** to list the new version in the
[MCP Registry](https://registry.modelcontextprotocol.io) as
`com.eclipsesource/review-guard`. The full process, including the one-time npm
trusted publishing setup and the one-time MCP Registry setup, is documented in
the [repository wiki](https://github.com/eclipsesource/review-guard/wiki).

If only the listing fails, the release itself stands. Dispatch **Publish to MCP
Registry** with the released version to retry it. It reads `server.json` from
that version's tag, so it needs no other input. Registry versions are immutable,
so this only works while the version is genuinely unlisted.

The registry entry is metadata only. Nothing is hosted for users, they run the
npm package locally. Two invariants keep it publishable:

- `mcpName` in `package.json` must equal `name` in `server.json`. That is how
  the registry verifies the package belongs to the namespace.
- The registry name `com.eclipsesource/review-guard` is proven by the file
  served at `https://eclipsesource.com/.well-known/mcp-registry-auth`, which
  holds the public half of the signing key the release workflow uses. The
  listing fails while that URL is unreachable, and redirects do not count.

`test/server-json.test.ts` guards the parts of this that would otherwise only
fail during a release. It validates `server.json` against the schema pinned in
its `$schema` field, using the copy in `test/fixtures/`. That copy is vendored
verbatim from the registry, which embeds the same file for its own validation.
The pin is dated, so the copy cannot go stale, and the test fails if the pin is
moved without vendoring the matching schema.

**Publish to MCP Registry** pins the `mcp-publisher` release it downloads and
checks its SHA-256 before running it, because that job holds the signing key.
Bumping `MCP_PUBLISHER_VERSION` means taking the new checksum from the
`registry_<version>_checksums.txt` asset of that release.
