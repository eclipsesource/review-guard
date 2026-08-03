/**
 * GitHub Review Client: the safety boundary
 *
 * This module is the ONLY place that interacts with the GitHub API.
 * By default it CANNOT submit reviews. Submission is an explicit, opt-in
 * capability gated at construction time. It enforces these invariants:
 *
 * 1. Comment/thread mutations NEVER include an `event` field, so creating draft
 *    comments always leaves the review PENDING (event is omitted entirely).
 *
 * 2. Submission happens ONLY through `submitReview`, and ONLY when the client
 *    was constructed with a non-empty `allowSubmit` set. `submitReview` refuses
 *    any action not in that set, so a client built without `allowSubmit` (the
 *    default) can never submit. DISMISS is never supported.
 *
 * 3. Submitted reviews ALWAYS include the server-configured `submitBody` as a
 *    prefix. Callers may only APPEND an optional summary below it. They can
 *    never replace or remove the prefix.
 *
 * 4. No REST submit/dismiss endpoint is ever called.
 *
 * 5. All write operations target only the authenticated user's review.
 *
 * 6. When constructed with a `scope`, the client is pinned to a single PR:
 *    every operation that names an owner/repo/PR is checked against the scope
 *    and refused if it targets anything else (`assertInScope`), and
 *    `resolveReviewThread` verifies the thread belongs to the scoped PR. This
 *    stops a caller (e.g. a prompt-injected agent) from acting on other PRs
 *    or repos the token can reach.
 *
 * 7. Post-mutation tripwire (defense in depth): after creating a review, the
 *    response state is verified to be "PENDING". This detects rather than
 *    prevents. On a violation the tool call fails with an error message that
 *    tells the agent to stop and alert the human, because many MCP clients do
 *    not show tool errors to the user on their own.
 *
 * Auditable: grep this file for `submitPullRequestReview`, `dismiss`, `APPROVE`,
 * `REQUEST_CHANGES`. The mutation appears only inside `submitReview` and the
 * events only in the `SUBMIT_EVENT` map it uses (and this comment block).
 */

import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

// ---------------------------------------------------------------------------
// Input types. Note there is no `event` field anywhere.
// ---------------------------------------------------------------------------

export interface PullRequestInput {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface DraftReviewComment {
  path: string;
  body: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  subjectType?: "LINE" | "FILE";
}

export interface AddReviewCommentsInput extends PullRequestInput {
  commitOID?: string;
  comments: DraftReviewComment[];
}

export interface ModifyReviewCommentInput extends PullRequestInput {
  commentId: string; // GraphQL node ID
  action: "update" | "delete";
  body?: string;
}

export type DeletePendingReviewInput = PullRequestInput;

export type SubmitAction = "approve" | "comment" | "reject";

export interface SubmitReviewInput extends PullRequestInput {
  action: SubmitAction;
  /**
   * Optional caller-supplied Markdown, appended BELOW the server-configured
   * `submitBody` prefix. The prefix is always kept and can never be replaced.
   */
  additionalBody?: string;
}

export interface GitHubReviewClientOptions {
  /** Actions the client is allowed to submit. Empty (default) = cannot submit. */
  allowSubmit?: SubmitAction[];
  /** Fixed review summary body used for every submission. */
  submitBody?: string;
  /** Allow resolving review threads authored by the authenticated user. */
  allowResolve?: boolean;
  /**
   * Pin the client to a single pull request. When set, every operation is
   * refused unless it targets this owner/repo/PR. Leave unset for an
   * unscoped client that can act on any PR the token can reach.
   */
  scope?: PullRequestInput;
}

const SUBMIT_EVENT: Record<SubmitAction, string> = {
  approve: "APPROVE",
  comment: "COMMENT",
  reject: "REQUEST_CHANGES",
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PullRequestAuthor {
  login: string | null;
}

export interface PullRequestInfo {
  id: string;
  number: number;
  title: string;
  body: string;
  author: PullRequestAuthor | null;
  url: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
}

export interface ReviewSummary {
  id: string;
  databaseId: number;
  author: string | null;
  state: string;
  body: string;
  submittedAt: string | null;
  commitId: string | null;
  htmlUrl: string | null;
  authorAssociation: string;
}

export interface ReviewComment {
  id: string;
  author: string | null;
  body: string;
  path: string;
  line: number | null;
  createdAt: string;
  updatedAt: string;
  url: string | null;
  /** Reaction content -> count, only for counts > 0 (e.g. THUMBS_DOWN). */
  reactions?: Record<string, number>;
  pullRequestReview?: {
    id: string;
    databaseId: number | null;
    state: string;
    author: string | null;
  } | null;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  diffSide: string;
  startDiffSide: string | null;
  subjectType: string;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  resolvedBy: string | null;
  commentsTotalCount: number;
  comments: ReviewComment[];
}

export interface PullRequestConversationComment {
  id: string;
  databaseId: number;
  author: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  authorAssociation: string;
  /** Reaction content -> count, only for counts > 0 (e.g. THUMBS_DOWN). */
  reactions?: Record<string, number>;
}

export interface PullRequestReviewContext {
  pullRequest: PullRequestInfo;
  reviews: ReviewSummary[];
  threads: ReviewThread[];
  prComments: PullRequestConversationComment[];
}

export interface PendingReview {
  id: string; // GraphQL node ID
  databaseId: number | null;
  state: string;
  body: string;
  author: string | null;
  createdAt: string;
  commentsTotalCount: number;
  comments: ReviewComment[];
}

export interface AddReviewCommentsResult {
  review: PendingReview;
  addedComments: ReviewComment[];
}

export interface ModifyReviewCommentResult {
  action: "updated" | "deleted";
  review: Pick<PendingReview, "id" | "databaseId" | "state">;
  comment: ReviewComment;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GitHubReviewClient {
  private octokit: Octokit;
  private gql: typeof graphql;
  private authenticatedLogin: string | null = null;
  private readonly allowSubmit: SubmitAction[];
  private readonly submitBody: string | null;
  private readonly allowResolve: boolean;
  private readonly scope: PullRequestInput | null;

  constructor(token: string, options: GitHubReviewClientOptions = {}) {
    this.octokit = new Octokit({ auth: token });
    this.gql = graphql.defaults({
      headers: { authorization: `token ${token}` },
    });
    this.allowSubmit = options.allowSubmit ?? [];
    this.submitBody = options.submitBody ?? null;
    this.allowResolve = options.allowResolve ?? false;
    this.scope = options.scope ?? null;
  }

  /** Actions this client may submit. Empty means submission is disabled. */
  get allowedSubmitActions(): SubmitAction[] {
    return [...this.allowSubmit];
  }

  /** Whether resolving the authenticated user's own threads is enabled. */
  get resolveEnabled(): boolean {
    return this.allowResolve;
  }

  /** The PR this client is pinned to, or null when unscoped. */
  get scopedPullRequest(): PullRequestInput | null {
    return this.scope ? { ...this.scope } : null;
  }

  /**
   * Safety boundary: when the client is scoped to a single PR, refuse any
   * request that targets a different owner/repo/PR. Owner and repo compare
   * case-insensitively (GitHub treats them so). The PR number matches exactly.
   */
  private assertInScope(input: PullRequestInput): void {
    if (!this.scope) return;
    const matches =
      input.owner.toLowerCase() === this.scope.owner.toLowerCase() &&
      input.repo.toLowerCase() === this.scope.repo.toLowerCase() &&
      input.pullNumber === this.scope.pullNumber;
    if (!matches) {
      throw new GitHubApiError(
        `This server is scoped to ${this.scope.owner}/${this.scope.repo}#${this.scope.pullNumber}. ` +
          `Refusing to operate on ${input.owner}/${input.repo}#${input.pullNumber}.`,
      );
    }
  }

  private async getLogin(): Promise<string> {
    if (this.authenticatedLogin) return this.authenticatedLogin;
    const { data } = await this.octokit.users.getAuthenticated();
    this.authenticatedLogin = data.login;
    return data.login;
  }

  /**
   * Resolve owner/repo/pullNumber to the PR's GraphQL node ID.
   */
  private async getPullRequestNodeId(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<string> {
    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            id
          }
        }
      }
    `;
    const result: any = await this.gql(query, {
      owner,
      repo,
      number: pullNumber,
    });
    const id = result.repository?.pullRequest?.id;
    if (!id) {
      throw new GitHubApiError(`Pull request ${owner}/${repo}#${pullNumber} not found`);
    }
    return id;
  }

  // -------------------------------------------------------------------------
  // 1. Get submitted PR review context (GraphQL + REST)
  // -------------------------------------------------------------------------

  async getPullRequestReviewContext(input: PullRequestInput): Promise<PullRequestReviewContext> {
    try {
      this.assertInScope(input);
      const [graphContext, reviews, prComments] = await Promise.all([
        this.getPullRequestAndReviewThreads(input),
        this.listSubmittedReviewSummaries(input),
        this.listPullRequestConversationComments(input),
      ]);

      return {
        pullRequest: graphContext.pullRequest,
        reviews,
        threads: graphContext.threads,
        prComments,
      };
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(
        `Failed to get PR review context: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
  }

  private async getPullRequestAndReviewThreads(input: PullRequestInput): Promise<{
    pullRequest: PullRequestInfo;
    threads: ReviewThread[];
  }> {
    const query = `
      query(
        $owner: String!
        $repo: String!
        $number: Int!
        $threadCursor: String
      ) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            id
            number
            title
            body
            author { login }
            url
            state
            isDraft
            createdAt
            updatedAt
            baseRefName
            headRefName
            reviewThreads(first: 100, after: $threadCursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                path
                line
                startLine
                originalLine
                originalStartLine
                diffSide
                startDiffSide
                subjectType
                isResolved
                isOutdated
                isCollapsed
                resolvedBy { login }
                comments(first: 100) {
                  totalCount
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    id
                    url
                    body
                    path
                    line
                    createdAt
                    updatedAt
                    author { login }
                    reactionGroups { content reactors { totalCount } }
                    pullRequestReview {
                      id
                      databaseId
                      state
                      author { login }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    let cursor: string | null = null;
    let pullRequest: PullRequestInfo | null = null;
    const threads: ReviewThread[] = [];

    while (true) {
      const result: any = await this.gql(query, {
        owner: input.owner,
        repo: input.repo,
        number: input.pullNumber,
        threadCursor: cursor,
      });

      const pr = result.repository?.pullRequest;
      if (!pr) {
        throw new GitHubApiError(
          `Pull request ${input.owner}/${input.repo}#${input.pullNumber} not found`,
        );
      }

      if (!pullRequest) {
        pullRequest = {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          body: pr.body ?? "",
          author: pr.author ? { login: pr.author.login ?? null } : null,
          url: pr.url,
          state: pr.state,
          isDraft: pr.isDraft,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          baseRefName: pr.baseRefName,
          headRefName: pr.headRefName,
        };
      }

      for (const node of pr.reviewThreads.nodes ?? []) {
        if (!node) continue;
        const comments = (node.comments.nodes ?? [])
          .filter(Boolean)
          .map((comment: any) => this.mapGraphqlReviewComment(comment));

        const thread: ReviewThread = {
          id: node.id,
          path: node.path,
          line: node.line ?? null,
          startLine: node.startLine ?? null,
          originalLine: node.originalLine ?? null,
          originalStartLine: node.originalStartLine ?? null,
          diffSide: node.diffSide,
          startDiffSide: node.startDiffSide ?? null,
          subjectType: node.subjectType,
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
          isCollapsed: node.isCollapsed,
          resolvedBy: node.resolvedBy?.login ?? null,
          commentsTotalCount: comments.length,
          comments,
        };

        if (node.comments.pageInfo?.hasNextPage) {
          thread.comments.push(
            ...(await this.listMoreThreadComments(node.id, node.comments.pageInfo.endCursor)),
          );
        }

        thread.comments = thread.comments.filter(
          (comment) => comment.pullRequestReview?.state !== "PENDING",
        );
        thread.commentsTotalCount = thread.comments.length;
        if (thread.comments.length === 0) continue;

        threads.push(thread);
      }

      if (!pr.reviewThreads.pageInfo?.hasNextPage) break;
      cursor = pr.reviewThreads.pageInfo.endCursor;
    }

    return { pullRequest, threads };
  }

  private async listMoreThreadComments(
    threadId: string,
    initialCursor: string,
  ): Promise<ReviewComment[]> {
    const query = `
      query($threadId: ID!, $cursor: String) {
        node(id: $threadId) {
          ... on PullRequestReviewThread {
            comments(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                url
                body
                path
                line
                createdAt
                updatedAt
                author { login }
                reactionGroups { content reactors { totalCount } }
                pullRequestReview {
                  id
                  databaseId
                  state
                  author { login }
                }
              }
            }
          }
        }
      }
    `;

    const comments: ReviewComment[] = [];
    let cursor: string | null = initialCursor;

    while (cursor) {
      const result: any = await this.gql(query, { threadId, cursor });
      const connection = result.node?.comments;
      if (!connection) break;

      comments.push(
        ...(connection.nodes ?? [])
          .filter(Boolean)
          .map((comment: any) => this.mapGraphqlReviewComment(comment)),
      );

      cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    }

    return comments;
  }

  private async listSubmittedReviewSummaries(input: PullRequestInput): Promise<ReviewSummary[]> {
    const reviews: ReviewSummary[] = [];
    let page = 1;

    while (true) {
      const { data } = await this.octokit.pulls.listReviews({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        per_page: 100,
        page,
      });

      if (data.length === 0) break;

      for (const review of data) {
        if (review.state === "PENDING") continue;
        reviews.push({
          id: review.node_id,
          databaseId: review.id,
          author: review.user?.login ?? null,
          state: review.state,
          body: review.body ?? "",
          submittedAt: review.submitted_at ?? null,
          commitId: review.commit_id ?? null,
          htmlUrl: review.html_url ?? null,
          authorAssociation: review.author_association,
        });
      }

      if (data.length < 100) break;
      page++;
    }

    return reviews;
  }

  private async listPullRequestConversationComments(
    input: PullRequestInput,
  ): Promise<PullRequestConversationComment[]> {
    const comments: PullRequestConversationComment[] = [];
    let page = 1;

    while (true) {
      const { data } = await this.octokit.issues.listComments({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.pullNumber,
        per_page: 100,
        page,
      });

      if (data.length === 0) break;

      for (const comment of data) {
        comments.push({
          id: comment.node_id,
          databaseId: comment.id,
          author: comment.user?.login ?? null,
          body: comment.body ?? "",
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
          htmlUrl: comment.html_url,
          authorAssociation: comment.author_association,
          reactions: this.mapRestReactions((comment as any).reactions),
        });
      }

      if (data.length < 100) break;
      page++;
    }

    return comments;
  }

  // -------------------------------------------------------------------------
  // 2. List the authenticated user's pending review
  // -------------------------------------------------------------------------

  async listPendingReview(input: PullRequestInput): Promise<PendingReview | null> {
    try {
      this.assertInScope(input);
      const pendingReviewId = await this.findAuthenticatedPendingReviewId(input);
      if (!pendingReviewId) return null;
      return await this.getPendingReviewById(pendingReviewId);
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(
        `Failed to list pending review: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
  }

  private async findAuthenticatedPendingReviewId(input: PullRequestInput): Promise<string | null> {
    const login = await this.getLogin();
    const pendingReviews: { nodeId: string; databaseId: number }[] = [];
    let page = 1;

    while (true) {
      const { data } = await this.octokit.pulls.listReviews({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        per_page: 100,
        page,
      });

      if (data.length === 0) break;

      for (const review of data) {
        if (review.state === "PENDING" && review.user?.login === login) {
          pendingReviews.push({
            nodeId: review.node_id,
            databaseId: review.id,
          });
        }
      }

      if (data.length < 100) break;
      page++;
    }

    if (pendingReviews.length === 0) return null;
    pendingReviews.sort((a, b) => b.databaseId - a.databaseId);
    return pendingReviews[0].nodeId;
  }

  private async getPendingReviewById(reviewId: string): Promise<PendingReview> {
    const review = await this.getPendingReviewPage(reviewId, null);
    const comments = [...review.comments];
    let cursor = review.nextCommentsCursor;

    while (cursor) {
      const page = await this.getPendingReviewPage(reviewId, cursor);
      comments.push(...page.comments);
      cursor = page.nextCommentsCursor;
    }

    return {
      id: review.id,
      databaseId: review.databaseId,
      state: review.state,
      body: review.body,
      author: review.author,
      createdAt: review.createdAt,
      commentsTotalCount: review.commentsTotalCount,
      comments,
    };
  }

  private async getPendingReviewPage(
    reviewId: string,
    commentsCursor: string | null,
  ): Promise<PendingReview & { nextCommentsCursor: string | null }> {
    const query = `
      query($reviewId: ID!, $commentsCursor: String) {
        node(id: $reviewId) {
          ... on PullRequestReview {
            id
            databaseId
            state
            body
            createdAt
            author { login }
            comments(first: 100, after: $commentsCursor) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                url
                body
                path
                line
                createdAt
                updatedAt
                author { login }
                pullRequestReview {
                  id
                  databaseId
                  state
                  author { login }
                }
              }
            }
          }
        }
      }
    `;

    const result: any = await this.gql(query, {
      reviewId,
      commentsCursor,
    });

    const review = result.node;
    if (!review) {
      throw new GitHubApiError(`Pending review ${reviewId} not found`);
    }
    if (review.state !== "PENDING") {
      throw new GitHubApiError(
        `Expected pending review ${reviewId} to be in PENDING state but got ${review.state}`,
      );
    }

    return {
      id: review.id,
      databaseId: review.databaseId ?? null,
      state: review.state,
      body: review.body ?? "",
      author: review.author?.login ?? null,
      createdAt: review.createdAt,
      commentsTotalCount: review.comments.totalCount,
      comments: (review.comments.nodes ?? [])
        .filter(Boolean)
        .map((comment: any) => this.mapGraphqlReviewComment(comment)),
      nextCommentsCursor: review.comments.pageInfo?.hasNextPage
        ? review.comments.pageInfo.endCursor
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // 3. Add comments to the authenticated user's pending review
  // -------------------------------------------------------------------------

  async addReviewComments(input: AddReviewCommentsInput): Promise<AddReviewCommentsResult> {
    try {
      this.assertInScope(input);
      if (input.comments.length === 0) {
        throw new GitHubApiError("At least one review comment is required");
      }

      const prNodeId = await this.getPullRequestNodeId(input.owner, input.repo, input.pullNumber);
      const reviewId =
        (await this.findAuthenticatedPendingReviewId(input)) ??
        (await this.createEmptyPendingReview(prNodeId, input.commitOID));

      const addedComments: ReviewComment[] = [];
      for (const comment of input.comments) {
        addedComments.push(await this.addCommentToPendingReview(prNodeId, reviewId, comment));
      }

      const review = await this.listPendingReview(input);
      if (!review) {
        throw new GitHubApiError("Failed to read pending review after adding comments");
      }

      return { review, addedComments };
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(
        `Failed to add review comments: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
  }

  private async createEmptyPendingReview(prNodeId: string, commitOID?: string): Promise<string> {
    const mutation = `
      mutation($input: AddPullRequestReviewInput!) {
        addPullRequestReview(input: $input) {
          pullRequestReview {
            id
            state
          }
        }
      }
    `;

    const result: any = await this.gql(mutation, {
      input: {
        pullRequestId: prNodeId,
        ...(commitOID != null ? { commitOID } : {}),
      },
    });

    const review = result.addPullRequestReview.pullRequestReview;
    if (review.state !== "PENDING") {
      // Tripwire, not a gate: this cannot undo whatever GitHub did, and many
      // MCP clients never show tool errors to the human. The message therefore
      // instructs the agent itself to stop and escalate.
      throw new GitHubApiError(
        `SAFETY ALERT: GitHub created review ${review.id} in state "${review.state}" instead of "PENDING". ` +
          "The review may already be visible to others even though it was never submitted through this server. " +
          "Do not retry and do not continue the review. Report this error to the user verbatim and ask them " +
          "to inspect the review on GitHub immediately.",
      );
    }
    return review.id;
  }

  private async addCommentToPendingReview(
    prNodeId: string,
    reviewId: string,
    comment: DraftReviewComment,
  ): Promise<ReviewComment> {
    const mutation = `
      mutation($input: AddPullRequestReviewThreadInput!) {
        addPullRequestReviewThread(input: $input) {
          thread {
            comments(first: 1) {
              nodes {
                id
                url
                body
                path
                line
                createdAt
                updatedAt
                author { login }
                pullRequestReview {
                  id
                  databaseId
                  state
                  author { login }
                }
              }
            }
          }
        }
      }
    `;

    const result: any = await this.gql(mutation, {
      input: {
        pullRequestId: prNodeId,
        pullRequestReviewId: reviewId,
        ...this.toDraftReviewThreadInput(comment),
      },
    });

    const createdComment = result.addPullRequestReviewThread.thread.comments.nodes[0];
    return this.mapGraphqlReviewComment(createdComment);
  }

  private toDraftReviewThreadInput(comment: DraftReviewComment): Record<string, any> {
    const subjectType = comment.subjectType ?? "LINE";

    if (subjectType === "LINE" && comment.line == null) {
      throw new GitHubApiError(`Line-level review comment on ${comment.path} is missing a line`);
    }

    return {
      path: comment.path,
      body: comment.body,
      subjectType,
      ...(comment.line != null ? { line: comment.line } : {}),
      ...(subjectType === "LINE" ? { side: comment.side ?? "RIGHT" } : {}),
      ...(comment.startLine != null ? { startLine: comment.startLine } : {}),
      ...(comment.startSide != null ? { startSide: comment.startSide } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // 4. Update or delete a comment from the authenticated user's pending review
  // -------------------------------------------------------------------------

  async modifyReviewComment(input: ModifyReviewCommentInput): Promise<ModifyReviewCommentResult> {
    try {
      this.assertInScope(input);
      const pendingReview = await this.listPendingReview(input);
      if (!pendingReview) {
        throw new GitHubApiError("No pending review exists for the authenticated user");
      }

      const existingComment = pendingReview.comments.find(
        (comment) => comment.id === input.commentId,
      );
      if (!existingComment) {
        throw new GitHubApiError(
          `Comment ${input.commentId} does not belong to the authenticated user's pending review`,
        );
      }

      if (input.action === "update") {
        if (input.body == null || input.body.length === 0) {
          throw new GitHubApiError("A non-empty body is required when updating a comment");
        }
        return await this.updatePendingReviewComment(pendingReview, input.commentId, input.body);
      }

      return await this.deletePendingReviewComment(pendingReview, input.commentId);
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(
        `Failed to modify review comment: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
  }

  private async updatePendingReviewComment(
    review: PendingReview,
    commentId: string,
    body: string,
  ): Promise<ModifyReviewCommentResult> {
    const mutation = `
      mutation($input: UpdatePullRequestReviewCommentInput!) {
        updatePullRequestReviewComment(input: $input) {
          pullRequestReviewComment {
            id
            url
            body
            path
            line
            createdAt
            updatedAt
            author { login }
            pullRequestReview {
              id
              databaseId
              state
              author { login }
            }
          }
        }
      }
    `;

    const result: any = await this.gql(mutation, {
      input: {
        pullRequestReviewCommentId: commentId,
        body,
      },
    });

    return {
      action: "updated",
      review: {
        id: review.id,
        databaseId: review.databaseId,
        state: review.state,
      },
      comment: this.mapGraphqlReviewComment(
        result.updatePullRequestReviewComment.pullRequestReviewComment,
      ),
    };
  }

  private async deletePendingReviewComment(
    review: PendingReview,
    commentId: string,
  ): Promise<ModifyReviewCommentResult> {
    const mutation = `
      mutation($input: DeletePullRequestReviewCommentInput!) {
        deletePullRequestReviewComment(input: $input) {
          pullRequestReview {
            id
            databaseId
            state
          }
          pullRequestReviewComment {
            id
            url
            body
            path
            line
            createdAt
            updatedAt
            author { login }
            pullRequestReview {
              id
              databaseId
              state
              author { login }
            }
          }
        }
      }
    `;

    const result: any = await this.gql(mutation, {
      input: { id: commentId },
    });
    const deletedReview = result.deletePullRequestReviewComment.pullRequestReview;

    return {
      action: "deleted",
      review: {
        id: deletedReview?.id ?? review.id,
        databaseId: deletedReview?.databaseId ?? review.databaseId,
        state: deletedReview?.state ?? review.state,
      },
      comment: this.mapGraphqlReviewComment(
        result.deletePullRequestReviewComment.pullRequestReviewComment,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // 5. Delete the authenticated user's pending review
  // -------------------------------------------------------------------------

  async deletePendingReview(
    input: DeletePendingReviewInput,
  ): Promise<{ id: string; deleted: boolean }> {
    try {
      this.assertInScope(input);
      const pendingReview = await this.listPendingReview(input);
      if (!pendingReview) {
        throw new GitHubApiError("No pending review exists for the authenticated user");
      }

      const mutation = `
        mutation($input: DeletePullRequestReviewInput!) {
          deletePullRequestReview(input: $input) {
            pullRequestReview {
              id
              state
            }
          }
        }
      `;

      const result: any = await this.gql(mutation, {
        input: {
          pullRequestReviewId: pendingReview.id,
        },
      });
      const review = result.deletePullRequestReview.pullRequestReview;

      // GitHub has no DELETED review state. The mutation returns the deleted
      // node with its last state still set to PENDING, which would read as if
      // nothing happened, so the result carries an explicit deletion flag.
      return { id: review.id, deleted: true };
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(
        `Failed to delete pending review: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 6. Submit the authenticated user's pending review (opt-in only)
  // -------------------------------------------------------------------------

  async submitReview(
    input: SubmitReviewInput,
  ): Promise<{ id: string; state: string; url: string | null }> {
    try {
      this.assertInScope(input);
      if (!this.allowSubmit.includes(input.action)) {
        throw new GitHubApiError(
          `Submitting a "${input.action}" review is not allowed. ` +
            `Allowed actions: ${this.allowSubmit.length ? this.allowSubmit.join(", ") : "(none)"}.`,
        );
      }
      if (!this.submitBody) {
        throw new GitHubApiError(
          "Cannot submit a review: no submit body is configured on the server.",
        );
      }

      const prNodeId = await this.getPullRequestNodeId(input.owner, input.repo, input.pullNumber);
      const reviewId =
        (await this.findAuthenticatedPendingReviewId(input)) ??
        (await this.createEmptyPendingReview(prNodeId));

      const mutation = `
        mutation($input: SubmitPullRequestReviewInput!) {
          submitPullRequestReview(input: $input) {
            pullRequestReview {
              id
              state
              url
            }
          }
        }
      `;

      // The server-configured prefix is always present. A caller may only
      // append below it, never replace it.
      const addition = input.additionalBody?.trim();
      const body = addition ? `${this.submitBody}\n\n${addition}` : this.submitBody;

      const result: any = await this.gql(mutation, {
        input: {
          pullRequestReviewId: reviewId,
          event: SUBMIT_EVENT[input.action],
          body,
        },
      });

      const review = result.submitPullRequestReview.pullRequestReview;
      return {
        id: review.id,
        state: review.state,
        url: review.url ?? null,
      };
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(
        `Failed to submit review: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 7. Resolve one of the authenticated user's own review threads (opt-in)
  // -------------------------------------------------------------------------

  async resolveReviewThread(threadId: string): Promise<{ id: string; isResolved: boolean }> {
    try {
      if (!this.allowResolve) {
        throw new GitHubApiError("Resolving review threads is not allowed.");
      }

      // Safety boundary: only resolve threads started by the authenticated
      // user, so the bot can tidy up its own findings but never close other
      // reviewers' conversations.
      const login = await this.getLogin();
      const info: any = await this.gql(
        `query($threadId: ID!) {
          node(id: $threadId) {
            ... on PullRequestReviewThread {
              isResolved
              pullRequest {
                number
                repository { name owner { login } }
              }
              comments(first: 1) { nodes { author { login } } }
            }
          }
        }`,
        { threadId },
      );
      const thread = info.node;
      if (!thread) {
        throw new GitHubApiError(`Review thread ${threadId} not found.`);
      }

      // When scoped, refuse to resolve a thread that lives on a different PR.
      if (this.scope) {
        const pr = thread.pullRequest;
        this.assertInScope({
          owner: pr?.repository?.owner?.login ?? "",
          repo: pr?.repository?.name ?? "",
          pullNumber: pr?.number ?? -1,
        });
      }

      const author = thread.comments?.nodes?.[0]?.author?.login ?? null;
      if (!author || author.toLowerCase() !== login.toLowerCase()) {
        throw new GitHubApiError(
          "Refusing to resolve a thread not authored by the authenticated user " +
            `(thread author: ${author ?? "unknown"}, you: ${login}).`,
        );
      }
      if (thread.isResolved) {
        return { id: threadId, isResolved: true };
      }

      const result: any = await this.gql(
        `mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }`,
        { threadId },
      );
      const resolved = result.resolveReviewThread.thread;
      return { id: resolved.id, isResolved: resolved.isResolved };
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(
        `Failed to resolve review thread: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Response mapping helpers
  // -------------------------------------------------------------------------

  // REST reaction summary keys -> GraphQL-style content names, so review-thread
  // and conversation comments expose reactions in the same shape.
  private static readonly REST_REACTIONS: Record<string, string> = {
    "+1": "THUMBS_UP",
    "-1": "THUMBS_DOWN",
    laugh: "LAUGH",
    hooray: "HOORAY",
    confused: "CONFUSED",
    heart: "HEART",
    rocket: "ROCKET",
    eyes: "EYES",
  };

  private mapRestReactions(reactions: any): Record<string, number> | undefined {
    if (!reactions) return undefined;
    const out: Record<string, number> = {};
    for (const [key, name] of Object.entries(GitHubReviewClient.REST_REACTIONS)) {
      const count = reactions[key] ?? 0;
      if (count > 0) out[name] = count;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private mapReactionGroups(node: any): Record<string, number> | undefined {
    const groups = node?.reactionGroups;
    if (!Array.isArray(groups)) return undefined;
    const out: Record<string, number> = {};
    for (const group of groups) {
      const count = group?.reactors?.totalCount ?? 0;
      if (count > 0 && group?.content) out[group.content] = count;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private mapGraphqlReviewComment(comment: any): ReviewComment {
    return {
      id: comment.id,
      author: comment.author?.login ?? null,
      body: comment.body ?? "",
      path: comment.path ?? "",
      line: comment.line ?? null,
      url: comment.url ?? null,
      createdAt: comment.createdAt ?? "",
      updatedAt: comment.updatedAt ?? "",
      reactions: this.mapReactionGroups(comment),
      pullRequestReview: comment.pullRequestReview
        ? {
            id: comment.pullRequestReview.id,
            databaseId: comment.pullRequestReview.databaseId ?? null,
            state: comment.pullRequestReview.state,
            author: comment.pullRequestReview.author?.login ?? null,
          }
        : null,
    };
  }
}
