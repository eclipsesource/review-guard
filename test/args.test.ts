import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliOptions } from "../src/args.js";

describe("parseCliOptions", () => {
  it("returns safe defaults for an empty command line", () => {
    expect(parseCliOptions([])).toEqual({
      stdio: false,
      port: 0,
      host: "127.0.0.1",
      allowSubmit: [],
      submitBody: undefined,
      allowResolve: false,
      scope: undefined,
    });
  });

  describe("general flag handling", () => {
    it("rejects unknown flags", () => {
      expect(() => parseCliOptions(["--nope"])).toThrow(CliUsageError);
      expect(() => parseCliOptions(["--nope"])).toThrow(/Unknown flag/);
    });

    it("rejects positional arguments", () => {
      expect(() => parseCliOptions(["stdio"])).toThrow(/Unexpected argument/);
    });

    it("rejects duplicate flags", () => {
      expect(() => parseCliOptions(["--stdio", "--stdio"])).toThrow(/Duplicate flag/);
      expect(() => parseCliOptions(["--port", "1", "--port", "2"])).toThrow(/Duplicate flag/);
    });

    it("rejects values on boolean flags", () => {
      expect(() => parseCliOptions(["--stdio=true"])).toThrow(/does not take a value/);
    });

    it("rejects a value flag with no value", () => {
      expect(() => parseCliOptions(["--port"])).toThrow(/Missing value/);
    });

    it("treats a following option as a missing value, not as the value", () => {
      expect(() => parseCliOptions(["--submit-body", "--stdio"])).toThrow(/Missing value/);
    });

    it("accepts both --flag value and --flag=value forms", () => {
      expect(parseCliOptions(["--port", "4000"]).port).toBe(4000);
      expect(parseCliOptions(["--port=4000"]).port).toBe(4000);
    });
  });

  describe("boolean flags", () => {
    it("parses --stdio and --allow-resolve", () => {
      const options = parseCliOptions(["--stdio", "--allow-resolve"]);
      expect(options.stdio).toBe(true);
      expect(options.allowResolve).toBe(true);
    });
  });

  describe("--port", () => {
    it.each(["abc", "-1", "70000"])("rejects invalid port %s", (port) => {
      expect(() => parseCliOptions(["--port", port])).toThrow(/Invalid port/);
    });
  });

  describe("--host", () => {
    it("parses a bind address", () => {
      expect(parseCliOptions(["--host", "172.17.0.1"]).host).toBe("172.17.0.1");
    });

    it("rejects an empty address, which Node would treat as an unspecified bind", () => {
      expect(() => parseCliOptions(["--host="])).toThrow(/must not be empty/);
      expect(() => parseCliOptions(["--host", "  "])).toThrow(/must not be empty/);
    });

    it.each(["0.0.0.0", "::", "[::]"])("rejects the unspecified address %s", (host) => {
      expect(() => parseCliOptions(["--host", host])).toThrow(/all interfaces/);
    });
  });

  describe("--allow-submit", () => {
    it("parses a comma-separated action list", () => {
      expect(parseCliOptions(["--allow-submit", "approve,comment"]).allowSubmit).toEqual([
        "approve",
        "comment",
      ]);
    });

    it("normalizes case and deduplicates", () => {
      expect(parseCliOptions(["--allow-submit", "APPROVE, approve"]).allowSubmit).toEqual([
        "approve",
      ]);
    });

    it("rejects unknown actions", () => {
      expect(() => parseCliOptions(["--allow-submit", "approve,dismiss"])).toThrow(
        /Invalid --allow-submit action\(s\): dismiss/,
      );
    });

    it("rejects an empty action list", () => {
      expect(() => parseCliOptions(["--allow-submit", ","])).toThrow(/at least one/);
    });
  });

  describe("--submit-body", () => {
    it("requires --allow-submit", () => {
      expect(() => parseCliOptions(["--submit-body", "note"])).toThrow(/requires --allow-submit/);
    });

    it("rejects an empty or whitespace-only body", () => {
      expect(() => parseCliOptions(["--allow-submit", "comment", "--submit-body", "   "])).toThrow(
        /must not be empty/,
      );
    });

    it("keeps a valid body", () => {
      const options = parseCliOptions(["--allow-submit", "comment", "--submit-body", "note"]);
      expect(options.submitBody).toBe("note");
    });
  });

  describe("--repo / --pr scoping", () => {
    it("requires both flags together", () => {
      expect(() => parseCliOptions(["--repo", "a/b"])).toThrow(/both --repo .* and --pr/);
      expect(() => parseCliOptions(["--pr", "5"])).toThrow(/both --repo .* and --pr/);
    });

    it("parses a valid scope", () => {
      expect(parseCliOptions(["--repo", "octo/hello", "--pr", "42"]).scope).toEqual({
        owner: "octo",
        repo: "hello",
        pullNumber: 42,
      });
    });

    it.each(["nofslash", "a/b/c", "/b", "a/"])("rejects invalid repo %s", (repo) => {
      expect(() => parseCliOptions(["--repo", repo, "--pr", "1"])).toThrow(/Invalid --repo/);
    });

    it.each(["0", "-3", "1.5", "abc"])("rejects invalid PR number %s", (pr) => {
      expect(() => parseCliOptions(["--repo", "a/b", "--pr", pr])).toThrow(/Invalid --pr/);
    });
  });
});
