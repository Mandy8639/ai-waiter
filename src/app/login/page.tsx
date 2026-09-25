import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { AuthForm } from "@/components/auth/auth-form";
import { isInviteToken } from "@/lib/staff/invitations-core";
import { signIn } from "@/lib/auth/actions";

export const metadata = {
  title: "Sign in — Tableside",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  // Arrived from a staff invitation link, so sign-in should return them to
  // it rather than dropping them on the dashboard.
  const { invite } = await searchParams;
  const inviteToken = isInviteToken(invite) ? invite : undefined;

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-xl font-medium">Sign in</h1>
          <CardDescription>
            {inviteToken
              ? "Sign in to accept your invitation."
              : "Sign in to manage your restaurant."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <AuthForm
            action={signIn}
            submitLabel="Sign in"
            pendingLabel="Signing in…"
            passwordAutoComplete="current-password"
            inviteToken={inviteToken}
          />
          <p className="text-muted-foreground text-center text-sm">
            Don&apos;t have an account?{" "}
            <Link
              href={inviteToken ? `/signup?invite=${inviteToken}` : "/signup"}
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              Sign up
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
