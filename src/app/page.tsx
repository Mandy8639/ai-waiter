import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PRIVACY_POLICY_PATH } from "@/lib/legal/privacy";
import { SUPPORT_PATH } from "@/lib/legal/support";

export const metadata = {
  title: "Tableside — an AI waiter for your restaurant",
  description:
    "Diners scan the table's QR code, ask questions in their own words, and order. Orders land on your kitchen board, and card payments go straight to your own Stripe account.",
};

/**
 * The public landing page, written for a restaurant owner who typed the
 * domain rather than scanning a table code.
 *
 * Diners never arrive here — a QR code takes them straight to
 * /r/<slug>/table/<token>, which redirects into that restaurant's menu. So
 * this page's only reader is someone deciding whether to use the product,
 * and it answers their questions in their order: what it does at the
 * table, what it does for the kitchen, what it costs, and how the money
 * reaches them.
 *
 * The <h1> is the product name; the tagline below it stays "An AI waiter
 * for restaurants", because that is what the thing DOES and a visitor who
 * has never heard of Tableside needs the sentence, not the brand.
 * tests/e2e/home.spec.ts asserts on both.
 */

const HOW_IT_WORKS = [
  {
    step: "1",
    title: "A diner scans the table's code",
    body: "No app, no sign-up. The menu opens on their phone with your photos, prices and modifiers.",
  },
  {
    step: "2",
    title: "They ask, and it answers",
    body: "What's not too spicy, what's good if I'm starving, does this have peanuts, how long will it take. It answers from your menu — your ingredients, allergens and prep times — and never invents a dish or a price.",
  },
  {
    step: "3",
    title: "The order reaches your kitchen",
    body: "Tickets appear on the kitchen board and move through preparing, ready and served. Split one order across tickets, or merge several. The diner sees the status change as it happens.",
  },
  {
    step: "4",
    title: "They pay at the table",
    body: "Card or cash, per order or for the whole table, with an optional tip. Card payments go straight into your own Stripe account.",
  },
];

const PLANS = [
  {
    name: "Starter",
    price: "Free",
    fee: "1% of each card payment",
    note: "Everything included. Cash payments are never charged.",
  },
  {
    name: "Standard",
    price: "$49/month",
    fee: "0.5% of each card payment",
    note: "Pays for itself once cards pass roughly $10,000 a month.",
  },
  {
    name: "Pro",
    price: "$149/month",
    fee: "0.25% of each card payment",
    note: "For busy sites where the percentage matters more than the monthly fee.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-16 px-6 py-16 sm:py-24">
        <section className="flex flex-col items-center gap-6 text-center">
          <Badge variant="secondary" className="tracking-wide uppercase">
            For restaurants
          </Badge>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Tableside
          </h1>
          <p className="text-muted-foreground text-lg text-balance">
            An AI waiter for restaurants.
          </p>
          <p className="text-muted-foreground max-w-xl text-base text-balance">
            Your diners scan the code on the table, ask whatever they&apos;d
            normally ask a server, and order. You get the orders on a kitchen
            board and the money in your own Stripe account.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className={buttonVariants()}>
              Create an account
            </Link>
            <Link
              href="/login"
              className={buttonVariants({ variant: "outline" })}
            >
              Sign in
            </Link>
          </div>
          <p className="text-muted-foreground text-sm">
            Free to start. You review and edit everything the AI knows about
            your menu before a single diner sees it.
          </p>
        </section>

        <section className="flex flex-col gap-6">
          <h2 className="text-2xl font-semibold tracking-tight">
            How it works
          </h2>
          <ol className="flex flex-col gap-4">
            {HOW_IT_WORKS.map((item) => (
              <li key={item.step}>
                <Card>
                  <CardContent className="flex gap-4">
                    <span
                      aria-hidden="true"
                      className="bg-secondary text-secondary-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-medium"
                    >
                      {item.step}
                    </span>
                    <div className="flex flex-col gap-1">
                      <h3 className="font-medium">{item.title}</h3>
                      <p className="text-muted-foreground text-sm">
                        {item.body}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col gap-6">
          <h2 className="text-2xl font-semibold tracking-tight">
            What it costs
          </h2>
          <p className="text-muted-foreground text-sm">
            Card payments go directly to your own Stripe account — this platform
            never holds your money. You pay Stripe&apos;s usual card fee, plus
            our percentage below.
          </p>
          <ul className="flex flex-col gap-4">
            {PLANS.map((plan) => (
              <li key={plan.name}>
                <Card>
                  <CardContent className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-medium">{plan.name}</h3>
                      <span className="text-muted-foreground text-sm">
                        {plan.price} · {plan.fee}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-sm">{plan.note}</p>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            Questions owners ask
          </h2>
          <dl className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <dt className="font-medium">
                Do my diners have to install an app?
              </dt>
              <dd className="text-muted-foreground text-sm">
                No. The code opens a web page on their phone. Nothing to
                install, nothing to sign up for.
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-medium">Can the AI get my menu wrong?</dt>
              <dd className="text-muted-foreground text-sm">
                It can only use what you entered, and it can only place an order
                through the same checks the buttons use. It cannot invent a
                dish, a price or a discount.
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-medium">Who holds the money?</dt>
              <dd className="text-muted-foreground text-sm">
                You do. Each restaurant connects its own Stripe account, and
                payments go straight there. Refunds are handled from your
                dashboard.
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-medium">What if the internet drops?</dt>
              <dd className="text-muted-foreground text-sm">
                Staff can still take orders and record cash in the dashboard,
                and the kitchen board keeps working on any device that has a
                connection.
              </dd>
            </div>
          </dl>
        </section>
      </main>

      <footer className="text-muted-foreground border-t px-6 py-8 text-center text-sm">
        <p>
          Already using Tableside at a table? Scan the code on your table to see
          the menu.
        </p>
        <p className="mt-3">
          <Link
            href={PRIVACY_POLICY_PATH}
            className="underline-offset-4 hover:underline"
          >
            Privacy policy
          </Link>
          {" · "}
          <Link
            href={SUPPORT_PATH}
            className="underline-offset-4 hover:underline"
          >
            Support
          </Link>
        </p>
      </footer>
    </div>
  );
}
