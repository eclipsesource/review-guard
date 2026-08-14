// server.json is the MCP Registry entry. The registry rejects a publish when
// the file violates its schema, when the name does not match mcpName in the
// published package, or when a version does not match the npm version, and all
// of those errors only surface at release time, so they are checked here.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";

const require = createRequire(import.meta.url);

// ajv-formats is CommonJS with a default-only export, which NodeNext types as a
// namespace rather than the callable plugin, so it is required rather than
// imported.
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

const server = require("../server.json") as {
  $schema: string;
  name: string;
  packages: {
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
    packageArguments?: unknown;
  }[];
  version: string;
};
const pkg = require("../package.json") as { mcpName: string; name: string; version: string };

// Vendored verbatim from the registry, which embeds the same file for its own
// validation. The $schema above is pinned to a dated version, so this copy
// cannot go stale, and the test below fails if the pin ever moves.
const schema = require("./fixtures/mcp-server-schema-2025-12-11.json") as { $id: string };

describe("server.json", () => {
  it("satisfies the schema version it pins", () => {
    expect(schema.$id).toBe(server.$schema);

    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    expect(validate(server), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("claims the namespace the package declares", () => {
    expect(server.name).toBe(pkg.mcpName);
  });

  it("points at this npm package", () => {
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0].registryType).toBe("npm");
    expect(server.packages[0].identifier).toBe(pkg.name);
  });

  it("keeps both versions in step with package.json", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  // Without --stdio the binary starts the HTTP server, so a client following
  // the registry entry would launch a server it cannot talk to over stdio.
  it("launches the package in stdio mode", () => {
    expect(server.packages[0].transport.type).toBe("stdio");
    expect(server.packages[0].packageArguments).toEqual([
      { type: "positional", value: "--stdio", valueHint: "stdio" },
    ]);
  });

  // The registry entry is the default install path, so it must not hand out
  // submit or resolve rights. Those stay an explicit local opt-in.
  it("does not enable any of the opt-in permissions", () => {
    const args = JSON.stringify(server.packages[0].packageArguments);
    expect(args).not.toContain("--allow-submit");
    expect(args).not.toContain("--allow-resolve");
  });
});
