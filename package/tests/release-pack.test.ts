import { describe, it, expect } from "bun:test";
import { archiveName } from "../src/release-pack.js";

describe("release-pack archive names (must match publish.yml assets)", () => {
  it("scoped names map to npm pack's tgz file names", () => {
    expect(archiveName("@agfpd/iapeer-memory-core", "0.4.24")).toBe("agfpd-iapeer-memory-core-0.4.24.tgz");
    expect(archiveName("@agfpd/iapeer-memory", "0.4.24")).toBe("agfpd-iapeer-memory-0.4.24.tgz");
  });
});
