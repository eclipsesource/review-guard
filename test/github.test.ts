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

describe("permalinks", () => {
  function contextGql(commentNodes: unknown[]) {
    return gqlBySubstring({
      "reviewThreads(first: 100": {
        repository: {
          pullRequest: {
            id: "PR_NODE",
            number: 1,
            title: "t",
            body: "b",
            author: { login: "alice" },
            url: "https://github.com/octo/hello/pull/1",
            state: "OPEN",
            isDraft: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            baseRefName: "main",
            headRefName: "feature",
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "T_1",
                  path: "a.ts",
                  line: 3,
                  diffSide: "RIGHT",
                  subjectType: "LINE",
                  isResolved: false,
                  isOutdated: false,
                  isCollapsed: false,
                  comments: {
                    totalCount: commentNodes.length,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: commentNodes,
                  },
                },
              ],
            },
          },
        },
      },
    });
  }

  const commentNode = (id: string, url: string, reviewState = "COMMENTED") => ({
    id,
    url,
    body: `body of ${id}`,
    path: "a.ts",
    line: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    author: { login: "bot" },
    pullRequestReview: {
      id: "REV_1",
      databaseId: 10,
      state: reviewState,
      author: { login: "bot" },
    },
  });
  const submitted = (id: string, url: string) => commentNode(id, url);
  const draft = (id: string, url: string) => commentNode(id, url, "PENDING");

  const DISCUSSION_URL = "https://github.com/octo/hello/pull/1#discussion_r1";

  it("exposes each thread comment's permalink", async () => {
    const { client } = makeClient(
      {},
      {
        gql: contextGql([
          submitted("C_1", DISCUSSION_URL),
          submitted("C_2", "https://github.com/octo/hello/pull/1#discussion_r2"),
        ]),
      },
    );

    const context = await client.getPullRequestReviewContext(PR);
    expect(context.threads).toHaveLength(1);
    expect(context.threads[0].comments.map((comment) => comment.url)).toEqual([
      DISCUSSION_URL,
      "https://github.com/octo/hello/pull/1#discussion_r2",
    ]);
  });

  // The pending path is the one an agent uses to quote its own drafts, and the
  // `?? null` fallback in the mapper would let a dropped `url` selection
  // degrade silently, so it gets its own assertion.
  it("marks pending replies with their thread's first comment", async () => {
    const gql = gqlBySubstring({
      "node(id: $reviewId)": {
        node: {
          id: "REV_1",
          databaseId: 10,
          state: "PENDING",
          body: "",
          createdAt: "2026-01-01T00:00:00Z",
          author: { login: "bot" },
          comments: {
            totalCount: 2,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              draft("C_NEW", DISCUSSION_URL),
              { ...draft("C_REPLY", DISCUSSION_URL), replyTo: { id: "C_ROOT" } },
            ],
          },
        },
      },
    });
    const { client } = makeClient(
      {},
      { gql, octokit: makeOctokitStub("bot", [PENDING_REVIEW_REST]) },
    );

    const review = await client.listPendingReview(PR);
    expect(review?.comments.map((comment) => comment.replyTo)).toEqual([null, "C_ROOT"]);
    // The mapper falls back to null, which reads as "starts a thread", so a
    // dropped selection would mislabel every reply.
    expect(gql.mock.calls[0][0]).toContain("replyTo { id }");
  });

  it("exposes each pending review comment's permalink", async () => {
    const gql = gqlBySubstring({
      "node(id: $reviewId)": {
        node: {
          id: "REV_1",
          databaseId: 10,
          state: "PENDING",
          body: "",
          createdAt: "2026-01-01T00:00:00Z",
          author: { login: "bot" },
          comments: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [draft("C_1", DISCUSSION_URL)],
          },
        },
      },
    });
    const { client } = makeClient(
      {},
      { gql, octokit: makeOctokitStub("bot", [PENDING_REVIEW_REST]) },
    );

    const review = await client.listPendingReview(PR);
    expect(review?.comments.map((comment) => comment.url)).toEqual([DISCUSSION_URL]);
  });

  // The REST-sourced fields spell the permalink `html_url`, but the output shape
  // normalizes every one of them to `url`.
  it("exposes review summary and conversation comment permalinks as url", async () => {
    const REVIEW_URL = "https://github.com/octo/hello/pull/1#pullrequestreview-10";
    const PR_COMMENT_URL = "https://github.com/octo/hello/pull/1#issuecomment-20";
    const octokit = makeOctokitStub("bot", [
      {
        state: "COMMENTED",
        node_id: "REV_1",
        id: 10,
        user: { login: "alice" },
        body: "looks good",
        submitted_at: "2026-01-01T00:00:00Z",
        commit_id: "abc123",
        html_url: REVIEW_URL,
        author_association: "MEMBER",
      },
    ]);
    octokit.issues.listComments.mockResolvedValue({
      data: [
        {
          node_id: "IC_1",
          id: 20,
          user: { login: "alice" },
          body: "ping",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          html_url: PR_COMMENT_URL,
          author_association: "MEMBER",
        },
      ],
    });
    const { client } = makeClient({}, { gql: contextGql([]), octokit });

    const context = await client.getPullRequestReviewContext(PR);
    expect(context.reviews.map((review) => review.url)).toEqual([REVIEW_URL]);
    expect(context.prComments.map((comment) => comment.url)).toEqual([PR_COMMENT_URL]);
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

/** A review thread node as returned by the reply thread lookup. */
function threadOn(pr: { owner: string; repo: string; number: number }) {
  return {
    pullRequest: { number: pr.number, repository: { name: pr.repo, owner: { login: pr.owner } } },
    // Never selected by the lookup. Present so that an added own-thread check
    // would see a foreign author and fail the tests below.
    comments: { nodes: [{ author: { login: "alice" } }] },
  };
}
const THREAD_ON_PR = threadOn({ owner: "octo", repo: "hello", number: 1 });

function replySetup(
  options: {
    threads?: unknown[];
    replyState?: string;
    reviews?: unknown[];
    clientOptions?: GitHubReviewClientOptions;
  } = {},
) {
  const gql = gqlBySubstring({
    "nodes(ids: $ids)": { nodes: options.threads ?? [THREAD_ON_PR] },
    "pullRequest(number: $number)": { repository: { pullRequest: { id: "PR_NODE" } } },
    // Listed before addPullRequestReview, which is a prefix of this mutation's name.
    addPullRequestReviewThreadReply: (vars: unknown) => {
      const input = (vars as { input: Record<string, string> }).input;
      return {
        addPullRequestReviewThreadReply: {
          comment: {
            id: `C_${input.pullRequestReviewThreadId}`,
            url: `https://github.com/octo/hello/pull/1#discussion_r${input.pullRequestReviewThreadId}`,
            body: input.body,
            path: "a.ts",
            line: 3,
            author: { login: "bot" },
            replyTo: { id: `ROOT_${input.pullRequestReviewThreadId}` },
            pullRequestReview: {
              id: input.pullRequestReviewId,
              databaseId: 10,
              state: options.replyState ?? "PENDING",
              author: { login: "bot" },
            },
          },
        },
      };
    },
    addPullRequestReview: {
      addPullRequestReview: { pullRequestReview: { id: "REV_NEW", state: "PENDING" } },
    },
    "node(id: $reviewId)": (vars: unknown) => ({
      node: {
        id: (vars as { reviewId: string }).reviewId,
        databaseId: 10,
        state: "PENDING",
        body: "",
        createdAt: "2026-01-01T00:00:00Z",
        author: { login: "bot" },
        comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
    }),
  });
  const octokit = makeOctokitStub("bot", options.reviews ?? [PENDING_REVIEW_REST]);
  return makeClient(options.clientOptions ?? {}, { gql, octokit });
}

function replyMutationInputs(gql: GqlMock): Record<string, unknown>[] {
  return gql.mock.calls
    .filter(([query]) => query.includes("addPullRequestReviewThreadReply"))
    .map(([, vars]) => (vars as { input: Record<string, unknown> }).input);
}

function writeCalls(gql: GqlMock): string[] {
  return gql.mock.calls.map(([query]) => query).filter((query) => query.includes("mutation"));
}

describe("replyToReviewThreads", () => {
  it("adds replies to any thread of the PR within the existing pending review", async () => {
    const { client, gql } = replySetup({ threads: [THREAD_ON_PR, THREAD_ON_PR] });
    const result = await client.replyToReviewThreads({
      ...PR,
      replies: [
        { threadId: "T_1", body: "first" },
        { threadId: "T_2", body: "second" },
      ],
    });

    // Exact inputs: the pending review id is always set and there is no `event`.
    expect(replyMutationInputs(gql)).toEqual([
      { pullRequestReviewId: "REV_1", pullRequestReviewThreadId: "T_1", body: "first" },
      { pullRequestReviewId: "REV_1", pullRequestReviewThreadId: "T_2", body: "second" },
    ]);
    expect(result.addedReplies.map((reply) => reply.id)).toEqual(["C_T_1", "C_T_2"]);
    expect(result.addedReplies.map((reply) => reply.replyTo)).toEqual(["ROOT_T_1", "ROOT_T_2"]);
    expect(result.review.state).toBe("PENDING");
  });

  it("looks each distinct thread up once", async () => {
    const { client, gql } = replySetup();
    await client.replyToReviewThreads({
      ...PR,
      replies: [
        { threadId: "T_1", body: "first" },
        { threadId: "T_1", body: "second" },
      ],
    });
    const lookup = gql.mock.calls.find(([query]) => query.includes("nodes(ids: $ids)"));
    expect(lookup![1]).toEqual({ ids: ["T_1"] });
    expect(replyMutationInputs(gql)).toHaveLength(2);
  });

  it("creates the pending review first when none exists", async () => {
    const { client, gql, octokit } = replySetup({ reviews: [] });
    octokit.pulls.listReviews
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [{ ...PENDING_REVIEW_REST, node_id: "REV_NEW" }] });

    const result = await client.replyToReviewThreads({
      ...PR,
      replies: [{ threadId: "T_1", body: "reply" }],
    });
    expect(replyMutationInputs(gql)[0].pullRequestReviewId).toBe("REV_NEW");
    expect(result.review.id).toBe("REV_NEW");
  });

  it.each([
    ["unscoped", {}],
    ["scoped", { scope: PR }],
  ] as const)(
    "refuses a thread on a different PR before writing anything (%s)",
    async (_, clientOptions) => {
      const { client, gql, octokit } = replySetup({
        threads: [THREAD_ON_PR, threadOn({ owner: "octo", repo: "hello", number: 2 })],
        clientOptions,
      });
      await expect(
        client.replyToReviewThreads({
          ...PR,
          replies: [
            { threadId: "T_1", body: "fine" },
            { threadId: "T_OTHER", body: "elsewhere" },
          ],
        }),
      ).rejects.toThrow(/T_OTHER belongs to octo\/hello#2\. Refusing to reply/);
      expect(writeCalls(gql)).toEqual([]);
      expect(octokit.pulls.listReviews).not.toHaveBeenCalled();
    },
  );

  it("refuses a thread in a different repository", async () => {
    const { client, gql } = replySetup({
      threads: [threadOn({ owner: "evil", repo: "hello", number: 1 })],
    });
    await expect(
      client.replyToReviewThreads({ ...PR, replies: [{ threadId: "T_1", body: "b" }] }),
    ).rejects.toThrow(/belongs to evil\/hello#1/);
    expect(writeCalls(gql)).toEqual([]);
  });

  it("matches the thread's owner and repo case-insensitively", async () => {
    const { client } = replySetup({
      threads: [threadOn({ owner: "Octo", repo: "HELLO", number: 1 })],
    });
    await expect(
      client.replyToReviewThreads({ ...PR, replies: [{ threadId: "T_1", body: "b" }] }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["a missing node", null],
    ["a node that is not a review thread", {}],
  ])("refuses %s before writing anything", async (_, node) => {
    const { client, gql } = replySetup({ threads: [node] });
    await expect(
      client.replyToReviewThreads({ ...PR, replies: [{ threadId: "T_X", body: "b" }] }),
    ).rejects.toThrow(/Review thread T_X not found/);
    expect(writeCalls(gql)).toEqual([]);
  });

  it("requires at least one reply", async () => {
    const { client, gql } = replySetup();
    await expect(client.replyToReviewThreads({ ...PR, replies: [] })).rejects.toThrow(
      /At least one reply/,
    );
    expect(gql).not.toHaveBeenCalled();
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

  it("fails loudly and stops when a created reply is not PENDING", async () => {
    const { client, gql } = replySetup({
      threads: [THREAD_ON_PR, THREAD_ON_PR],
      replyState: "COMMENTED",
    });
    const call = client.replyToReviewThreads({
      ...PR,
      replies: [
        { threadId: "T_1", body: "first" },
        { threadId: "T_2", body: "second" },
      ],
    });
    await expect(call).rejects.toThrow(/SAFETY ALERT: GitHub created reply C_T_1 on thread T_1/);
    await expect(call).rejects.toThrow(/Report this error to the user/);
    expect(replyMutationInputs(gql)).toHaveLength(1);
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
        client.replyToReviewThreads({ ...input, replies: [{ threadId: "T_1", body: "b" }] }),
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
