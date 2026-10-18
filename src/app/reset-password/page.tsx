import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { getCurrentUser } from "@/lib/auth/session";
import { hasValidResetMarker } from "@/lib/auth/password-reset-server";
import { PRIVATE_PAGE_ROBOTS } from "@/lib/seo/metadata";

export const metadata = {
  title: "Choose a new password — Tableside",
  robots: PRIVATE_PAGE_ROBOTS,
};

/**
 * The last step of "Forgot password?", reached from the emailed link via
 * /auth/confirm. Only a session that came through a real link (and, with
 * two-step verification on, entered a code; src/proxy.ts) gets the form.
 * Anyone else is pointed to the link request or to Account.
 */
export default async function ResetPasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const fromLink = await hasValidResetMarker(user.id);

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-xl font-medium">Choose a new password</h1>
          <CardDescription>
            {fromLink
              ? "After this, any other devices signed in to your account are signed out."
              : "This page only works from a password-reset link, for 15 minutes after opening it."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {fromLink ? (
            <ResetPasswordForm />
          ) : (
            <p className="text-sm">
              <Link
                href="/forgot-password"
                className="font-medium underline underline-offset-4"
              >
                Send a new reset link
              </Link>
              , or change your password from{" "}
              <Link href="/account" className="underline underline-offset-4">
                your account
              </Link>{" "}
              if you know the current one.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
