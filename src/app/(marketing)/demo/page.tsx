import Link from "next/link";
import { ArrowRight, MessageCircle } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { generateTableQrDataUrl, getRequestOrigin } from "@/lib/tables/qr";
import { getDemoTablePath } from "@/lib/marketing/demo-table";
import { PageHero } from "@/components/marketing/page-hero";
import { Section, SectionHeading } from "@/components/marketing/section";
import { ClosingCta } from "@/components/marketing/closing-cta";

export const metadata = publicPageMetadata({
  title: "Live demo — Tableside",
  description:
    "Open a demo restaurant's menu on your phone and ask the waiter anything. No sign-up.",
  path: "/demo",
});

const TRY_ASKING = [
  "Something filling, not too spicy?",
  "What can I eat with a nut allergy?",
  "What's vegetarian and ready quickly?",
  "What goes well with the short rib?",
];

/**
 * The live demo: a fictional restaurant (scripts/create-demo-restaurant.ts)
 * a prospective owner can open as a guest. Until that restaurant exists,
 * or while it's switched off, the page says so instead of offering a
 * link that would 404.
 */
export default async function DemoPage() {
  // A table link, not the bare menu: the waiter and ordering only exist
  // inside a table session.
  const tablePath = await getDemoTablePath();
  const live = tablePath !== null;
  const qr = tablePath
    ? await generateTableQrDataUrl(`${await getRequestOrigin()}${tablePath}`)
    : null;

  return (
    <>
      <PageHero
        eyebrow="Live demo"
        title={
          <>
            Be the guest. <em className="text-primary">Ask the waiter.</em>
          </>
        }
        lead="Lantern Table is a demo restaurant. Open its menu the way a guest would, and ask the waiter anything about the food. No sign-up."
      />

      <Section labelledBy="demo-heading">
        <div className="grid items-start gap-12 lg:grid-cols-[1fr_1fr]">
          <div className="bg-card flex flex-col items-center gap-6 rounded-3xl border p-8 text-center sm:p-10">
            <h2 id="demo-heading" className="mk-display text-4xl">
              {live ? "Scan, or tap to open" : "The demo is being set up"}
            </h2>
            {qr ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL */}
                <img
                  src={qr}
                  alt="QR code that opens the Lantern Table demo menu"
                  width={208}
                  height={208}
                  className="rounded-xl border bg-white p-2"
                />
                <p className="text-muted-foreground text-sm">
                  Point your phone&apos;s camera at the code, just like a guest
                  at the table.
                </p>
                {/* A plain <a>, not <Link>: the table link is a route that
                    starts a guest session, and Link would prefetch it. */}
                <a href={tablePath!} className={buttonVariants({ size: "lg" })}>
                  Open the demo menu
                  <ArrowRight data-icon="inline-end" />
                </a>
                <p className="text-muted-foreground text-xs">
                  Demo orders aren&apos;t cooked or charged.
                </p>
              </>
            ) : (
              <>
                <p className="text-muted-foreground max-w-sm">
                  It will be here shortly. In the meantime, create a free
                  account and see your own menu with the waiter in it.
                </p>
                <Link href="/signup" className={buttonVariants({ size: "lg" })}>
                  Get started free
                </Link>
              </>
            )}
          </div>

          <div className="flex flex-col gap-8">
            <SectionHeading
              eyebrow="Try asking"
              title="Talk to it like you'd talk to a server."
            />
            <ul className="flex flex-col gap-3">
              {TRY_ASKING.map((q) => (
                <li
                  key={q}
                  className="bg-ai-soft text-ai-foreground flex items-center gap-3 rounded-2xl px-4 py-3"
                >
                  <MessageCircle className="size-4 shrink-0" aria-hidden />
                  {q}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-sm">
              Then add something to your order and watch it reach the kitchen.
            </p>
          </div>
        </div>
      </Section>

      <ClosingCta />
    </>
  );
}
