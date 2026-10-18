import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { allowedNextPath } from "@/lib/auth/password-reset-core";
import { setResetMarker } from "@/lib/auth/password-reset-server";

/**
 * Where Supabase's password-reset email lands. Signs the person in from
 * the link, marks the session as having come through a real reset link
 * (src/lib/auth/password-reset-core.ts), and sends them on to choose a
 * new password.
 *
 * Takes both link shapes Supabase can send:
 *   - ?code=…, the default email template with this app's PKCE sign-in.
 *     This only works in the browser that asked for the reset, because the
 *     code's other half is a cookie set there.
 *   - ?token_hash=…&type=recovery, from an email template that links here
 *     directly ({{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&
 *     type=recovery&next=/reset-password). This works on any device.
 *     Editing templates needs custom SMTP; docs/security.md.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const next = allowedNextPath(searchParams.get("next"));
  const failed = () =>
    NextResponse.redirect(
      new URL("/forgot-password?link=expired", request.url),
    );

  // Only the reset flow uses this route today.
  if (!next) return failed();

  const supabase = await createClient();
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return failed();
  } else if (tokenHash && searchParams.get("type") === "recovery") {
    const { error } = await supabase.auth.verifyOtp({
      type: "recovery",
      token_hash: tokenHash,
    });
    if (error) return failed();
  } else {
    return failed();
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return failed();

  await setResetMarker(user.id);
  return NextResponse.redirect(new URL(next, request.url));
}
