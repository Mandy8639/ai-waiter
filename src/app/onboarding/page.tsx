import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { requireUser } from "@/lib/auth/session";

export const metadata = {
  title: "Create your restaurant — AI Waiter",
};

export default async function OnboardingPage() {
  await requireUser();

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <h1 className="text-xl font-medium">Create your restaurant</h1>
          <CardDescription>
            You&apos;ll be the owner. You can add staff and fill in the rest of
            the details later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OnboardingForm />
        </CardContent>
      </Card>
    </div>
  );
}
