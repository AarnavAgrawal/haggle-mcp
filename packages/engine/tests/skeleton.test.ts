import { describe, expect, it } from "vitest";
import { ENGINE_PACKAGE } from "../src/index.ts";

describe("engine skeleton", () => {
  it("is wired into the workspace test run", () => {
    expect(ENGINE_PACKAGE).toBe("@haggle/engine");
  });
});
