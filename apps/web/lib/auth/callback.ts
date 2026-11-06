// Emailed sign-in links. The Supabase Magic Link template points at /auth/confirm with a token_hash
// (docs/production-deploy.md), because the waitlist's admit email is requested by the operator's script, so
// the person's browser holds no PKCE verifier. The link only opens a page: signing in takes a press of its
// button. So a mail scanner that opens links can't use up the one-time token, and a link someone else sends
// you can't quietly sign you in to their account just by being opened.

type EmailLinkType = "email" | "magiclink";

export interface EmailLinkAuth {
  verifyOtp(params: { token_hash: string; type: EmailLinkType }): PromiseLike<{ error: unknown }>;
}

/** Only sign-in links: a recovery or email-change link must not sign anyone in here. */
const isEmailLink = (type: unknown): type is EmailLinkType => type === "email" || type === "magiclink";

/** True when a session was started. */
export async function confirmEmailLink(link: { token_hash: unknown; type: unknown }, auth: EmailLinkAuth): Promise<boolean> {
  const { token_hash, type } = link;
  if (typeof token_hash !== "string" || !token_hash || !isEmailLink(type)) return false;
  return !(await auth.verifyOtp({ token_hash, type })).error;
}

/** Supabase refused to create an account (sign-ups are off): someone new, coming back from Google. */
export const refusedNewAccount = (params: URLSearchParams) => params.get("error_code") === "signup_disabled";
