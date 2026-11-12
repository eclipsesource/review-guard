/**
 * Manual integration suite. Drives every MCP tool against a real GitHub
 * repository and verifies the results with direct API reads that do not go
 * through the code under test.
 *
 * This is the one place where the project's assumptions about GitHub's real
 * behavior are checked: that omitting `event` really yields a PENDING review,
 * that drafts are invisible to other users, that the disclaimer prefix
 * survives submission, and that reaction and resolution data comes back in
 * the expected shape.
 *
 * Setup (see CONTRIBUTING.md): a private throwaway repository and two GitHub
 * accounts with write access to it. The reviewer account is the one under
 * test. The author account creates the pull request, plants a foreign review
 * thread, adds reactions, and answers the reviewer's finding.
 *
 * Required environment variables:
 *   REVIEW_GUARD_TEST_REPO            owner/name of the test repository
 *   REVIEW_GUARD_TEST_TOKEN_REVIEWER  token of the reviewer account under test
 *   REVIEW_GUARD_TEST_TOKEN_AUTHOR    token of the account that authors the PR
 *
 * The steps form one scenario and run in file order. Later steps build on
 * earlier ones, so a failure cascades. The suite cleans up after itself and
 * removes leftovers of crashed runs at startup. Set REVIEW_GUARD_TEST_KEEP=1
 * to keep the pull request and branch for inspection.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { createMcpServer } from "../../src/server.js";
import { GitHubReviewClient } from "../../src/github.js";
import type {
  AddReviewCommentsResult,
  GitHubReviewClientOptions,
  ModifyReviewCommentResult,
  PendingReview,
  PullRequestReviewContext,
  ReplyToReviewThreadsResult,
  ReviewComment,
} from "../../src/github.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface ItestConfig {
  owner: string;
  repo: string;
  reviewerToken: string;
  authorToken: string;
}

function readConfig(): ItestConfig {
  const repoSlug = process.env.REVIEW_GUARD_TEST_REPO;
  const reviewerToken = process.env.REVIEW_GUARD_TEST_TOKEN_REVIEWER;
  const authorToken = process.env.REVIEW_GUARD_TEST_TOKEN_AUTHOR;
  const missing = [
    ...(repoSlug ? [] : ["REVIEW_GUARD_TEST_REPO (owner/name of a private throwaway repository)"]),
    ...(reviewerToken
      ? []
      : ["REVIEW_GUARD_TEST_TOKEN_REVIEWER (token of the reviewer account under test)"]),
    ...(authorToken
      ? []
      : ["REVIEW_GUARD_TEST_TOKEN_AUTHOR (token of the account that authors the PR)"]),
  ];
  if (missing.length > 0) {
    throw new Error(
      "Integration test setup is incomplete. Missing environment variables:\n" +
        missing.map((name) => `  - ${name}`).join("\n") +
        "\nSee the integration test section in CONTRIBUTING.md for the full setup.",
    );
  }
  const parts = (repoSlug as string).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid REVIEW_GUARD_TEST_REPO "${repoSlug}", expected owner/name.`);
  }
  return {
    owner: parts[0],
    repo: parts[1],
    reviewerToken: reviewerToken as string,
    authorToken: authorToken as string,
  };
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const BRANCH_PREFIX = "review-guard-itest-";
const RUN_ID = Date.now().toString(36);

const DISCLAIMER = "ReviewGuard integration test disclaimer. Posted by the manual test suite.";
const DRAFT_LINE_BODY = `Draft line comment ${RUN_ID}`;
const DRAFT_FILE_BODY = `Draft file comment ${RUN_ID}`;
const UPDATED_BODY = `Updated draft comment ${RUN_ID}`;
const FINDING_BODY = `Integration test finding ${RUN_ID}`;
const SUMMARY_BODY = `Integration test summary ${RUN_ID}`;
const FOREIGN_BODY = `Foreign thread comment ${RUN_ID}`;
const AUTHOR_REPLY_BODY = `Author reply to the finding ${RUN_ID}`;
const OWN_REPLY_BODY = `Reply on the reviewer's own thread ${RUN_ID}`;
const UPDATED_OWN_REPLY_BODY = `Updated reply on the reviewer's own thread ${RUN_ID}`;
const FOREIGN_REPLY_BODY = `Reply on the foreign thread ${RUN_ID}`;

const FILE_CONTENT = [
  "# ReviewGuard integration test fixture",
  "",
  "alpha",
  "beta",
  "gamma",
  "",
].join("\n");

const BASE_TOOLS = [
  "add_review_comments",
  "delete_pending_review",
  "get_pr_review_context",
  "list_pending_review",
  "modify_review_comment",
  "reply_to_review_threads",
];

/** Polls a check until it stops throwing, for GitHub read-after-write lag. */
async function eventually<T>(description: string, check: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(
    `Timed out waiting for ${description}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/** Boots an MCP server over an in-memory transport, backed by the real API. */
async function connectServer(token: string, options: GitHubReviewClientOptions): Promise<Client> {
  const reviewClient = new GitHubReviewClient(token, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "itest-client", version: "0.0.0" });
  await Promise.all([
    createMcpServer(reviewClient).connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
  return mcpClient;
}

async function callTool<T>(
  mcpClient: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await mcpClient.callTool({ name, arguments: args });
  const [content] = result.content as [{ type: string; text: string }];
  if (result.isError) {
    throw new Error(`Tool ${name} failed: ${content.text}`);
  }
  return JSON.parse(content.text) as T;
}

async function callToolExpectError(
  mcpClient: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await mcpClient.callTool({ name, arguments: args });
  const [content] = result.content as [{ type: string; text: string }];
  expect(result.isError, `expected tool ${name} to fail but it returned: ${content.text}`).toBe(
    true,
  );
  return content.text;
}

// ---------------------------------------------------------------------------
// Shared scenario state, populated in beforeAll and by earlier steps
// ---------------------------------------------------------------------------

let config: ItestConfig;
let reviewerOctokit: Octokit;
let authorOctokit: Octokit;
let authorGql: typeof graphql;
let reviewerLogin: string;
let authorLogin: string;

let branch: string;
let filePath: string;
let pullNumber: number;
let headSha: string;

let pendingTools: Client;
let submitTools: Client;
let scopedTools: Client;

let draftComments: ReviewComment[];
let findingCommentId: number;
let ownThreadId: string;
let foreignThreadId: string;
let draftReplies: ReviewComment[];
/** Permalink the finding carried while it was still a draft. */
let draftFindingUrl: string | null;

function target(): { owner: string; repo: string; pull_number: number } {
  return { owner: config.owner, repo: config.repo, pull_number: pullNumber };
}

async function fetchThread(
  threadId: string,
): Promise<{ isResolved: boolean; resolvedBy: string | null }> {
  const response = await authorGql<{
    node: { isResolved: boolean; resolvedBy: { login: string } | null } | null;
  }>(
    `query($id: ID!) {
      node(id: $id) {
        ... on PullRequestReviewThread { isResolved resolvedBy { login } }
      }
    }`,
    { id: threadId },
  );
  if (!response.node) throw new Error(`Thread ${threadId} not found on GitHub`);
  return {
    isResolved: response.node.isResolved,
    resolvedBy: response.node.resolvedBy?.login ?? null,
  };
}

interface ThreadCommentView {
  id: string;
  author: string | null;
  body: string;
  url: string;
  replyTo: string | null;
}

/** The thread's comments as the author account sees them. */
async function fetchThreadComments(threadId: string): Promise<ThreadCommentView[]> {
  const response = await authorGql<{
    node: {
      comments: {
        nodes: {
          id: string;
          author: { login: string } | null;
          body: string;
          url: string;
          replyTo: { id: string } | null;
        }[];
      };
    } | null;
  }>(
    `query($id: ID!) {
      node(id: $id) {
        ... on PullRequestReviewThread {
          comments(first: 100) { nodes { id author { login } body url replyTo { id } } }
        }
      }
    }`,
    { id: threadId },
  );
  if (!response.node) throw new Error(`Thread ${threadId} not found on GitHub`);
  return response.node.comments.nodes.map((comment) => ({
    id: comment.id,
    author: comment.author?.login ?? null,
    body: comment.body,
    url: comment.url,
    replyTo: comment.replyTo?.id ?? null,
  }));
}

async function closeLeftovers(): Promise<void> {
  const { owner, repo } = config;
  const { data: openPrs } = await authorOctokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 100,
  });
  for (const pr of openPrs) {
    if (!pr.head.ref.startsWith(BRANCH_PREFIX)) continue;
    await authorOctokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pr.number,
      state: "closed",
    });
  }
  const { data: refs } = await authorOctokit.rest.git.listMatchingRefs({
    owner,
    repo,
    ref: `heads/${BRANCH_PREFIX}`,
  });
  for (const ref of refs) {
    await authorOctokit.rest.git.deleteRef({ owner, repo, ref: ref.ref.replace(/^refs\//, "") });
  }
}

beforeAll(async () => {
  config = readConfig();
  const { owner, repo } = config;

  reviewerOctokit = new Octokit({ auth: config.reviewerToken });
  authorOctokit = new Octokit({ auth: config.authorToken });
  authorGql = graphql.defaults({
    headers: { authorization: `token ${config.authorToken}` },
  });

  reviewerLogin = (await reviewerOctokit.rest.users.getAuthenticated()).data.login;
  authorLogin = (await authorOctokit.rest.users.getAuthenticated()).data.login;
  if (reviewerLogin === authorLogin) {
    throw new Error(
      `Both tokens belong to "${reviewerLogin}". The suite needs two different accounts, ` +
        "several checks rely on a second user (draft invisibility, foreign threads, reactions).",
    );
  }

  await closeLeftovers();

  // The author account creates the pull request, matching the real usage
  // pattern where the reviewer account reviews someone else's PR.
  const { data: repoInfo } = await authorOctokit.rest.repos.get({ owner, repo });
  const baseBranch = repoInfo.default_branch;
  const { data: baseRef } = await authorOctokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });
  branch = `${BRANCH_PREFIX}${RUN_ID}`;
  await authorOctokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.object.sha,
  });
  filePath = `itest/${RUN_ID}.md`;
  await authorOctokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `Add integration test fixture ${RUN_ID}`,
    content: Buffer.from(FILE_CONTENT).toString("base64"),
    branch,
  });
  const { data: pr } = await authorOctokit.rest.pulls.create({
    owner,
    repo,
    title: `ReviewGuard integration test ${RUN_ID}`,
    head: branch,
    base: baseBranch,
    body: "Created by the ReviewGuard manual integration suite. Safe to close.",
  });
  pullNumber = pr.number;
  headSha = pr.head.sha;

  // Three server configurations, all backed by the reviewer token.
  pendingTools = await connectServer(config.reviewerToken, {});
  submitTools = await connectServer(config.reviewerToken, {
    allowSubmit: ["comment"],
    submitBody: DISCLAIMER,
    allowResolve: true,
  });
  scopedTools = await connectServer(config.reviewerToken, {
    scope: { owner, repo, pullNumber },
  });
});

afterAll(async () => {
  if (!config || !branch) return;
  if (process.env.REVIEW_GUARD_TEST_KEEP) {
    console.log(`Keeping PR #${pullNumber} and branch ${branch} for inspection.`);
    return;
  }
  const { owner, repo } = config;
  try {
    if (pullNumber) {
      await authorOctokit.rest.pulls.update({
        owner,
        repo,
        pull_number: pullNumber,
        state: "closed",
      });
    }
    await authorOctokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
  } catch (error) {
    console.error(
      `Cleanup failed, the next run will retry it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
});

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

describe("ReviewGuard against a real repository", () => {
  it("registers the expected tools per server configuration", async () => {
    const pendingNames = (await pendingTools.listTools()).tools.map((tool) => tool.name).sort();
    expect(pendingNames).toEqual(BASE_TOOLS);

    const submitList = (await submitTools.listTools()).tools;
    const submitNames = submitList.map((tool) => tool.name);
    expect(submitNames).toEqual(expect.arrayContaining(["submit", "resolve_review_thread"]));
    const submit = submitList.find((tool) => tool.name === "submit");
    const action = (submit!.inputSchema.properties as Record<string, { enum?: string[] }>).action;
    expect(action.enum).toEqual(["comment"]);
  });

  it("get_pr_review_context returns the fresh pull request", async () => {
    const context = await eventually("the new PR to be readable through the tool", () =>
      callTool<PullRequestReviewContext>(pendingTools, "get_pr_review_context", target()),
    );
    expect(context.pullRequest.number).toBe(pullNumber);
    expect(context.pullRequest.author?.login).toBe(authorLogin);
    expect(context.pullRequest.title).toContain(RUN_ID);
    expect(context.reviews).toHaveLength(0);
    expect(context.threads).toHaveLength(0);
  });

  it("add_review_comments creates a PENDING draft review", async () => {
    const result = await callTool<AddReviewCommentsResult>(pendingTools, "add_review_comments", {
      ...target(),
      comments: [
        { path: filePath, body: DRAFT_LINE_BODY, line: 3 },
        { path: filePath, body: DRAFT_FILE_BODY, subject_type: "FILE" },
      ],
    });
    expect(result.review.state).toBe("PENDING");
    expect(result.addedComments).toHaveLength(2);
    draftComments = result.addedComments;

    await eventually("the pending review to appear for the reviewer account", async () => {
      const { data } = await reviewerOctokit.rest.pulls.listReviews(target());
      const pending = data.filter(
        (review) => review.state === "PENDING" && review.user?.login === reviewerLogin,
      );
      expect(pending).toHaveLength(1);
    });
  });

  it("keeps the draft invisible to other users and out of the submitted context", async () => {
    const { data: seenByAuthor } = await authorOctokit.rest.pulls.listReviews(target());
    expect(seenByAuthor.filter((review) => review.user?.login === reviewerLogin)).toHaveLength(0);

    // The draft is invisible at comment level too, not just as a review.
    const { data: commentsSeenByAuthor } =
      await authorOctokit.rest.pulls.listReviewComments(target());
    expect(commentsSeenByAuthor.filter((comment) => comment.body === DRAFT_LINE_BODY)).toHaveLength(
      0,
    );

    const context = await callTool<PullRequestReviewContext>(
      pendingTools,
      "get_pr_review_context",
      target(),
    );
    expect(context.reviews).toHaveLength(0);
    expect(context.threads).toHaveLength(0);
  });

  it("list_pending_review returns the draft with its comments", async () => {
    const review = await callTool<PendingReview>(pendingTools, "list_pending_review", target());
    expect(review).not.toBeNull();
    expect(review.state).toBe("PENDING");
    expect(review.comments.map((comment) => comment.body).sort()).toEqual(
      [DRAFT_FILE_BODY, DRAFT_LINE_BODY].sort(),
    );
    // A draft comment already carries a permalink, so an agent can cross-link
    // its own findings while drafting. That the link survives submission is
    // asserted further down.
    for (const comment of review.comments) {
      expect(comment.url).toContain(`/pull/${pullNumber}#discussion_r`);
      expect(comment.replyTo).toBeNull();
    }
  });

  it("modify_review_comment updates a draft comment", async () => {
    const result = await callTool<ModifyReviewCommentResult>(
      pendingTools,
      "modify_review_comment",
      { ...target(), comment_id: draftComments[0].id, action: "update", body: UPDATED_BODY },
    );
    expect(result.action).toBe("updated");

    const review = await callTool<PendingReview>(pendingTools, "list_pending_review", target());
    expect(review.comments.map((comment) => comment.body)).toContain(UPDATED_BODY);
  });

  it("modify_review_comment deletes a draft comment", async () => {
    const result = await callTool<ModifyReviewCommentResult>(
      pendingTools,
      "modify_review_comment",
      { ...target(), comment_id: draftComments[1].id, action: "delete" },
    );
    expect(result.action).toBe("deleted");

    const review = await callTool<PendingReview>(pendingTools, "list_pending_review", target());
    expect(review.comments).toHaveLength(1);
  });

  it("delete_pending_review removes the draft entirely", async () => {
    const result = await callTool<{ deleted: boolean }>(
      pendingTools,
      "delete_pending_review",
      target(),
    );
    expect(result.deleted).toBe(true);

    const review = await callTool<PendingReview | null>(
      pendingTools,
      "list_pending_review",
      target(),
    );
    expect(review).toBeNull();

    await eventually("the pending review to disappear on GitHub", async () => {
      const { data } = await reviewerOctokit.rest.pulls.listReviews(target());
      expect(data.filter((entry) => entry.state === "PENDING")).toHaveLength(0);
    });
  });

  it("submit posts the review with the fixed disclaimer prefix", async () => {
    const draft = await callTool<AddReviewCommentsResult>(submitTools, "add_review_comments", {
      ...target(),
      comments: [{ path: filePath, body: FINDING_BODY, line: 3 }],
    });
    draftFindingUrl = draft.addedComments[0].url;
    expect(draftFindingUrl).toContain(`/pull/${pullNumber}#discussion_r`);

    const submitted = await callTool<{ id: string; state: string }>(submitTools, "submit", {
      ...target(),
      action: "comment",
      summary: SUMMARY_BODY,
    });
    expect(submitted.state).toBe("COMMENTED");

    await eventually("the submitted review to be visible to the author account", async () => {
      const { data } = await authorOctokit.rest.pulls.listReviews(target());
      const review = data.find(
        (entry) => entry.user?.login === reviewerLogin && entry.state === "COMMENTED",
      );
      expect(review).toBeDefined();
      expect(review!.body.startsWith(DISCLAIMER)).toBe(true);
      expect(review!.body).toContain(SUMMARY_BODY);
      expect(review!.body.indexOf(DISCLAIMER)).toBeLessThan(review!.body.indexOf(SUMMARY_BODY));
    });
  });

  it("shows the submitted thread in context, including reactions from others", async () => {
    findingCommentId = await eventually("the submitted inline comment to be visible", async () => {
      const { data } = await authorOctokit.rest.pulls.listReviewComments(target());
      const comment = data.find(
        (entry) => entry.user?.login === reviewerLogin && entry.body === FINDING_BODY,
      );
      expect(comment).toBeDefined();
      return comment!.id;
    });
    await authorOctokit.rest.reactions.createForPullRequestReviewComment({
      owner: config.owner,
      repo: config.repo,
      comment_id: findingCommentId,
      content: "-1",
    });

    ownThreadId = await eventually("the thread and reaction to appear in the context", async () => {
      const context = await callTool<PullRequestReviewContext>(
        pendingTools,
        "get_pr_review_context",
        target(),
      );
      const thread = context.threads.find((entry) => entry.comments[0]?.body === FINDING_BODY);
      expect(thread).toBeDefined();
      expect(thread!.comments[0].author).toBe(reviewerLogin);
      expect(thread!.isResolved).toBe(false);
      expect(thread!.comments[0].reactions?.THUMBS_DOWN).toBe(1);
      expect(thread!.comments[0].url).toContain(`/pull/${pullNumber}#discussion_r`);
      // The permalink handed out while the comment was a draft is the one it
      // keeps once submitted, which is what makes citing a pending comment safe.
      expect(thread!.comments[0].url).toBe(draftFindingUrl);
      return thread!.id;
    });
  });

  it("resolve_review_thread resolves the reviewer's own thread", async () => {
    const result = await callTool<{ isResolved: boolean }>(submitTools, "resolve_review_thread", {
      thread_id: ownThreadId,
    });
    expect(result.isResolved).toBe(true);

    await eventually("the thread to show as resolved on GitHub", async () => {
      const thread = await fetchThread(ownThreadId);
      expect(thread.isResolved).toBe(true);
      expect(thread.resolvedBy).toBe(reviewerLogin);
    });
  });

  it("resolve_review_thread refuses a thread started by someone else", async () => {
    await authorOctokit.rest.pulls.createReviewComment({
      ...target(),
      body: FOREIGN_BODY,
      commit_id: headSha,
      path: filePath,
      line: 4,
      side: "RIGHT",
    });
    foreignThreadId = await eventually("the foreign thread to appear in context", async () => {
      const context = await callTool<PullRequestReviewContext>(
        pendingTools,
        "get_pr_review_context",
        target(),
      );
      const thread = context.threads.find((entry) => entry.comments[0]?.body === FOREIGN_BODY);
      expect(thread).toBeDefined();
      expect(thread!.comments[0].author).toBe(authorLogin);
      return thread!.id;
    });

    const message = await callToolExpectError(submitTools, "resolve_review_thread", {
      thread_id: foreignThreadId,
    });
    expect(message).toMatch(/Refusing to resolve/);
    expect(message).toContain(authorLogin);

    const thread = await fetchThread(foreignThreadId);
    expect(thread.isResolved).toBe(false);
  });

  it("reply_to_review_threads refuses a thread from a different pull request", async () => {
    const message = await callToolExpectError(pendingTools, "reply_to_review_threads", {
      ...target(),
      pull_number: pullNumber + 1,
      replies: [{ thread_id: ownThreadId, body: OWN_REPLY_BODY }],
    });
    expect(message).toContain(`belongs to ${config.owner}/${config.repo}#${pullNumber}`);
    expect(message).toMatch(/Refusing to reply/);
  });

  it("reply_to_review_threads drafts replies on own and foreign threads", async () => {
    // The usual re-review situation: the author answers the reviewer's finding.
    await authorOctokit.rest.pulls.createReplyForReviewComment({
      ...target(),
      comment_id: findingCommentId,
      body: AUTHOR_REPLY_BODY,
    });
    const context = await eventually("the author's reply to appear in the context", async () => {
      const context = await callTool<PullRequestReviewContext>(
        pendingTools,
        "get_pr_review_context",
        target(),
      );
      const thread = context.threads.find((entry) => entry.id === ownThreadId);
      expect(thread?.comments.map((comment) => comment.body)).toEqual([
        FINDING_BODY,
        AUTHOR_REPLY_BODY,
      ]);
      expect(thread!.comments[1].replyTo).toBe(thread!.comments[0].id);
      return context;
    });
    const firstCommentOf = (threadId: string) =>
      context.threads.find((entry) => entry.id === threadId)?.comments[0]?.id;

    const result = await callTool<ReplyToReviewThreadsResult>(
      pendingTools,
      "reply_to_review_threads",
      {
        ...target(),
        replies: [
          { thread_id: ownThreadId, body: OWN_REPLY_BODY },
          { thread_id: foreignThreadId, body: FOREIGN_REPLY_BODY },
        ],
      },
    );
    expect(result.review.state).toBe("PENDING");
    expect(result.addedReplies.map((reply) => reply.body)).toEqual([
      OWN_REPLY_BODY,
      FOREIGN_REPLY_BODY,
    ]);
    expect(result.addedReplies.map((reply) => reply.replyTo)).toEqual([
      firstCommentOf(ownThreadId),
      firstCommentOf(foreignThreadId),
    ]);
    for (const reply of result.addedReplies) {
      expect(reply.author).toBe(reviewerLogin);
      expect(reply.pullRequestReview?.id).toBe(result.review.id);
      expect(reply.pullRequestReview?.state).toBe("PENDING");
      expect(reply.url).toContain(`/pull/${pullNumber}#discussion_r`);
    }
    expect(result.review.comments.map((comment) => comment.id).sort()).toEqual(
      result.addedReplies.map((reply) => reply.id).sort(),
    );
    draftReplies = result.addedReplies;
  });

  it("keeps draft replies invisible to other users and out of the submitted context", async () => {
    const draftBodies = [OWN_REPLY_BODY, FOREIGN_REPLY_BODY];

    const { data: reviewsSeenByAuthor } = await authorOctokit.rest.pulls.listReviews(target());
    expect(reviewsSeenByAuthor.filter((review) => review.state === "PENDING")).toHaveLength(0);

    const { data: commentsSeenByAuthor } =
      await authorOctokit.rest.pulls.listReviewComments(target());
    expect(
      commentsSeenByAuthor.filter((comment) => draftBodies.includes(comment.body)),
    ).toHaveLength(0);

    expect((await fetchThreadComments(ownThreadId)).map((comment) => comment.body)).toEqual([
      FINDING_BODY,
      AUTHOR_REPLY_BODY,
    ]);
    expect((await fetchThreadComments(foreignThreadId)).map((comment) => comment.body)).toEqual([
      FOREIGN_BODY,
    ]);

    const context = await callTool<PullRequestReviewContext>(
      pendingTools,
      "get_pr_review_context",
      target(),
    );
    const contextBodies = context.threads.flatMap((thread) =>
      thread.comments.map((comment) => comment.body),
    );
    expect(contextBodies.filter((body) => draftBodies.includes(body))).toHaveLength(0);
  });

  it("list_pending_review and modify_review_comment handle draft replies", async () => {
    const review = await callTool<PendingReview>(pendingTools, "list_pending_review", target());
    expect(review.comments.map((comment) => comment.body).sort()).toEqual(
      [FOREIGN_REPLY_BODY, OWN_REPLY_BODY].sort(),
    );
    for (const comment of review.comments) {
      expect(comment.replyTo).not.toBeNull();
    }

    const result = await callTool<ModifyReviewCommentResult>(
      pendingTools,
      "modify_review_comment",
      {
        ...target(),
        comment_id: draftReplies[0].id,
        action: "update",
        body: UPDATED_OWN_REPLY_BODY,
      },
    );
    expect(result.action).toBe("updated");
    expect(result.comment.body).toBe(UPDATED_OWN_REPLY_BODY);
    expect(result.comment.replyTo).toBe(draftReplies[0].replyTo);
    expect(result.comment.pullRequestReview?.state).toBe("PENDING");
  });

  it("submit posts the replies into their original threads", async () => {
    const submitted = await callTool<{ state: string }>(submitTools, "submit", {
      ...target(),
      action: "comment",
    });
    expect(submitted.state).toBe("COMMENTED");

    await eventually("the replies to appear in their threads for the author account", async () => {
      const own = await fetchThreadComments(ownThreadId);
      expect(own.map((comment) => [comment.author, comment.body])).toEqual([
        [reviewerLogin, FINDING_BODY],
        [authorLogin, AUTHOR_REPLY_BODY],
        [reviewerLogin, UPDATED_OWN_REPLY_BODY],
      ]);
      const foreign = await fetchThreadComments(foreignThreadId);
      expect(foreign.map((comment) => [comment.author, comment.body])).toEqual([
        [authorLogin, FOREIGN_BODY],
        [reviewerLogin, FOREIGN_REPLY_BODY],
      ]);
      expect(own[2].replyTo).toBe(own[0].id);
      expect(foreign[1].replyTo).toBe(foreign[0].id);
      // As with new threads, a reply keeps the permalink it had as a draft.
      expect(own[2].url).toBe(draftReplies[0].url);
      expect(foreign[1].url).toBe(draftReplies[1].url);
    });
  });

  it("a scoped server acts on its pull request implicitly", async () => {
    const context = await callTool<PullRequestReviewContext>(
      scopedTools,
      "get_pr_review_context",
      {},
    );
    expect(context.pullRequest.number).toBe(pullNumber);
  });
});
