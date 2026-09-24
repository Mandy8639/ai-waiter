import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { AcceptInvitationButton } from "@/components/staff/accept-invitation-button";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { acceptInvitation } from "@/lib/staff/invitation-actions";
import {
  describeInvitation,
  isInviteToken,
  roleDescription,
  roleLabel,
  type InvitationState,
} from "@/lib/staff/invitations-core";

export const metadata = {
  title: "Join a restaurant — Tableside",
  // Nothing here should ever appear in a search result: the URL IS the
  // credential.
  robots: { index: false, follow: false },
};

interface Preview {
  restaurant_name: string | null;
  invited_role: string | null;
  state: InvitationState;
}

const UNKNOWN: Preview = {
  restaurant_name: null,
  invited_role: null,
  state: "unknown",
};

/**
 * Where an invitation link lands.
 *
 * The visitor is usually a stranger with no account — that is the whole
 * point of phase C — so this page runs signed out and reads the invitation
 * through get_staff_invitation_preview(), the one anon-callable function in
 * 20260926090000. It shows the restaurant's name and the role on offer,
 * because asking someone to create an account for an unnamed organisation
 * is indistinguishable from phishing.
 *
 * Three audiences, in order of how likely they are:
 *   - nobody signed in: sign up (or sign in), come back, accept.
 *   - a real account: accept straight away.
 *   - a diner mid-meal, holding an anonymous session from a table QR code:
 *     they must sign up or in, because a guest identity cannot hold staff
 *     access (accept_staff_invitation() refuses it outright).
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Rejected before any query: a value that is not the token shape cannot
  // match any row, so there is nothing to ask the database.
  const preview: Preview = isInviteToken(token)
    ? await readPreview(token)
    : UNKNOWN;

  const message = describeInvitation(preview.state, preview.restaurant_name);
  const user = await getCurrentUser();
  const isGuestSession = user?.is_anonymous === true;
  const isRealAccount = Boolean(user) && !isGuestSession;

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-xl font-medium">{message.heading}</h1>
          <CardDescription>{message.body}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {message.canAccept && preview.invited_role && (
            <div className="bg-muted rounded-md border p-3 text-sm">
              <p className="font-medium">
                Role: {roleLabel(preview.invited_role)}
              </p>
              <p className="text-muted-foreground">
                {roleDescription(preview.invited_role)}
              </p>
            </div>
          )}

          {message.canAccept && isRealAccount && (
            <AcceptInvitationButton
              onAccept={acceptInvitation.bind(null, token)}
              label={`Join ${preview.restaurant_name ?? "this restaurant"}`}
            />
          )}

          {message.canAccept && !isRealAccount && (
            <div className="flex flex-col gap-3">
              {isGuestSession && (
                <p className="text-muted-foreground text-sm">
                  You&apos;re currently browsing as a guest at a table. Staff
                  access needs a real account — creating one below replaces the
                  guest session on this device.
                </p>
              )}
              <Link
                href={`/signup?invite=${token}`}
                className={buttonVariants({ variant: "default" })}
              >
                Create an account to join
              </Link>
              <p className="text-muted-foreground text-center text-sm">
                Already have a Tableside account?{" "}
                <Link
                  href={`/login?invite=${token}`}
                  className="text-foreground font-medium underline-offset-4 hover:underline"
                >
                  Sign in
                </Link>
              </p>
            </div>
          )}

          {!message.canAccept && (
            <Link
              href="/"
              className="text-muted-foreground text-center text-sm underline-offset-4 hover:underline"
            >
              Go to Tableside
            </Link>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * database.types.ts predates 20260926090000, so the RPC is reached through a
 * named cast confined to this function — the same convention as
 * src/lib/staff/get-invitations.ts.
 */
async function readPreview(token: string): Promise<Preview> {
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const { data, error } = await rpc("get_staff_invitation_preview", {
    p_token: token,
  });

  // A failed read must not become "your invitation is fine, press accept" —
  // it becomes the same dead end as an unrecognised link, and the accept
  // path re-checks everything anyway.
  if (error) return UNKNOWN;

  const row = (Array.isArray(data) ? data[0] : data) as Preview | undefined;
  return row ?? UNKNOWN;
}
