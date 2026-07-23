/**
 * CLI parsing for the review-guard-mcp binary.
 *
 * Every flag is parsed and validated here, in one place, so the full flag set
 * is known and anything unexpected aborts startup instead of being silently
 * ignored. This matters for a safety boundary: a typo in a hardening flag
 * (e.g. the --repo/--pr scope) must fail loudly, never degrade to a less
 * restricted server.
 */

import type { PullRequestInput, SubmitAction } from "./github.js";

export interface CliOptions {
  /** Run the stdio transport instead of HTTP. */
  stdio: boolean;
  /** HTTP port. 0 lets the OS pick a free port. */
  port: number;
  /** HTTP bind address. Defaults to 127.0.0.1 (loopback only). */
  host: string;
  /** Actions the submit tool may use. Empty means submitting is disabled. */
  allowSubmit: SubmitAction[];
  /** Custom fixed review summary prefix (only valid with allowSubmit). */
  submitBody?: string;
  /** Enable resolving the authenticated user's own review threads. */
  allowResolve: boolean;
  /** Pin the server to a single PR. */
  scope?: PullRequestInput;
}

const VALUE_FLAGS = new Set([
  "--allow-submit",
  "--submit-body",
  "--repo",
  "--pr",
  "--port",
  "--host",
]);
const BOOLEAN_FLAGS = new Set(["--stdio", "--allow-resolve"]);

const VALID_SUBMIT_ACTIONS: SubmitAction[] = ["approve", "comment", "reject"];

/** Invalid CLI usage. The entry point prints the message and exits non-zero. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function fail(message: string): never {
  throw new CliUsageError(message);
}

export function parseCliOptions(argv: string[] = process.argv.slice(2)): CliOptions {
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const eqIndex = arg.indexOf("=");
    const name = eqIndex === -1 ? arg : arg.slice(0, eqIndex);

    if (BOOLEAN_FLAGS.has(name)) {
      if (eqIndex !== -1) fail(`${name} does not take a value.`);
      if (booleans.has(name)) fail(`Duplicate flag: ${name}`);
      booleans.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      if (values.has(name)) fail(`Duplicate flag: ${name}`);
      if (eqIndex !== -1) {
        values.set(name, arg.slice(eqIndex + 1));
      } else {
        // A following token that is itself an option is a missing value, not
        // a value that happens to start with "--". Use the "=" form for those.
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          fail(`Missing value for ${name} (use ${name}=<value> if the value starts with "--").`);
        }
        values.set(name, next);
        i++;
      }
    } else {
      fail(`Unknown flag: ${name}`);
    }
  }

  const allowSubmit = parseAllowSubmit(values.get("--allow-submit"));
  const submitBody = values.get("--submit-body");
  if (submitBody !== undefined && allowSubmit.length === 0) {
    fail("--submit-body requires --allow-submit.");
  }
  // An empty body would register the submit tool but make every call fail in
  // submitReview, so reject it up front instead of silently accepting it.
  if (submitBody !== undefined && submitBody.trim() === "") {
    fail("--submit-body must not be empty (omit it to use the default disclaimer).");
  }

  return {
    stdio: booleans.has("--stdio"),
    port: parsePort(values.get("--port")),
    host: parseHost(values.get("--host")),
    allowSubmit,
    submitBody,
    allowResolve: booleans.has("--allow-resolve"),
    scope: parseScope(values.get("--repo"), values.get("--pr")),
  };
}

function parseAllowSubmit(raw: string | undefined): SubmitAction[] {
  if (raw === undefined) return [];
  const actions = raw
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  const invalid = actions.filter((a) => !VALID_SUBMIT_ACTIONS.includes(a as SubmitAction));
  if (invalid.length > 0) {
    fail(
      `Invalid --allow-submit action(s): ${invalid.join(", ")}. ` +
        `Valid actions: ${VALID_SUBMIT_ACTIONS.join(", ")}.`,
    );
  }
  if (actions.length === 0) {
    fail(`--allow-submit must list at least one of: ${VALID_SUBMIT_ACTIONS.join(", ")}.`);
  }
  return [...new Set(actions as SubmitAction[])];
}

function parseScope(
  repoArg: string | undefined,
  prArg: string | undefined,
): PullRequestInput | undefined {
  if (repoArg === undefined && prArg === undefined) return undefined;
  if (repoArg === undefined || prArg === undefined) {
    fail("Scoping needs both --repo <owner/name> and --pr <number>.");
  }
  const parts = repoArg.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail(`Invalid --repo "${repoArg}", expected owner/name.`);
  }
  const pullNumber = Number(prArg);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    fail(`Invalid --pr "${prArg}", expected a positive integer.`);
  }
  return { owner: parts[0], repo: parts[1], pullNumber };
}

// The /mcp endpoint is unauthenticated, so an unspecified bind would expose it
// on every interface at once, and Node treats an empty host the same way.
// Require one concrete address instead.
const UNSPECIFIED_ADDRESSES = new Set(["0.0.0.0", "::", "[::]"]);

function parseHost(raw: string | undefined): string {
  if (raw === undefined) return "127.0.0.1";
  const host = raw.trim();
  if (host === "") {
    fail("--host must not be empty (omit it to bind 127.0.0.1).");
  }
  if (UNSPECIFIED_ADDRESSES.has(host)) {
    fail(`--host ${host} would bind all interfaces. Bind one specific address instead.`);
  }
  return host;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const p = parseInt(raw, 10);
  if (isNaN(p) || p < 0 || p > 65535) {
    fail(`Invalid port: ${raw}`);
  }
  return p;
}
