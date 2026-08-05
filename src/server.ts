import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitHubReviewClient, GitHubApiError, PullRequestInput, SubmitAction } from "./github.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// ---------------------------------------------------------------------------
// MCP tool schemas (Zod)
// ---------------------------------------------------------------------------

const ReviewCommentSchema = z.object({
  path: z.string().describe("File path relative to the repo root"),
  body: z.string().min(1).describe("Comment body (Markdown)"),
  line: z.number().int().positive().optional().describe("Line number in the diff to comment on"),
  side: z
    .enum(["LEFT", "RIGHT"])
    .optional()
    .describe("Side of the diff (default RIGHT for line comments)"),
  start_line: z.number().int().positive().optional().describe("Start line for multi-line comments"),
  start_side: z.enum(["LEFT", "RIGHT"]).optional().describe("Side for the start line"),
  subject_type: z.enum(["LINE", "FILE"]).optional().describe("Comment target type (default LINE)"),
});

// The owner/repo/pull_number fields the PR tools accept when the server is
// NOT pinned to a single PR. A scoped server omits them (see createMcpServer)
// so the PR is implicit and cannot be overridden per call.
const PullRequestSchema = {
  owner: z.string().describe("Repository owner"),
  repo: z.string().describe("Repository name"),
  pull_number: z.number().int().positive().describe("Pull request number"),
};

// Non-PR fields for the composed tool schemas.
const AddReviewCommentsFields = {
  commit_oid: z.string().optional().describe("Commit SHA to review (defaults to HEAD)"),
  comments: z
    .array(ReviewCommentSchema)
    .min(1)
    .max(100)
    .describe("Draft comments to add to the pending review"),
};

const ModifyReviewCommentFields = {
  comment_id: z
    .string()
    .describe("GraphQL node ID of a comment in the authenticated user's pending review"),
  action: z
    .enum(["update", "delete"])
    .describe("Whether to update or delete the pending review comment"),
  body: z.string().min(1).optional().describe("New comment body. Required when action is update."),
};

// ---------------------------------------------------------------------------
// Helper: format tool responses for MCP
// ---------------------------------------------------------------------------

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function toolSuccess(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function mapReviewComments(comments: z.infer<typeof ReviewCommentSchema>[]) {
  return comments.map((comment) => ({
    path: comment.path,
    body: comment.body,
    line: comment.line,
    side: comment.side,
    startLine: comment.start_line,
    startSide: comment.start_side,
    subjectType: comment.subject_type,
  }));
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

export function createMcpServer(client: GitHubReviewClient): McpServer {
  const server = new McpServer({
    name: "review-guard",
    version,
  });

  // When the client is pinned to a single PR, the tools drop the
  // owner/repo/pull_number arguments and always act on that PR. Otherwise the
  // caller supplies them per call.
  const scope = client.scopedPullRequest;
  const prFields = scope ? {} : PullRequestSchema;
  const scopeNote = scope
    ? ` This server is pinned to ${scope.owner}/${scope.repo}#${scope.pullNumber}. The PR is implicit (no owner/repo/pull_number arguments).`
    : "";
  // A pending comment's permalink is already its final one, so cross-linking
  // findings inside a draft review works. Every tool that hands back pending
  // comments says so, since the link does not resolve while drafting and an
  // agent would otherwise assume it is broken.
  const pendingPermalinkNote =
    " Each pending comment already carries its final `url` permalink. It starts resolving once the review is submitted, and because all comments of a review go live together, one pending comment may link another.";
  const target = (args: Record<string, unknown>): PullRequestInput =>
    scope ?? {
      owner: args.owner as string,
      repo: args.repo as string,
      pullNumber: args.pull_number as number,
    };

  // -- get_pr_review_context -------------------------------------------------
  server.tool(
    "get_pr_review_context",
    "Get the pull request author/message plus all submitted PR discussion context: review summaries, inline review threads with resolved state and reactions, and general PR comments. " +
      "Every review, review comment and PR comment carries its GitHub permalink as `url`, so you can link an earlier discussion when you refer to one (a thread's permalink is its first comment's `url`)." +
      scopeNote,
    prFields,
    async (args) => {
      try {
        const context = await client.getPullRequestReviewContext(target(args));
        return toolSuccess(context);
      } catch (error) {
        const msg = error instanceof GitHubApiError ? error.message : String(error);
        return toolError(msg);
      }
    },
  );

  // -- list_pending_review ---------------------------------------------------
  server.tool(
    "list_pending_review",
    "List the authenticated user's current pending (draft) review on a pull request, including all current pending review comments. Returns null if there is no pending review." +
      pendingPermalinkNote +
      scopeNote,
    prFields,
    async (args) => {
      try {
        const review = await client.listPendingReview(target(args));
        return toolSuccess(review);
      } catch (error) {
        const msg = error instanceof GitHubApiError ? error.message : String(error);
        return toolError(msg);
      }
    },
  );

  // -- add_review_comments ---------------------------------------------------
  server.tool(
    "add_review_comments",
    "Add one or more comments to the authenticated user's pending review. Creates the pending review if it does not already exist. The review is NOT submitted." +
      pendingPermalinkNote +
      scopeNote,
    { ...prFields, ...AddReviewCommentsFields },
    async (args) => {
      try {
        const result = await client.addReviewComments({
          ...target(args),
          commitOID: args.commit_oid,
          comments: mapReviewComments(args.comments),
        });
        return toolSuccess(result);
      } catch (error) {
        const msg = error instanceof GitHubApiError ? error.message : String(error);
        return toolError(msg);
      }
    },
  );

  // -- modify_review_comment -------------------------------------------------
  server.tool(
    "modify_review_comment",
    "Update or delete one comment from the authenticated user's pending review. This cannot modify submitted review comments." +
      pendingPermalinkNote +
      scopeNote,
    { ...prFields, ...ModifyReviewCommentFields },
    async (args) => {
      try {
        const result = await client.modifyReviewComment({
          ...target(args),
          commentId: args.comment_id,
          action: args.action,
          body: args.body,
        });
        return toolSuccess(result);
      } catch (error) {
        const msg = error instanceof GitHubApiError ? error.message : String(error);
        return toolError(msg);
      }
    },
  );

  // -- delete_pending_review -------------------------------------------------
  server.tool(
    "delete_pending_review",
    "Delete the authenticated user's pending (draft) review. This removes the review and all its draft comments permanently." +
      scopeNote,
    prFields,
    async (args) => {
      try {
        const result = await client.deletePendingReview(target(args));
        return toolSuccess(result);
      } catch (error) {
        const msg = error instanceof GitHubApiError ? error.message : String(error);
        return toolError(msg);
      }
    },
  );

  // -- submit (opt-in) -------------------------------------------------------
  // Only registered when the server was started with an allow-submit set.
  const SUBMIT_ACTION_DOC: Record<SubmitAction, string> = {
    approve: "`approve` approves the PR (GitHub APPROVE)",
    comment: "`comment` posts a neutral review (GitHub COMMENT)",
    reject:
      "`reject` requests changes that block merge where reviews are required (GitHub REQUEST_CHANGES)",
  };
  const allowedActions = client.allowedSubmitActions;
  if (allowedActions.length > 0) {
    server.tool(
      "submit",
      "Submit the authenticated user's pending review, turning the draft comments into a real, posted review. " +
        "If no pending review exists, an empty one is created and submitted, so you can post a summary-only review when you have no inline findings. " +
        `Allowed actions: ${allowedActions.join(", ")}. ` +
        "A fixed disclaimer configured on the server is always used as the review summary prefix. You cannot change or remove it, " +
        "but you may pass `summary` (Markdown) to append your own overall summary below it. " +
        "Only call this when you intend to finalize the review. Otherwise leave it pending." +
        scopeNote,
      {
        ...prFields,
        action: z
          .enum(allowedActions as [SubmitAction, ...SubmitAction[]])
          .describe(
            "Review action to submit: " +
              allowedActions.map((a) => SUBMIT_ACTION_DOC[a]).join(". ") +
              ".",
          ),
        summary: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            "Optional Markdown appended below the fixed disclaimer as your overall review summary. " +
              "Cannot change or remove the disclaimer prefix.",
          ),
      },
      async (args) => {
        try {
          const result = await client.submitReview({
            ...target(args),
            action: args.action,
            additionalBody: args.summary,
          });
          return toolSuccess(result);
        } catch (error) {
          const msg = error instanceof GitHubApiError ? error.message : String(error);
          return toolError(msg);
        }
      },
    );
  }

  // -- resolve_review_thread (opt-in) ----------------------------------------
  // Only registered when resolving is enabled on the client.
  if (client.resolveEnabled) {
    server.tool(
      "resolve_review_thread",
      "Resolve one of YOUR OWN review threads that is now addressed (e.g. a prior " +
        "finding you raised that the latest changes have fixed). Takes the thread's " +
        "GraphQL node id (the `id` of a thread from get_pr_review_context). Refuses " +
        "to resolve threads authored by anyone else.",
      {
        thread_id: z.string().min(1).describe("GraphQL node id of the review thread to resolve"),
      },
      async (args) => {
        try {
          const result = await client.resolveReviewThread(args.thread_id);
          return toolSuccess(result);
        } catch (error) {
          const msg = error instanceof GitHubApiError ? error.message : String(error);
          return toolError(msg);
        }
      },
    );
  }

  return server;
}
