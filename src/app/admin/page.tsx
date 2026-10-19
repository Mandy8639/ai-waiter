import Link from "next/link";
import { ChevronLeft, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/admin/access";
import { aiConfig } from "@/lib/ai/config";
import { getAllModelSettings } from "@/lib/ai/model-settings";
import {
  jobInfo,
  isPaidModel,
  type ModelSource,
} from "@/lib/ai/model-settings-core";
import { PRIVATE_PAGE_ROBOTS } from "@/lib/seo/metadata";

export const metadata = {
  title: "Admin — Tableside",
  robots: PRIVATE_PAGE_ROBOTS,
};

function sourceLabel(source: ModelSource, envVar: string): string {
  switch (source) {
    case "saved":
      return "Saved here";
    case "env":
      return `Vercel variable ${envVar}`;
    case "default":
      return "Built-in default";
  }
}

/**
 * The platform owner's Admin page (docs/admin.md). Phase 1: read-only —
 * which models each AI job uses and where that choice came from. Changing
 * them (with a Test) is Phase 2; spending and history are Phase 3.
 */
export default async function AdminPage() {
  const access = await requirePlatformAdmin();

  if (!access.ok) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <Card>
          <CardContent className="flex flex-col gap-3 p-6">
            <p className="text-sm">
              The Admin page changes what every restaurant&apos;s diners get, so
              it needs two-step verification on your account first.
            </p>
            <Link
              href="/account"
              className={buttonVariants({ className: "self-start" })}
            >
              Turn on two-step verification
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const settings = await getAllModelSettings();
  const provider = aiConfig.provider;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-2">
        <Link
          href="/dashboard"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Dashboard
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ShieldCheck className="text-primary size-6" aria-hidden="true" />
          Admin
        </h1>
        <p className="text-muted-foreground text-sm">
          Platform-wide settings, for you only. Restaurant owners never see this
          page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI models</CardTitle>
          <CardDescription>
            Which models each AI job uses right now, main model first, then the
            backups OpenRouter tries if it&apos;s busy. Changing them from here,
            with a Test before saving, comes next.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {provider === "anthropic" && (
            <p className="text-muted-foreground rounded-md border p-3 text-sm">
              The waiter runs on Anthropic directly (
              <code>AI_PROVIDER=anthropic</code>), so its model comes from
              Vercel, not from this page.
            </p>
          )}
          <ul className="flex flex-col gap-3">
            {settings.map(({ job, resolved }) => {
              const info = jobInfo(job);
              return (
                <li
                  key={job}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{info.label}</p>
                      <p className="text-muted-foreground text-xs">
                        {info.description}
                      </p>
                    </div>
                    <span className="flex flex-wrap gap-1.5">
                      {info.freeOnly && (
                        <Badge variant="outline">Free models only</Badge>
                      )}
                      <Badge variant="secondary">
                        {sourceLabel(resolved.source, info.envVar)}
                      </Badge>
                    </span>
                  </div>
                  {resolved.models.length === 0 ? (
                    <p className="text-destructive text-sm">
                      No usable model is set, so this job is switched off.
                    </p>
                  ) : (
                    <ol className="flex flex-col gap-1 text-sm">
                      {resolved.models.map((model, i) => (
                        <li
                          key={model}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span className="text-muted-foreground w-16 shrink-0 text-xs">
                            {i === 0 ? "Main" : `Backup ${i}`}
                          </span>
                          <code className="text-xs break-all">{model}</code>
                          <Badge
                            variant={
                              isPaidModel(provider, model)
                                ? "default"
                                : "outline"
                            }
                          >
                            {isPaidModel(provider, model) ? "Paid" : "Free"}
                          </Badge>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}
