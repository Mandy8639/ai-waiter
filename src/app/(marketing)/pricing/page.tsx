import Link from "next/link";
import { Check } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { PageHero } from "@/components/marketing/page-hero";
import { Section, SectionHeading } from "@/components/marketing/section";
import { Faq, type FaqItem } from "@/components/marketing/faq";
import { ClosingCta } from "@/components/marketing/closing-cta";

export const metadata = publicPageMetadata({
  title: "Pricing — Tableside",
  description:
    "Tableside is free to use: no monthly fee and no commission on your orders. Card processing is charged by Stripe or Square at their usual rates.",
  path: "/pricing",
});

/**
 * Tableside is free for everyone (decided 2026-10-28) and the page says so
 * plainly. The paid-plan code still exists but isn't offered, so no tiers
 * or prices appear here. The promise about notice is the same one the old
 * landing page made; keep the two in step if it ever changes.
 */

const INCLUDED = [
  "QR menus for every table",
  "The AI waiter, with allergy care",
  "Live kitchen board and ticket printing",
  "Private guest feedback",
  "Staff app for iPhone and Android",
  "Card payments and split bills, when you're ready",
  "Menu import and translations",
];

const FAQ: FaqItem[] = [
  {
    q: "Is there really no fee on my orders?",
    a: "None from Tableside. Every order and every tip is yours. If guests pay by card, your payment processor charges its usual fee, the same as it would at your counter.",
  },
  {
    q: "Who charges the card processing fee?",
    a: "Stripe or Square, whichever you connect, at the rates in your own account with them. Tableside doesn't add anything on top.",
  },
  {
    q: "Will it stay free?",
    a: "If we ever introduce paid plans, we'll tell you well before anything changes, and nothing is charged unless you choose a plan.",
  },
  {
    q: "Do I have to buy hardware?",
    a: "No. A tablet or laptop you already own can run the kitchen board. A kitchen printer and a card reader are optional extras.",
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title={
          <>
            Free to use. <em className="text-primary">No commission.</em>
          </>
        }
        lead="No monthly fee, no setup fee and no cut of your sales. Every feature is included."
      />

      <Section labelledBy="plan-heading">
        <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
          <div className="bg-card rounded-3xl border p-8 shadow-[var(--shadow-card)] sm:p-10">
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <h2 id="plan-heading" className="mk-display text-4xl">
                Tableside
              </h2>
              <p className="flex items-baseline gap-2">
                <span className="mk-display text-6xl">$0</span>
                <span className="text-muted-foreground text-sm">per month</span>
              </p>
            </div>
            <p className="text-muted-foreground mt-3">
              Everything, for every restaurant.
            </p>
            <ul className="mt-8 grid gap-3 sm:grid-cols-2">
              {INCLUDED.map((item) => (
                <li key={item} className="flex gap-3 text-sm">
                  <Check
                    className="text-primary mt-0.5 size-4 shrink-0"
                    aria-hidden
                  />
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-10 flex flex-wrap gap-3">
              <Link href="/signup" className={buttonVariants({ size: "lg" })}>
                Get started free
              </Link>
              <Link
                href="/demo"
                className={buttonVariants({ variant: "outline", size: "lg" })}
              >
                Try the live demo
              </Link>
            </div>
          </div>

          <div className="flex flex-col gap-6 rounded-3xl border border-dashed p-8 sm:p-10">
            <h3 className="mk-eyebrow text-muted-foreground">
              What you might pay elsewhere
            </h3>
            <dl className="flex flex-col gap-5 text-sm">
              <div>
                <dt className="font-medium">Card processing</dt>
                <dd className="text-muted-foreground mt-1">
                  Charged by Stripe or Square at your account&apos;s rates, only
                  when a guest pays by card.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Optional hardware</dt>
                <dd className="text-muted-foreground mt-1">
                  A kitchen printer or card reader, if you want one. Neither is
                  required.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Table codes</dt>
                <dd className="text-muted-foreground mt-1">
                  Print them yourself from the dashboard, on any printer.
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </Section>

      <Section labelledBy="pricing-faq-heading" innerClassName="pt-0 sm:pt-0">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <SectionHeading
            id="pricing-faq-heading"
            eyebrow="Questions"
            title="About the price."
          />
          <Faq items={FAQ} />
        </div>
      </Section>

      <ClosingCta />
    </>
  );
}
