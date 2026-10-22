// Test-only clock skew. With HAGGLE_TEST_CLOCK_SKEW=<ISO date> set, the process's wall clock reads
// as that date (and keeps ticking): `Date.now()`, `new Date()` and `Date()` are shifted by a fixed
// offset; dates built from explicit arguments are untouched. Without the env var this file does
// nothing. Loaded with `node --import` (NODE_OPTIONS), so vitest workers and any server a test spawns
// see the same skewed clock. Tests that call vi.useFakeTimers() install their own Date on top and get
// this one back on vi.useRealTimers(). Used by scripts/test-clock-skew.sh to prove the suites don't
// depend on the real date.
const target = process.env.HAGGLE_TEST_CLOCK_SKEW;
if (target && !globalThis.__haggleClockSkew) {
  const RealDate = Date;
  const at = RealDate.parse(target);
  if (Number.isNaN(at)) throw new Error(`HAGGLE_TEST_CLOCK_SKEW is not a date: ${target}`);
  const offset = at - RealDate.now();
  const skewedNow = () => RealDate.now() + offset;
  globalThis.Date = new Proxy(RealDate, {
    construct(t, args, newTarget) {
      return Reflect.construct(t, args.length === 0 ? [skewedNow()] : args, newTarget === globalThis.Date ? t : newTarget);
    },
    apply() { return new RealDate(skewedNow()).toString(); },
    get(t, key, receiver) { return key === "now" ? skewedNow : Reflect.get(t, key, receiver); },
  });
  globalThis.__haggleClockSkew = { target, offset };
}
