import { describe, expect, it, vi, type Mock } from "vitest";
import { GitHubApiError, GitHubReviewClient } from "../src/github.js";
import type { GitHubReviewClientOptions } from "../src/github.js";

const PR = { owner: "octo", repo: "hello", pullNumber: 1 };

type GqlMock = Mock<(query: string, vars?: unknown) => Promise<unknown>>;

/**
 * The client is exercised as a black box except for its two API entry points
 * (`gql` and `octokit`), which are replaced with mocks so the tests can
 * observe exactly which mutations the safety boundary lets through.
 */
function makeClient(
  options: GitHubReviewClientOptions = {},
  internals: { gql?: GqlMock; octokit?: OctokitStub } = {},
): { client: GitHubReviewClient; gql: GqlMock; octokit: OctokitStub } {
  const client = new GitHubReviewClient("test-token", options);
  const gql = internals.gql ?? vi.fn();
  const octokit = internals.octokit ?? makeOctokitStub();
  Object.assign(client as unknown as Record<string, unknown>, { gql, octokit });
  return { client, gql, octokit };
}

interface OctokitStub {
  users: { getAuthenticated: Mock };
  pulls: { listReviews: Mock };
  issues: { listComments: Mock };
}

function makeOctokitStub(login = "bot", reviews: unknown[] = []): OctokitStub {
  return {
    users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login } }) },
    pulls: { listReviews: vi.fn().mockResolvedValue({ data: reviews }) },
    issues: { listComments: vi.fn().mockResolvedValue({ data: [] }) },
  };
}

/** gql mock that dispatches on a substring of the query/mutation text. */
function gqlBySubstring(routes: Record<string, unknown>): GqlMock {
  return vi.fn((query: string, vars?: unknown) => {
    for (const [needle, result] of Object.entries(routes)) {
      if (query.includes(needle)) {
        return Promise.resolve(
          typeof result === "function" ? (result as (vars: unknown) => unknown)(vars) : result,
        );
      }
    }
    return Promise.reject(new Error(`Unexpected GraphQL query in test:\n${query}`));
  });
}

const PENDING_REVIEW_REST = { state: "PENDING", user: { login: "bot" }, node_id: "REV_1", id: 10 };

describe("submitReview safety gate", () => {
  it("refuses every action on a default (pending-mode) client", async () => {
    const { client, gql } = makeClient();
    await expect(client.submitReview({ ...PR, action: "comment" })).rejects.toThrow(/not allowed/);
    expect(gql).not.toHaveBeenCalled();
  });

  it("refuses actions outside the allowed set", async () => {
    const { client, gql } = makeClient({ allowSubmit: ["comment"], submitBody: "PREFIX" });
    await expect(client.submitReview({ ...PR, action: "approve" })).rejects.toThrow(
      /"approve" review is not allowed/,
    );
    expect(gql).not.toHaveBeenCalled();
  });

  it("refuses to submit without a configured submit body", async () => {
    const { client, gql } = makeClient({ allowSubmit: ["comment"] });
    await expect(client.submitReview({ ...PR, action: "comment" })).rejects.toThrow(
      /no submit body/,
    );
    expect(gql).not.toHaveBeenCalled();
  });

  function submitSetup(options: GitHubReviewClientOptions) {
    const gql = gqlBySubstring({
      "pullRequest(number: $number)": { repository: { pullRequest: { id: "PR_NODE" } } },
      submitPullRequestReview: {
        submitPullRequestReview: {
          pullRequestReview: { id: "REV_1", state: "COMMENTED", url: "https://example.test" },
        },
      },
    });
    const octokit = makeOctokitStub("bot", [PENDING_REVIEW_REST]);
    return makeClient(options, { gql, octokit });
  }

  function submitMutationVars(gql: GqlMock): Record<string, unknown> {
    const call = gql.mock.calls.find(([query]) => query.includes("submitPullRequestReview"));
    expect(call).toBeDefined();
    return (call![1] as { input: Record<string, unknown> }).input;
  }

  it("submits with the fixed body when no additional summary is given", async () => {
    const { client, gql } = submitSetup({ allowSubmit: ["comment"], submitBody: "PREFIX" });
    const result = await client.submitReview({ ...PR, action: "comment" });
    expect(result).toEqual({ id: "REV_1", state: "COMMENTED", url: "https://example.test" });
    const input = submitMutationVars(gql);
    expect(input.body).toBe("PREFIX");
    expect(input.event).toBe("COMMENT");
    expect(input.pullRequestReviewId).toBe("REV_1");
  });

  it("appends the caller summary below the fixed body, never replacing it", async () => {
    const { client, gql } = submitSetup({ allowSubmit: ["comment"], submitBody: "PREFIX" });
    await client.submitReview({ ...PR, action: "comment", additionalBody: "my summary" });
    expect(submitMutationVars(gql).body).toBe("PREFIX\n\nmy summary");
  });

  it("ignores a whitespace-only caller summary", async () => {
    const { client, gql } = submitSetup({ allowSubmit: ["comment"], submitBody: "PREFIX" });
    await client.submitReview({ ...PR, action: "comment", additionalBody: "  \n " });
    expect(submitMutationVars(gql).body).toBe("PREFIX");
  });

  it.each([
    ["approve", "APPROVE"],
    ["comment", "COMMENT"],
    ["reject", "REQUEST_CHANGES"],
  ] as const)("maps action %s to GitHub event %s", async (action, event) => {
    const { client, gql } = submitSetup({
      allowSubmit: ["approve", "comment", "reject"],
      submitBody: "PREFIX",
    });
    await client.submitReview({ ...PR, action });
    expect(submitMutationVars(gql).event).toBe(event);
  });

  it("creates an empty pending review first when none exists", async () => {
    const gql = gqlBySubstring({
      "pullRequest(number: $number)": { repository: { pullRequest: { id: "PR_NODE" } } },
      addPullRequestReview: {
        addPullRequestReview: { pullRequestReview: { id: "REV_NEW", state: "PENDING" } },
      },
      submitPullRequestReview: {
        submitPullRequestReview: {
          pullRequestReview: { id: "REV_NEW", state: "COMMENTED", url: null },
        },
      },
    });
    const { client } = makeClient(
      { allowSubmit: ["comment"], submitBody: "PREFIX" },
      { gql, octokit: makeOctokitStub("bot", []) },
    );
    const result = await client.submitReview({ ...PR, action: "comment" });
    expect(result.id).toBe("REV_NEW");
    expect(submitMutationVars(gql).pullRequestReviewId).toBe("REV_NEW");
  });
});

describe("deletePendingReview", () => {
  it("reports an explicit deletion flag, since GitHub returns the deleted node still as PENDING", async () => {
    const gql = gqlBySubstring({
      "node(id: $reviewId)": {
        node: {
          id: "REV_1",
          databaseId: 10,
          state: "PENDING",
          body: "",
          createdAt: "2026-01-01T00:00:00Z",
          author: { login: "bot" },
          comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
      // Real GitHub response: no DELETED state exists, the deleted node keeps
      // reporting PENDING. The client must not echo that as the result.
      deletePullRequestReview: {
        deletePullRequestReview: { pullRequestReview: { id: "REV_1", state: "PENDING" } },
      },
    });
    const { client } = makeClient(
      {},
      { gql, octokit: makeOctokitStub("bot", [PENDING_REVIEW_REST]) },
    );
    await expect(client.deletePendingReview(PR)).resolves.toEqual({ id: "REV_1", deleted: true });
  });
});

describe("PENDING post-mutation tripwire", () => {
  it("fails loudly and tells the agent to escalate when a created review is not PENDING", async () => {
    const gql = gqlBySubstring({
      "pullRequest(number: $number)": { repository: { pullRequest: { id: "PR_NODE" } } },
      addPullRequestReview: {
        addPullRequestReview: { pullRequestReview: { id: "REV_X", state: "COMMENTED" } },
      },
    });
    const { client } = makeClient({}, { gql });
    const call = client.addReviewComments({
      ...PR,
      comments: [{ path: "a.ts", body: "b", line: 1 }],
    });
    // The message is what the agent reads in the tool result, so it must both
    // flag the state and instruct the agent to report it to the human.
    await expect(call).rejects.toThrow(/SAFETY ALERT/);
    await expect(call).rejects.toThrow(/Report this error to the user/);
  });
});

describe("PR scoping", () => {
  const scoped: GitHubReviewClientOptions = { scope: PR };
  const otherPr = { owner: "octo", repo: "hello", pullNumber: 2 };
  const otherRepo = { owner: "evil", repo: "hello", pullNumber: 1 };

  it("refuses out-of-scope input on every PR-targeting method", async () => {
    const { client, gql } = makeClient({ ...scoped, allowSubmit: ["comment"], submitBody: "P" });
    for (const input of [otherPr, otherRepo]) {
      await expect(client.getPullRequestReviewContext(input)).rejects.toThrow(/scoped to/);
      await expect(client.listPendingReview(input)).rejects.toThrow(/scoped to/);
      await expect(
        client.addReviewComments({ ...input, comments: [{ path: "a", body: "b", line: 1 }] }),
      ).rejects.toThrow(/scoped to/);
      await expect(
        client.modifyReviewComment({ ...input, commentId: "C_1", action: "delete" }),
      ).rejects.toThrow(/scoped to/);
      await expect(client.deletePendingReview(input)).rejects.toThrow(/scoped to/);
      await expect(client.submitReview({ ...input, action: "comment" })).rejects.toThrow(
        /scoped to/,
      );
    }
    expect(gql).not.toHaveBeenCalled();
  });

  it("matches owner and repo case-insensitively", async () => {
    const { client } = makeClient(scoped);
    await expect(
      client.listPendingReview({ owner: "Octo", repo: "HELLO", pullNumber: 1 }),
    ).resolves.toBeNull();
  });
});

describe("resolveReviewThread safety gate", () => {
  function threadNode(overrides: Record<string, unknown> = {}) {
    return {
      isResolved: false,
      pullRequest: { number: 1, repository: { name: "hello", owner: { login: "octo" } } },
      comments: { nodes: [{ author: { login: "bot" } }] },
      ...overrides,
    };
  }

  it("refuses when resolving is not enabled", async () => {
    const { client, gql } = makeClient();
    await expect(client.resolveReviewThread("T_1")).rejects.toThrow(/not allowed/);
    expect(gql).not.toHaveBeenCalled();
  });

  it("refuses threads started by someone else", async () => {
    const gql = gqlBySubstring({
      "node(id: $threadId)": {
        node: threadNode({ comments: { nodes: [{ author: { login: "alice" } }] } }),
      },
    });
    const { client } = makeClient({ allowResolve: true }, { gql });
    await expect(client.resolveReviewThread("T_1")).rejects.toThrow(
      /not authored by the authenticated user/,
    );
    expect(gql).toHaveBeenCalledTimes(1); // lookup only, no mutation
  });

  it("resolves the authenticated user's own thread", async () => {
    const gql = gqlBySubstring({
      "node(id: $threadId)": { node: threadNode() },
      "resolveReviewThread(input": {
        resolveReviewThread: { thread: { id: "T_1", isResolved: true } },
      },
    });
    const { client } = makeClient({ allowResolve: true }, { gql });
    await expect(client.resolveReviewThread("T_1")).resolves.toEqual({
      id: "T_1",
      isResolved: true,
    });
  });

  it("is a no-op for an already resolved own thread", async () => {
    const gql = gqlBySubstring({
      "node(id: $threadId)": { node: threadNode({ isResolved: true }) },
    });
    const { client } = makeClient({ allowResolve: true }, { gql });
    await expect(client.resolveReviewThread("T_1")).resolves.toEqual({
      id: "T_1",
      isResolved: true,
    });
    expect(gql).toHaveBeenCalledTimes(1);
  });

  it("refuses threads on a different PR when scoped", async () => {
    const gql = gqlBySubstring({
      "node(id: $threadId)": {
        node: threadNode({
          pullRequest: { number: 99, repository: { name: "hello", owner: { login: "octo" } } },
        }),
      },
    });
    const { client } = makeClient({ allowResolve: true, scope: PR }, { gql });
    await expect(client.resolveReviewThread("T_1")).rejects.toThrow(/scoped to/);
  });

  it("fails for unknown thread ids", async () => {
    const gql = gqlBySubstring({ "node(id: $threadId)": { node: null } });
    const { client } = makeClient({ allowResolve: true }, { gql });
    await expect(client.resolveReviewThread("T_1")).rejects.toThrow(/not found/);
  });
});

describe("capability getters", () => {
  it("returns defensive copies", () => {
    const { client } = makeClient({ allowSubmit: ["comment"], scope: PR });
    client.allowedSubmitActions.push("approve");
    expect(client.allowedSubmitActions).toEqual(["comment"]);
    client.scopedPullRequest!.pullNumber = 999;
    expect(client.scopedPullRequest).toEqual(PR);
  });

  it("errors are GitHubApiError instances", async () => {
    const { client } = makeClient();
    await expect(client.submitReview({ ...PR, action: "comment" })).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});
