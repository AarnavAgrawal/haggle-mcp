// PURE: when a call or a first text may reach a business, given its opening hours (from its listing
// or website) and the operator's own limits. A business is rung or texted only while it is open and
// not in the first or last 30 minutes of an opening interval, in its own timezone, AND inside the
// operator's HAGGLE_CALL_HOURS (calls) or contact window (texts). Unknown hours: today's behaviour.
// Emails are not gated here (they keep the contact window in contactWindow.ts).
import { businessHoursRule, earliestSlot, type ContactRule, type WeeklyHours } from "../reputation/hours.ts";
import { isWithinCallHours, nextCallHoursStart, type CallHours } from "./callPolicy.ts";
import { isOpen, nextOpen, type ContactWindowConfig } from "./contactWindow.ts";

/**
 * Null when a call may be placed now; else the next time it may. `timezone` is the operator's (call
 * hours) and the fallback for hours that carry none. If the business's hours and the call hours never
 * meet, the call hours alone decide (today's behaviour).
 */
export function callSlot(now: Date, o: { callHours?: CallHours | undefined; timezone: string; business?: WeeklyHours | null | undefined }): Date | null {
  const cap: ContactRule | null = o.callHours ? { allows: (t) => isWithinCallHours(t, o.timezone, o.callHours), next: (t) => nextCallHoursStart(t, o.timezone, o.callHours!) } : null;
  const rules = [cap, o.business ? businessHoursRule(o.business, o.timezone) : null].filter((r): r is ContactRule => r !== null);
  if (!rules.length) return null;
  const at = earliestSlot(now, rules);
  if (at) return at.getTime() <= now.getTime() ? null : at;
  return cap && !cap.allows(now) ? cap.next(now) : null;
}

/**
 * A first text to a business with known hours: null when it may go now (as far as its hours go; the
 * contact window is still applied by the caller), else the next time both its hours and the contact
 * window allow. Never-meeting rules fall back to the caller's usual decision (null).
 */
export function textSlot(now: Date, hours: WeeklyHours, window: ContactWindowConfig | null | undefined, timezone: string): Date | null {
  const tz = window?.timezone ?? timezone;
  const rules: ContactRule[] = [businessHoursRule(hours, timezone), ...(window ? [{ allows: (t: Date) => isOpen(t, window, tz), next: (t: Date) => nextOpen(t, window, tz) }] : [])];
  const at = earliestSlot(now, rules);
  return at && at.getTime() > now.getTime() ? at : null;
}
