// server.json is the MCP Registry entry. The registry rejects a publish when
// the name does not match mcpName in the published package or when a version
// does not match the npm version, and both errors only surface at release
// time, so they are checked here instead.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ServerJson {
  name: string;
  description: string;
  version: string;
  packages: {
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
    packageArguments?: { type: string; value?: string }[];
  }[];
}

interface PackageJson {
  name: string;
  version: string;
  mcpName: string;
}

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as T;

const server = read<ServerJson>("server.json");
const pkg = read<PackageJson>("package.json");

describe("server.json", () => {
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

  it("stays within the description limit the schema enforces", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
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
