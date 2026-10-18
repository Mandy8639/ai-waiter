import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { TwoFactorVerifyForm } from "@/components/auth/two-factor-verify-form";
import { signOut } from "@/lib/auth/actions";
import { isInviteToken } from "@/lib/staff/invitations-core";
import { allowedNextPath } from "@/lib/auth/password-reset-core";

export const metadata = {
  title: "Verification code — Tableside",
};

/**
 * The second step of signing in, for accounts with two-step verification
 * on. src/proxy.ts only lets a signed-in person who still owes a code
 * reach this page, and sends them here from every operator page until
 * they enter one.
 */
export default async function TwoFactorVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; redirectTo?: string }>;
}) {
  const { invite, redirectTo } = await searchParams;
  const inviteToken = isInviteToken(invite) ? invite : undefined;
  const next = allowedNextPath(redirectTo) ?? undefined;

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-xl font-medium">Enter your code</h1>
          <CardDescription>
            Open your authenticator app and enter the 6-digit code for
            Tableside.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <TwoFactorVerifyForm inviteToken={inviteToken} next={next} />
          <div className="text-muted-foreground flex flex-col items-center gap-3 text-center text-sm">
            <p>
              Lost your phone? Use the setup key you saved to add Tableside to
              another authenticator app, or{" "}
              <Link href="/support" className="underline underline-offset-4">
                contact support
              </Link>
              .
            </p>
            <form action={signOut}>
              <button
                type="submit"
                className="text-foreground font-medium underline-offset-4 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
