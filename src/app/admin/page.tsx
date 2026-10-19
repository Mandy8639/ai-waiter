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
import { ModelEditor } from "@/components/admin/model-editor";
import { catalogueFor } from "@/lib/admin/model-catalogue";
import { getOpenRouterModels } from "@/lib/admin/openrouter-models";
import { getAllModelSettings } from "@/lib/ai/model-settings";
import {
  jobInfo,
  isPaidModel,
  type ModelSource,
} from "@/lib/ai/model-settings-core";
import { PRIVATE_PAGE_ROBOTS } from "@/lib/seo/metadata";

// A Test runs inside this page's server action; the menu-photo reader's
// takes up to 120 s (src/lib/admin/model-test.ts).
export const maxDuration = 150;

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
 * The platform owner's Admin page (docs/admin.md): which models each AI
 * job uses, where that choice came from, and (Phase 2) a Change → Test →
 * Save editor for each. Spending and history are Phase 3.
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

  const [settings, known] = await Promise.all([
    getAllModelSettings(),
    getOpenRouterModels(),
  ]);
  const provider = aiConfig.provider;
  const canTest = !!process.env.OPENROUTER_API_KEY;

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
            backups OpenRouter tries if it&apos;s busy. To change one, press
            Change, run Test, and Save once it passes. A Test on a paid model
            spends a little credit and shows what it cost.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!canTest && (
            <p className="text-muted-foreground rounded-md border p-3 text-sm">
              <code>OPENROUTER_API_KEY</code> isn&apos;t set, so models
              can&apos;t be tested or changed here.
            </p>
          )}
          {known === null && (
            <p className="text-muted-foreground rounded-md border p-3 text-sm">
              Couldn&apos;t load OpenRouter&apos;s model list just now, so
              prices aren&apos;t shown and changes can&apos;t be saved. Reload
              in a few minutes.
            </p>
          )}
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
                  {canTest &&
                    !(job === "waiter" && provider !== "openrouter") && (
                      <ModelEditor
                        job={job}
                        label={info.label}
                        freeOnly={info.freeOnly}
                        current={resolved.models}
                        options={catalogueFor(job, resolved.models, known)}
                      />
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
