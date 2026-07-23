import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GitHubReviewClient } from "./github.js";
import { createMcpServer } from "./server.js";

export interface HttpServerOptions {
  /** Port to bind. 0 lets the OS pick a free port. */
  port: number;
  /** Address to bind, e.g. 127.0.0.1 or a container bridge gateway IP. */
  host: string;
}

// ---------------------------------------------------------------------------
// HTTP server with Streamable HTTP transport
// ---------------------------------------------------------------------------

// Bind addresses that only ever serve local clients. For these the allowlist
// stays restricted to the loopback aliases.
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "localhost", "::1"]);

// Hosts the transport accepts in the Host header. Rejecting other hosts
// protects against DNS rebinding: a malicious website resolving its own domain
// to this address to reach the server from a victim's browser. The allowlist
// only ever contains the bind address and standard local names, never an
// attacker-controllable domain, so listing several safe aliases keeps that
// protection while letting clients dial in by whichever local name they use.
//
// With a non-loopback bind the expected clients are containerized agents
// reaching the host. Those commonly dial the host by a runtime-provided name
// (host.docker.internal on Docker, host.containers.internal on Podman) or by a
// loopback alias their runtime maps to the host, so accept those too. Nothing
// listens on loopback in that case, so this adds no reachable path for a
// host-side browser: it only avoids a Host-header false reject.
export function computeAllowedHosts(bindAddress: string, port: number): string[] {
  const loopbackAliases = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (LOOPBACK_ADDRESSES.has(bindAddress)) {
    return loopbackAliases;
  }
  // An IPv6 bind address appears bracketed in the Host header
  const bindHost = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
  return [
    `${bindHost}:${port}`,
    ...loopbackAliases,
    `host.docker.internal:${port}`,
    `host.containers.internal:${port}`,
  ];
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startHttpServer(client: GitHubReviewClient, options: HttpServerOptions): void {
  const bindAddress = options.host;

  // Filled in once the actual port is known (see listen below). Read at request
  // time, so requests only arrive after it has been populated.
  let allowedHosts: string[] = [];

  // Stateless: each POST creates a fresh transport + server. The transport
  // reads and parses the request body from the raw stream itself, and enforces
  // the Host header against allowedHosts, so no body-parser or web framework is
  // needed here.
  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  const httpServer = createServer((req, res) => {
    // Only POST /mcp is a real endpoint. GET and DELETE on /mcp are part of the
    // Streamable HTTP spec for SSE sessions, which stateless mode does not
    // support, so they return 405. Everything else is 404.
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/mcp") {
      respondJson(res, 404, { error: "Not found. Use POST /mcp." });
      return;
    }
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "SSE not supported in stateless mode. Use POST." });
      return;
    }
    handleMcpRequest(req, res).catch((error) => {
      console.error(
        `Request handling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.headersSent) {
        respondJson(res, 500, { error: "Internal server error" });
      } else {
        res.end();
      }
    });
  });

  httpServer.listen(options.port, bindAddress, () => {
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : options.port;
    allowedHosts = computeAllowedHosts(bindAddress, port);
    console.log(`review-guard-mcp listening on http://${bindAddress}:${port}/mcp`);
  });
}
