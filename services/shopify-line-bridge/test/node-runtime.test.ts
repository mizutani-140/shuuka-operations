import { describe, expect, it } from "vitest";
import { supportsNodeVersion } from "../scripts/check-node.mjs";

describe("Node CLI security releases", () => {
  it.each(["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0"])(
    "accepts patched release %s",
    (version) => expect(supportsNodeVersion(version)).toBe(true),
  );
  it.each(["20.20.0", "22.23.3", "24.22.0", "26.12.0", "23.0.0", "25.0.0", "27.0.0", "22.23.4-rc.1", ""])(
    "rejects unpatched, unsupported or invalid release %s",
    (version) => expect(supportsNodeVersion(version)).toBe(false),
  );
});
