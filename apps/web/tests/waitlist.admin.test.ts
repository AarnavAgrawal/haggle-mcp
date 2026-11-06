// The operator CLI (scripts/waitlist-admin.ts) with a fake repository: no Supabase, nothing emailed.
// Admitting is the one action that gives a stranger access, so the wrong project, a retry and an address
// that can't receive mail all have to behave.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planCommand, projectRefOf, runCommand, type WaitlistEntry, type WaitlistRepo } from "../scripts/waitlist-admin.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const REF = "abcdefghijkl";
const opts = { projectRef: REF, host: `${REF}.supabase.co`, now: () => NOW };

const entry = (over: Partial<WaitlistEntry> = {}): WaitlistEntry => ({
  email: "ada@example.com", full_name: "Ada Lovelace", organization: "Analytical Engines", use_case: "Cater our offsite",
  created_at: "2026-11-01T09:00:00.000Z", admitted_at: null, admitted_by: null, notified_at: null, ...over,
});

function repo(initial: WaitlistEntry[] = [entry()], over: Partial<WaitlistRepo> = {}) {
  const rows = new Map(initial.map((r) => [r.email, { ...r }]));
  const log: string[] = [];
  const r: WaitlistRepo = {
    list: async (filter) => [...rows.values()].filter((x) => filter === "all" || (filter === "admitted") === !!x.admitted_at),
    find: async (email) => rows.get(email) ?? null,
    insert: async (row) => {
      rows.set(row.email, entry({ ...row }));
    },
    markAdmitted: async (email, by, at) => {
      log.push(`admit ${email}`);
      Object.assign(rows.get(email)!, { admitted_at: at, admitted_by: by });
    },
    markNotified: async (email, at) => {
      log.push(`notified ${email}`);
      rows.get(email)!.notified_at = at;
    },
    remove: async (email) => {
      log.push(`remove ${email}`);
      rows.delete(email);
    },
    ensureUser: async (email) => {
      log.push(`user ${email}`);
    },
    sendLink: async (email) => {
      log.push(`link ${email}`);
    },
    ...over,
  };
  return { r, rows, log };
}

describe("planCommand", () => {
  it("reads list filters, defaulting to who is waiting", () => {
    expect(planCommand(["list"])).toEqual({ kind: "list", filter: "waiting" });
    expect(planCommand(["list", "--admitted"])).toEqual({ kind: "list", filter: "admitted" });
    expect(planCommand(["list", "--all"])).toEqual({ kind: "list", filter: "all" });
  });

  it("reads an admit, lowercasing emails", () => {
    expect(planCommand(["admit", "Ada@Example.com", "b@example.com", "--by", "Aarnav", "--target", REF])).toEqual({ kind: "admit", emails: ["ada@example.com", "b@example.com"], by: "Aarnav", target: REF, noEmail: false });
  });

  it("reads --no-email, --name and --org", () => {
    expect(planCommand(["admit", "a@example.com", "--by", "A", "--target", REF, "--no-email", "--name", "Ada L", "--org", "AE"])).toMatchObject({ noEmail: true, name: "Ada L", org: "AE" });
  });

  it.each([
    [["admit", "a@example.com", "--target", REF], /--by/],
    [["admit", "a@example.com", "--by", "A"], /--target/],
    [["admit", "--by", "A", "--target", REF], /email/],
    [["admit", "not-an-email", "--by", "A", "--target", REF], /not-an-email/],
    [["remove", "a@example.com", "--by", "A"], /--target/],
    [["admit", "a@example.com", "--by", "A", "--target", REF, "--bogus"], /--bogus/],
    [["admit", "a@example.com", "b@example.com", "--by", "A", "--target", REF, "--name", "Ada"], /one person/],
    [["launch"], /list, admit, remove/],
    [[], /list, admit, remove/],
  ])("refuses %j", (argv, message) => {
    expect(() => planCommand(argv)).toThrow(message);
  });
});

describe("projectRefOf", () => {
  it("is the first label of the Supabase host", () => {
    expect(projectRefOf(`https://${REF}.supabase.co`)).toBe(REF);
  });
});

describe("list", () => {
  it("names the target project and shows what was typed, for the operator to judge", async () => {
    const { text, failed } = await runCommand({ kind: "list", filter: "waiting" }, repo().r, opts);
    expect(failed).toBe(false);
    for (const part of [`${REF}.supabase.co`, "Ada Lovelace", "Analytical Engines", "ada@example.com", "Cater our offsite", "2026-11-01"]) expect(text).toContain(part);
  });

  it("says so when nobody matches", async () => {
    expect((await runCommand({ kind: "list", filter: "waiting" }, repo([]).r, opts)).text).toContain("Nobody");
  });
});

describe("admit", () => {
  const admit = (over = {}) => ({ kind: "admit" as const, emails: ["ada@example.com"], by: "Aarnav", target: REF, noEmail: false, ...over });

  it("refuses the wrong project before changing anything", async () => {
    const { r, log } = repo();
    const out = await runCommand(admit({ target: "otherproject" }), r, opts);
    expect(out.failed).toBe(true);
    expect(out.text).toContain(REF);
    expect(log).toEqual([]);
  });

  it("admits first, then makes the sign-in, sends the link and records it", async () => {
    const { r, rows, log } = repo();
    const out = await runCommand(admit(), r, opts);
    expect(log).toEqual(["admit ada@example.com", "user ada@example.com", "link ada@example.com", "notified ada@example.com"]);
    expect(rows.get("ada@example.com")).toMatchObject({ admitted_at: NOW.toISOString(), admitted_by: "Aarnav", notified_at: NOW.toISOString() });
    expect(out.failed).toBe(false);
    expect(out.text).toContain("Ada Lovelace");
  });

  it("keeps the admission when the email fails, and reports it", async () => {
    const { r, rows } = repo([entry()], { sendLink: async () => { throw new Error("smtp down"); } });
    const out = await runCommand(admit(), r, opts);
    expect(out.failed).toBe(true);
    expect(out.text).toContain("smtp down");
    expect(rows.get("ada@example.com")).toMatchObject({ admitted_by: "Aarnav", notified_at: null });
  });

  it("a rerun retries only the people not yet notified, and keeps who admitted them", async () => {
    const { r, rows, log } = repo([
      entry({ admitted_at: "2026-11-04T00:00:00.000Z", admitted_by: "Yash" }),
      entry({ email: "b@example.com", admitted_at: "2026-11-04T00:00:00.000Z", admitted_by: "Yash", notified_at: "2026-11-04T00:00:00.000Z" }),
    ]);
    await runCommand(admit({ emails: ["ada@example.com", "b@example.com"] }), r, opts);
    expect(log).toEqual(["user ada@example.com", "link ada@example.com", "notified ada@example.com"]);
    expect(rows.get("ada@example.com")?.admitted_by).toBe("Yash");
  });

  it("--no-email admits and sends nothing", async () => {
    const { r, log } = repo();
    await runCommand(admit({ noEmail: true }), r, opts);
    expect(log).toEqual(["admit ada@example.com"]);
  });

  it("never emails a synthetic password-account address", async () => {
    const email = "ycombinator@users.tryhaggle.tech";
    const { r, log } = repo([entry({ email })]);
    const out = await runCommand(admit({ emails: [email] }), r, opts);
    expect(log).toEqual([`admit ${email}`]);
    expect(out.failed).toBe(false);
  });

  it("refuses someone not on the list without a name and organization", async () => {
    const { r, log } = repo([]);
    const out = await runCommand(admit({ noEmail: true }), r, opts);
    expect(out.failed).toBe(true);
    expect(out.text).toMatch(/--name/);
    expect(log).toEqual([]);
  });

  it("adds someone not on the list when given a name and organization", async () => {
    const { r, rows } = repo([]);
    await runCommand(admit({ noEmail: true, name: "Ada L", org: "AE" }), r, opts);
    expect(rows.get("ada@example.com")).toMatchObject({ full_name: "Ada L", organization: "AE", admitted_by: "Aarnav" });
  });

  it("one person's failure doesn't stop the rest", async () => {
    const { r, log } = repo([entry(), entry({ email: "b@example.com" })], { sendLink: async (e) => { if (e === "ada@example.com") throw new Error("smtp down"); log2.push(e); } });
    const log2: string[] = [];
    const out = await runCommand(admit({ emails: ["ada@example.com", "b@example.com"] }), r, opts);
    expect(out.failed).toBe(true);
    expect(log2).toEqual(["b@example.com"]);
    expect(log).toContain("notified b@example.com");
  });
});

describe("remove", () => {
  it("refuses the wrong project", async () => {
    const { r, log } = repo();
    expect((await runCommand({ kind: "remove", email: "ada@example.com", by: "A", target: "nope" }, r, opts)).failed).toBe(true);
    expect(log).toEqual([]);
  });

  it("removes an entry", async () => {
    const { r, rows } = repo();
    await runCommand({ kind: "remove", email: "ada@example.com", by: "A", target: REF }, r, opts);
    expect(rows.size).toBe(0);
  });

  it("says so when there is nothing to remove", async () => {
    expect((await runCommand({ kind: "remove", email: "nobody@example.com", by: "A", target: REF }, repo([]).r, opts)).failed).toBe(true);
  });
});

describe("plain node", () => {
  it("loads under Node's type stripping and prints usage without touching a database", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "waitlist-admin.ts");
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("list, admit, remove");
  });
});
