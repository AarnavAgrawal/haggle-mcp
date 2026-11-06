// Finishing a sign-in on /auth/callback. Google returns ?code=, which needs the PKCE verifier this browser
// stored when it started. An emailed link returns ?token_hash=&type=, which needs no verifier: the Supabase
// Magic Link template must point here (docs/production-deploy.md), because the waitlist's admit email is
// requested by the operator's script, so the person's browser never started that sign-in.

type EmailLinkType = "email" | "magiclink";

export interface CallbackAuth {
  exchangeCodeForSession(code: string): PromiseLike<{ error: unknown }>;
  verifyOtp(params: { token_hash: string; type: EmailLinkType }): PromiseLike<{ error: unknown }>;
}

/** Only sign-in links: a recovery or email-change link must not sign anyone in here. */
const isEmailLink = (type: string | null): type is EmailLinkType => type === "email" || type === "magiclink";

/** True when a session was started. */
export async function finishSignIn(params: URLSearchParams, auth: CallbackAuth): Promise<boolean> {
  const code = params.get("code");
  if (code) return !(await auth.exchangeCodeForSession(code)).error;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  if (tokenHash && isEmailLink(type)) return !(await auth.verifyOtp({ token_hash: tokenHash, type })).error;
  return false;
}
