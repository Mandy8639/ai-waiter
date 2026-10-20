import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WaiterModelLine } from "@/components/admin/waiter-model-line";
import type { CatalogueOption } from "@/lib/admin/model-catalogue";
import type { PlanRow } from "@/lib/admin/waiter-override-queries";
import type { ResolvedModels } from "@/lib/ai/model-settings-core";

/**
 * Admin Phase 7: a default waiter model per plan, e.g. a paid, smarter
 * waiter for Pro and the free one for Starter. A restaurant's own choice
 * (Restaurants card) still wins over its plan's. Tested on the sample
 * menu, since a plan serves restaurants that haven't signed up yet.
 */
export function PlanWaiterCard({
  plans,
  platform,
  options,
}: {
  plans: PlanRow[];
  platform: ResolvedModels;
  options: CatalogueOption[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Waiter model per plan</CardTitle>
        <CardDescription>
          Give every restaurant on a plan its own waiter, for example a paid,
          smarter one on Pro. A model set for one restaurant (in Restaurants)
          still wins. The Cost table shows what each restaurant&apos;s waiter
          costs you.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {plans.map((plan) => (
          <div
            key={plan.id}
            className="flex flex-col gap-1 rounded-lg border p-3"
          >
            <p className="font-medium">
              {plan.name}
              {plan.isDefault && (
                <span className="text-muted-foreground text-xs font-normal">
                  {" "}
                  · restaurants without a plan
                </span>
              )}
            </p>
            <WaiterModelLine
              target={{ planId: plan.id }}
              name={`The ${plan.name} plan`}
              models={plan.models ?? platform.models}
              source={plan.models ? "plan" : platform.source}
              own={plan.models}
              options={options}
              defaultLabel="the same as everyone"
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
