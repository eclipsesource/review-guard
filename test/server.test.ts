import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { GitHubApiError, GitHubReviewClient } from "../src/github.js";
import type { GitHubReviewClientOptions } from "../src/github.js";

const { version: packageVersion } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const BASE_TOOLS = [
  "get_pr_review_context",
  "list_pending_review",
  "add_review_comments",
  "modify_review_comment",
  "delete_pending_review",
];

/** Boots the MCP server over an in-memory transport and returns a connected client. */
async function connect(options: GitHubReviewClientOptions = {}) {
  const reviewClient = new GitHubReviewClient("test-token", options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    createMcpServer(reviewClient).connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
  return { mcpClient, reviewClient };
}

async function toolMap(mcpClient: Client) {
  const { tools } = await mcpClient.listTools();
  return new Map(tools.map((tool) => [tool.name, tool]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool registration", () => {
  it("reports the package version as the server version", async () => {
    const { mcpClient } = await connect();
    expect(mcpClient.getServerVersion()?.version).toBe(packageVersion);
  });

  it("registers only the pending-review tools by default", async () => {
    const { mcpClient } = await connect();
    const tools = await toolMap(mcpClient);
    expect([...tools.keys()].sort()).toEqual([...BASE_TOOLS].sort());
    expect(tools.has("submit")).toBe(false);
    expect(tools.has("resolve_review_thread")).toBe(false);
  });

  it("requires owner/repo/pull_number on an unscoped server", async () => {
    const { mcpClient } = await connect();
    const tools = await toolMap(mcpClient);
    const schema = tools.get("get_pr_review_context")!.inputSchema;
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["owner", "repo", "pull_number"]),
    );
    expect(schema.required).toEqual(expect.arrayContaining(["owner", "repo", "pull_number"]));
  });

  it("drops the PR arguments on a scoped server", async () => {
    const { mcpClient } = await connect({
      scope: { owner: "octo", repo: "hello", pullNumber: 7 },
    });
    const tools = await toolMap(mcpClient);
    const schema = tools.get("get_pr_review_context")!.inputSchema;
    expect(Object.keys(schema.properties ?? {})).not.toContain("owner");
    expect(tools.get("get_pr_review_context")!.description).toContain("octo/hello#7");
  });

  it("registers submit only with --allow-submit and restricts the action enum", async () => {
    const { mcpClient } = await connect({ allowSubmit: ["comment"], submitBody: "PREFIX" });
    const tools = await toolMap(mcpClient);
    const submit = tools.get("submit");
    expect(submit).toBeDefined();
    const action = (submit!.inputSchema.properties as Record<string, { enum?: string[] }>).action;
    expect(action.enum).toEqual(["comment"]);
  });

  it("registers resolve_review_thread only with --allow-resolve", async () => {
    const { mcpClient } = await connect({ allowResolve: true });
    const tools = await toolMap(mcpClient);
    expect(tools.has("resolve_review_thread")).toBe(true);
  });
});

describe("tool dispatch", () => {
  it("returns tool results as JSON text content", async () => {
    const { mcpClient, reviewClient } = await connect();
    const context = { pullRequest: { title: "hi" }, reviews: [], threads: [], prComments: [] };
    vi.spyOn(reviewClient, "getPullRequestReviewContext").mockResolvedValue(context as never);
    const result = await mcpClient.callTool({
      name: "get_pr_review_context",
      arguments: { owner: "octo", repo: "hello", pull_number: 1 },
    });
    expect(result.isError).toBeFalsy();
    const [content] = result.content as [{ type: string; text: string }];
    expect(JSON.parse(content.text)).toEqual(context);
  });

  it("returns errors as isError content instead of protocol failures", async () => {
    const { mcpClient, reviewClient } = await connect();
    vi.spyOn(reviewClient, "listPendingReview").mockRejectedValue(
      new GitHubApiError("upstream exploded"),
    );
    const result = await mcpClient.callTool({
      name: "list_pending_review",
      arguments: { owner: "octo", repo: "hello", pull_number: 1 },
    });
    expect(result.isError).toBe(true);
    const [content] = result.content as [{ type: string; text: string }];
    expect(content.text).toBe("upstream exploded");
  });

  it("passes the scoped PR to the client when arguments are omitted", async () => {
    const scope = { owner: "octo", repo: "hello", pullNumber: 7 };
    const { mcpClient, reviewClient } = await connect({ scope });
    const spy = vi
      .spyOn(reviewClient, "deletePendingReview")
      .mockResolvedValue({ id: "R", deleted: true });
    await mcpClient.callTool({ name: "delete_pending_review", arguments: {} });
    expect(spy).toHaveBeenCalledWith(scope);
  });
});
