// Refused sign-ins: only the operator's `admit` makes an account (apps/web/scripts/waitlist-admin.ts).

/** Where someone goes when they try to sign in without an account: only `admit` makes one. */
export const NO_ACCOUNT_PATH = "/waitlist?from=sign-in";

/** Supabase's message when an email has no account and won't get one. */
export const refusedSignup = (message: string) => /signups? not allowed/i.test(message);

/** Supabase refused to create an account (sign-ups are off): someone new, coming back from Google. */
export const refusedNewAccount = (params: URLSearchParams) => params.get("error_code") === "signup_disabled" || refusedSignup(params.get("error_description") ?? "");
