import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { AuthForm } from "@/components/auth/auth-form";
import { signUp } from "@/lib/auth/actions";

export const metadata = {
  title: "Sign up — AI Waiter",
};

export default function SignupPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-xl font-medium">Create an account</h1>
          <CardDescription>
            Set up your account, then create your restaurant.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <AuthForm
            action={signUp}
            submitLabel="Create account"
            pendingLabel="Creating account…"
            passwordAutoComplete="new-password"
            passwordHint="At least 8 characters."
          />
          <p className="text-muted-foreground text-center text-sm">
            Already have an account?{" "}
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
