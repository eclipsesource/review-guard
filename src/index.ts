#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { CliOptions, CliUsageError, parseCliOptions } from "./args.js";
import { GitHubReviewClient, SubmitAction } from "./github.js";

// ---------------------------------------------------------------------------
// CLI options are parsed and validated first so misconfiguration fails fast,
// before any token is needed.
// ---------------------------------------------------------------------------

let options: CliOptions;
try {
  options = parseCliOptions();
} catch (error) {
  if (error instanceof CliUsageError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Token resolution: env var first, then gh CLI fallback
// ---------------------------------------------------------------------------

function resolveToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated, fall through
  }

  console.error(
    "No GitHub token found. Either set the GITHUB_TOKEN environment variable " +
      "or authenticate with the GitHub CLI: gh auth login",
  );
  process.exit(1);
}

const GITHUB_TOKEN = resolveToken();

// ---------------------------------------------------------------------------
// Submit disclaimer: --submit-body wins, otherwise a built-in default is used.
// ---------------------------------------------------------------------------

// The default disclaimer reflects what the server is actually allowed to do.
// When approving is enabled, it caveats the approval. When it is not (e.g. a
// comment-only autonomous reviewer), it states plainly that the review is not
// an approval, so the note never implies a power the server does not have.
function defaultSubmitBody(actions: SubmitAction[]): string {
  const stance = actions.includes("approve")
    ? "> An approval here does **not** mean the change is free of architectural " +
      "issues. The overall architecture and design should still be reviewed by a " +
      "human.\n"
    : "> This review does **not** approve the change. A human still needs to " +
      "review it and sign off on the overall architecture and design.\n";
  return (
    "> [!NOTE]\n" +
    "> **Autonomous AI review.** Generated automatically, so it may contain " +
    "mistakes. Feel free to ignore any comment you disagree with (noting *why* " +
    "helps future reviews).\n" +
    ">\n" +
    stance +
    ">\n" +
    "> To get an updated review after pushing changes, re-request a review from " +
    "this account."
  );
}

const submitBody =
  options.allowSubmit.length > 0
    ? (options.submitBody ?? defaultSubmitBody(options.allowSubmit))
    : undefined;

const client = new GitHubReviewClient(GITHUB_TOKEN, {
  allowSubmit: options.allowSubmit,
  submitBody,
  allowResolve: options.allowResolve,
  scope: options.scope,
});

// ---------------------------------------------------------------------------
// Mode dispatch: --stdio for IDE-managed lifetime, HTTP server otherwise
// ---------------------------------------------------------------------------

if (options.stdio) {
  const { startStdioServer } = await import("./stdio.js");
  await startStdioServer(client);
} else {
  const { startHttpServer } = await import("./http.js");
  startHttpServer(client, { port: options.port, host: options.host });
}
