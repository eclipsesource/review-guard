import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GitHubReviewClient } from "./github.js";
import { createMcpServer } from "./server.js";

export async function startStdioServer(client: GitHubReviewClient): Promise<void> {
  const server = createMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
