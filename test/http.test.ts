import { describe, expect, it } from "vitest";
import { computeAllowedHosts } from "../src/http.js";

describe("computeAllowedHosts", () => {
  it.each(["127.0.0.1", "localhost", "::1"])(
    "allows only the loopback aliases when bound to %s",
    (bindAddress) => {
      expect(computeAllowedHosts(bindAddress, 4000)).toEqual([
        "127.0.0.1:4000",
        "localhost:4000",
        "[::1]:4000",
      ]);
    },
  );

  it("allows the local names a containerized client may use alongside a non-loopback bind", () => {
    // Container runtimes hand out their own name for the host, and clients are
    // often configured with a loopback alias the runtime maps to the host, so
    // a gateway-only allowlist would reject their Host header with a 403.
    const hosts = computeAllowedHosts("172.17.0.1", 55800);
    expect(hosts).toContain("172.17.0.1:55800");
    expect(hosts).toContain("localhost:55800");
    expect(hosts).toContain("127.0.0.1:55800");
    expect(hosts).toContain("host.docker.internal:55800");
    expect(hosts).toContain("host.containers.internal:55800");
  });

  it("brackets an IPv6 bind address the way it appears in a Host header", () => {
    expect(computeAllowedHosts("fd00::1", 4000)).toContain("[fd00::1]:4000");
  });

  it("never lists a name without the bound port, so a different port cannot match", () => {
    for (const host of computeAllowedHosts("172.17.0.1", 55800)) {
      expect(host.endsWith(":55800")).toBe(true);
    }
  });
});
