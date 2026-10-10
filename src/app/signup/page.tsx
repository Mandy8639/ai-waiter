import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { AuthForm } from "@/components/auth/auth-form";
import { isInviteToken } from "@/lib/staff/invitations-core";
import { signUp } from "@/lib/auth/actions";
import { PRIVACY_POLICY_PATH } from "@/lib/legal/privacy";

export const metadata = {
  title: "Sign up — Tableside",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const { invite } = await searchParams;
  const inviteToken = isInviteToken(invite) ? invite : undefined;

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-xl font-medium">Create an account</h1>
          <CardDescription>
            {inviteToken
              ? "Set up your account, then accept your invitation."
              : "Set up your account, then create your restaurant."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <AuthForm
            action={signUp}
            submitLabel="Create account"
            pendingLabel="Creating account…"
            passwordAutoComplete="new-password"
            passwordHint="At least 8 characters."
            inviteToken={inviteToken}
          />
          <p className="text-muted-foreground text-center text-sm">
            Already have an account?{" "}
            <Link
              href={inviteToken ? `/login?invite=${inviteToken}` : "/login"}
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </p>
          <p className="text-muted-foreground text-center text-xs">
            How we handle your information:{" "}
            <Link
              href={PRIVACY_POLICY_PATH}
              className="underline underline-offset-4"
            >
              Privacy policy
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
