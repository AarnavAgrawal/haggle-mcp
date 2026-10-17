import { describe, expect, it } from "vitest";
import { loadDirectory, routeChannel } from "../src/directory.ts";

describe("directory overrides", () => {
  it("defaults to the fixture fleet", () => {
    const d = loadDirectory(undefined, undefined);
    expect(d.find((b) => b.id === "biz_mission_eats")?.phone).toBe("+14155550134");
  });

  it("merges HAGGLE_DIRECTORY_JSON over the defaults by id (hosted deploys)", () => {
    const d = loadDirectory(undefined, JSON.stringify([{ id: "biz_mission_eats", phone: "+16505550123" }]));
    const me = d.find((b) => b.id === "biz_mission_eats")!;
    expect(me).toMatchObject({ name: "Mission Eats", phone: "+16505550123" });
    expect(routeChannel(me)).toBe("phone");
    expect(d).toHaveLength(loadDirectory(undefined, undefined).length);
  });

  it("refuses a malformed inline directory with a clear error", () => {
    expect(() => loadDirectory(undefined, "{not json")).toThrow(/HAGGLE_DIRECTORY_JSON/);
  });
});
