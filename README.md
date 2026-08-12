# ReviewGuard MCP

[![CI](https://github.com/eclipsesource/review-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/eclipsesource/review-guard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40eclipsesource%2Freview-guard-mcp)](https://www.npmjs.com/package/@eclipsesource/review-guard-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP server (`review-guard-mcp`) that lets AI agents work on GitHub PR reviews behind a safety boundary. The server holds the write-enabled GitHub token and exposes only review operations, so the agent never sees the token. What those operations are allowed to do is fixed at server start, not negotiable by the agent.

## Why

A write-enabled GitHub token is needed to create review comments, but giving that token directly to an agent risks accidental or prompt-injected actions: submitting approvals, requesting changes, closing other people's review threads, or touching unrelated repositories. This server sits in between and narrows the token down to exactly the review capabilities you opt into.

## Modes

The server supports two modes of use:

### Pending mode (default)

The agent reads PR discussion context and builds a **pending (draft) review**. Nothing it writes is visible to anyone else until a human opens the PR, inspects the draft comments, and submits the review themselves. Submission is structurally unreachable: the `submit` tool is not even registered, and the underlying client refuses every submit action.

Use this when an agent assists a human reviewer, for example in IDE setups (Claude Code, Codex, Theia) where the agent drafts inline comments and the human stays the reviewer of record.

### Submit mode (opt-in, `--allow-submit`)

Started with `--allow-submit`, the server additionally registers a `submit` tool so the agent can post the review itself. Guardrails stay in place:

- The allowed review actions are restricted to the set you list (for example comment-only, with no approvals).
- Every submitted review starts with a fixed, server-configured disclaimer the agent cannot change or remove.
- Optionally, `--allow-resolve` lets the agent resolve **its own** review threads (never anyone else's), and `--repo`/`--pr` pin the server to a single pull request.

Use this for unattended, autonomous review bots, for example a watcher that reviews every PR where a review is requested from the bot account and posts a real (comment-only) review.

## Installation

Requires Node.js >= 22.

Install globally (makes `review-guard-mcp` available in PATH):

```sh
npm install -g @eclipsesource/review-guard-mcp
```

Or pin to a specific version:

```sh
npm install -g @eclipsesource/review-guard-mcp@<version>
```

The server is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io)
as `com.eclipsesource/review-guard`, so clients that browse the registry can find
and install it from there. The registry runs the published npm package on your own
machine in the default pending mode. It is metadata only, there is no hosted
instance to connect to.

### From source

Requires npm >= 12 and a Node version supported by it (see [CONTRIBUTING.md](CONTRIBUTING.md)):

```sh
git clone https://github.com/eclipsesource/review-guard.git
cd review-guard
npm ci
npm run build
npm link          # creates a global symlink to the binary
```

## Tools

| Tool                    | Availability      | Description                                                                                                                                                                      |
| ----------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_pr_review_context` | always            | Get PR author/message, submitted review summaries, inline review threads with resolved state, reactions and permalinks, and general PR comments                                  |
| `list_pending_review`   | always            | List the authenticated user's pending draft review, including all current pending review comments and their permalinks                                                           |
| `add_review_comments`   | always            | Add one or more comments to the authenticated user's pending review, creating the pending review if needed                                                                       |
| `modify_review_comment` | always            | Update or delete one comment from the authenticated user's pending review                                                                                                        |
| `delete_pending_review` | always            | Delete the authenticated user's pending review and all its comments                                                                                                              |
| `submit`                | `--allow-submit`  | Submit the pending review as a real, posted review. The `action` is limited to the allowed set and the review summary always starts with the fixed, server-configured disclaimer |
| `resolve_review_thread` | `--allow-resolve` | Resolve one of the authenticated user's **own** review threads (e.g. a prior finding the latest push fixed). Refuses threads started by anyone else                              |

## Submit mode flags

By default the server cannot submit reviews. To allow it, start the server with `--allow-submit` listing one or more of `approve`, `comment`, `reject`:

```bash
review-guard-mcp --port 4000 \
  --allow-submit approve,comment \
  --submit-body "This is an autonomous, AI-based review and may contain mistakes."
```

- `--allow-submit <csv>` enables the `submit` tool and restricts its `action` enum to exactly these values. `approve` maps to APPROVE, `comment` to COMMENT, and `reject` to REQUEST_CHANGES. Invalid actions abort startup.
- `--submit-body <text>` sets the fixed review summary prefix posted with every submission. The agent cannot change or remove it and may only append its own summary below it. If omitted while `--allow-submit` is set, a built-in default disclaimer is used. Its wording adapts to the allowed actions (when `approve` is not allowed it states the review is not an approval, rather than caveating one). Requires `--allow-submit` and must not be empty.
- `--allow-resolve` registers the `resolve_review_thread` tool. The client resolves only threads whose first comment was authored by the authenticated user, so a bot can tidy up its own now-fixed findings on a re-review but never close another reviewer's conversation.

Without `--allow-submit`, the `submit` tool is not registered and the `submitReview` client method refuses every action, so submission is structurally unreachable.

## Scoping to a single PR (opt-in)

Start the server with `--repo <owner/name> --pr <number>` to pin it to one pull
request:

```bash
review-guard-mcp --port 4000 --repo eclipsesource/some-repo --pr 123
```

When scoped, every tool drops its `owner`/`repo`/`pull_number` arguments and
acts on that PR only. `resolve_review_thread` additionally checks that the
thread belongs to it. The client (`github.ts`) enforces this independently of
the tool schemas, so a caller cannot reach a different PR or repo the token can
otherwise write to. Use this whenever the server backs an automated review of a
known PR (typically together with submit mode), so a prompt-injected agent
cannot post to or resolve threads on unrelated PRs. Both flags are required
together. Omitting them leaves the server unscoped (the caller supplies the PR
per call).

## MCP Client Configuration

### Stdio mode (recommended for IDEs)

The server runs as a child process managed by the IDE. No port configuration needed.

For MCP clients that use the common JSON config shape (Claude Code, VS Code,
Theia):

```json
{
  "mcpServers": {
    "review-guard": {
      "command": "npx",
      "args": ["-y", "@eclipsesource/review-guard-mcp", "--stdio"]
    }
  }
}
```

For Codex, add the server to `~/.codex/config.toml` or a trusted project-local
`.codex/config.toml`:

```toml
[mcp_servers.review-guard]
command = "npx"
args = ["-y", "@eclipsesource/review-guard-mcp", "--stdio"]
```

Or pin to a specific version:

```json
{
  "mcpServers": {
    "review-guard": {
      "command": "npx",
      "args": ["-y", "@eclipsesource/review-guard-mcp@<version>", "--stdio"]
    }
  }
}
```

### Remote HTTP mode

The server runs standalone and exposes a Streamable HTTP endpoint.

Start the server:

```bash
review-guard-mcp --port 4000                     # bind to 127.0.0.1 (localhost only)
review-guard-mcp --port 4000 --host 172.17.0.1   # bind to a specific address instead
```

Then point your MCP client at the printed URL (e.g. `http://127.0.0.1:4000/mcp`). Each POST is an independent stateless request.

Codex HTTP configuration uses the same TOML shape:

```toml
[mcp_servers.review-guard]
url = "http://127.0.0.1:4000/mcp"
```

#### `--host` flag

By default the HTTP server binds to `127.0.0.1`, which makes it unreachable from containers and other machines. Pass `--host <address>` to bind one specific address instead. Because the endpoint is unauthenticated, the unspecified addresses (`0.0.0.0`, `::`) are rejected at startup.

The main use case is a reviewing agent that runs inside a container (e.g. a sandboxed agent runtime) and needs to reach the MCP server on the host. On Linux, bind the container network's gateway IP, e.g. for Docker's default bridge (typically `172.17.0.1`):

```bash
review-guard-mcp --port 4000 \
  --host "$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
```

The host firewall must also allow traffic on the MCP port from the container subnet, e.g. with ufw:

```bash
sudo ufw allow from 172.17.0.0/16 to any port 4000 proto tcp
```

From inside the container you can point the client at whichever local name reaches the host: the gateway IP itself, `host.docker.internal` (Docker) or `host.containers.internal` (Podman), or a `localhost`/`127.0.0.1` alias that your runtime maps to the host. With a non-loopback `--host` the server accepts the `Host` header for any of these while still rejecting unknown hosts, so DNS-rebinding protection stays on.

## Authentication

If the [GitHub CLI](https://cli.github.com/) is installed and authenticated (`gh auth login`), **no token configuration is needed**. The server automatically retrieves the token via `gh auth token`.

If `gh` is not available, provide a token explicitly via the MCP config:

```json
{
  "mcpServers": {
    "review-guard": {
      "command": "npx",
      "args": ["-y", "@eclipsesource/review-guard-mcp", "--stdio"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

The full resolution order is:

1. **`GITHUB_TOKEN`** environment variable
2. **`GH_TOKEN`** environment variable
3. **`gh auth token`**, which reads the token from the GitHub CLI

A [fine-grained personal access token](https://github.com/settings/tokens?type=beta) scoped to the repositories you review is recommended.

## Security considerations

- **The agent never sees the token.** The server holds it and only exposes the
  tool set configured at startup.
- **HTTP mode binds to `127.0.0.1` by default** and validates the `Host` header
  against the bound address (DNS rebinding protection), so a malicious website
  cannot reach the server through a victim's browser.
- **The `/mcp` endpoint itself is unauthenticated.** Anyone who can reach the
  port can use the configured capabilities. Keep it on localhost, or with a
  non-loopback `--host` restrict the port to the intended subnet via firewall,
  because every machine or container on that network can otherwise reach it.
  Unspecified bind addresses (`0.0.0.0`, `::`) are refused at startup.
- **Prefer a fine-grained token** scoped to only the repositories under review,
  and add `--repo`/`--pr` scoping for automated setups.

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Safety Invariants

The `src/github.ts` module is the only file that talks to GitHub. By default it cannot submit. Every capability beyond pending-review writes is gated at construction time. It enforces:

1. **No `event` field on comment/thread mutations.** Draft comments always leave the review `PENDING` because `event` is omitted entirely.
2. **Submission is opt-in and gated.** The `submitPullRequestReview` mutation is called only inside `submitReview`, which refuses any action not in the `allowSubmit` set passed at construction. A client built without `--allow-submit` (the default) can never submit. `DISMISS` is never supported.
3. **Fixed submission body.** Submitted reviews always start with the server-configured `--submit-body`. Callers can only append below it, never replace or remove it.
4. **Thread resolution is opt-in and own-threads-only.** `resolveReviewThread` runs only when `--allow-resolve` is set and refuses threads not started by the authenticated user.
5. **No REST submit/dismiss endpoints** are ever called.
6. **Own-review writes.** Write tools only affect the authenticated user's own review.
7. **PR scoping.** When started with `--repo`/`--pr`, every operation targeting a different PR or repository is refused inside the client, independent of the tool schemas.
8. **Auditable.** Grep `src/github.ts` for `submitPullRequestReview`, `dismiss`, `APPROVE`, `REQUEST_CHANGES`. The mutation and events appear only inside `submitReview`. The gates are covered by unit tests in `test/github.test.ts`.
9. **Post-mutation tripwire (defense in depth).** After creating a review, the response state is verified to be `PENDING`. Unlike the gates above this detects rather than prevents: on a violation the tool call fails with an MCP error that tells the agent to stop and alert the human, because many MCP clients do not show tool errors to the user on their own.

## Development

Development requires npm >= 12 and a Node version supported by it. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

```bash
npm ci                           # install dependencies
npm run build                    # compile TypeScript to dist/
npm run dev                      # tsx watch mode
npm run typecheck                # type-check sources, tests, and configs
npm run lint                     # ESLint
npm run format:check             # Prettier
npm test                         # vitest suite
npm run test:integration         # manual suite against a real repo (see CONTRIBUTING.md)
```

## Architecture

```
src/
├── index.ts     # Entry point: token resolution, mode dispatch (--stdio / HTTP)
├── args.ts      # CLI parsing: every flag in one place, unknown flags abort startup
├── server.ts    # MCP server factory with tool schemas (shared by both transports)
├── stdio.ts     # Stdio transport (for IDE-managed lifetime)
├── http.ts      # HTTP transport (node:http, Streamable HTTP)
└── github.ts    # Safety boundary: GraphQL mutations + REST reads
test/            # vitest suite: CLI parsing, safety gates, tool registration
```

- **GraphQL** for resolved review-thread context and mutations (`addPullRequestReview`, `addPullRequestReviewThread`, `updatePullRequestReviewComment`, `deletePullRequestReviewComment`, `deletePullRequestReview`, and, behind their opt-in gates, `submitPullRequestReview` and `resolveReviewThread`).
- **REST** for well-paginated PR review summaries and general PR conversation comments.
- HTTP mode binds to `127.0.0.1` only (or the specific address given with `--host`).

## Contributing

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Contributors
are required to sign a CLA, which is checked automatically on pull requests.

## License

[MIT](LICENSE)
