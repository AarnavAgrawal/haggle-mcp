import { describe, expect, it } from "vitest";
import { loadDirectory, routeChannel } from "../src/directory.ts";
import { createBrain, MemoryStore } from "../index.ts";
import { normalizeArea } from "../src/normalize.ts";

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

  it("discover finds the SF caterers for a venue or address, not only a bare city name", async () => {
    const brain = createBrain({ store: new MemoryStore() });
    for (const where of ["San Francisco", "YC HQ, San Francisco", "YC HQ", "680 Folsom St, San Francisco, CA 94107", "SF"]) {
      expect((await brain.discover("lunch catering for 200", where, 6)).length, where).toBe(6);
    }
    // A different city the directory knows nothing in is still an honest zero, not SF caterers.
    expect(await brain.discover("catering", "New York, NY", 6)).toHaveLength(0);
    expect(await brain.discover("catering", "Boston", 6)).toHaveLength(0);
    expect(normalizeArea("Bayview Ave, Toronto")).not.toBe("san francisco"); // "bay" alone isn't the Bay Area
    expect(normalizeArea("YC HQ, 680 Folsom St, San Francisco, CA")).toBe("san francisco");
  });

  it("refuses a malformed inline directory with a clear error", () => {
    expect(() => loadDirectory(undefined, "{not json")).toThrow(/HAGGLE_DIRECTORY_JSON/);
  });
});
