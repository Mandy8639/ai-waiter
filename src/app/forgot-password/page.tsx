import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { PRIVATE_PAGE_ROBOTS } from "@/lib/seo/metadata";

export const metadata = {
  title: "Forgot password — Tableside",
  robots: PRIVATE_PAGE_ROBOTS,
};

/**
 * Sends a password-reset link (src/lib/auth/password-actions.ts). Also
 * where /auth/confirm sends someone whose link didn't work (?link=expired).
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ link?: string }>;
}) {
  const { link } = await searchParams;

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-xl font-medium">Reset your password</h1>
          <CardDescription>
            Enter the email you sign in with and we&apos;ll send you a link to
            choose a new password.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {link === "expired" && (
            <Alert variant="destructive">
              <AlertDescription>
                That link has expired or was already used. Links work once, for
                1 hour, and on the same device and browser you asked from.
                Request a new one below.
              </AlertDescription>
            </Alert>
          )}
          <ForgotPasswordForm />
          <p className="text-muted-foreground text-center text-sm">
            Remembered it?{" "}
            <Link
              href="/login"
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
