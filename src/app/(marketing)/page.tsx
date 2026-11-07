import Link from "next/link";
import {
  ArrowRight,
  Bell,
  ChefHat,
  CreditCard,
  FileUp,
  MessageSquareHeart,
  Languages,
  Printer,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { JsonLd } from "@/components/seo/json-ld";
import { organizationJsonLd } from "@/lib/seo/structured-data";
import { HeroStage } from "@/components/marketing/hero-stage";
import { KitchenTicket } from "@/components/marketing/kitchen-ticket";
import { Reveal } from "@/components/marketing/reveal";
import { Section, SectionHeading } from "@/components/marketing/section";
import { Faq, type FaqItem } from "@/components/marketing/faq";
import { ClosingCta } from "@/components/marketing/closing-cta";

export const metadata = publicPageMetadata({
  title: "Tableside — an AI waiter for your restaurant",
  description:
    "Guests scan the code on the table, ask what they'd ask a server, and order. The ticket reaches your kitchen. Free to use, no commission.",
  path: "/",
});

/**
 * The public landing page, written for a restaurant owner who typed the
 * domain rather than scanning a table code.
 *
 * Diners never arrive here — a QR code takes them straight to
 * /r/<slug>/table/<token>, which redirects into that restaurant's menu. So
 * this page's only reader is someone deciding whether to use the product.
 *
 * The <h1> carries the product name for search engines and screen readers
 * ahead of the visible headline, and the eyebrow states what the thing
 * DOES; tests/e2e/home.spec.ts asserts on both.
 *
 * Every claim here is something the product does today. No customer names,
 * ratings or numbers: there are no pilot restaurants yet.
 */

const STEPS = [
  {
    title: "Guests scan the code on the table",
    body: "No app and no sign-up. Your menu opens on their phone with photos, prices and the choices you offer.",
  },
  {
    title: "They ask, and the waiter answers",
    body: "What's mild, what's filling, what has nuts, how long it takes. Answers come from your menu, never from a guess.",
  },
  {
    title: "The order reaches your kitchen",
    body: "It lands on the kitchen screen or prints as a ticket. Guests watch it move from preparing to ready.",
  },
  {
    title: "They pay the way they do today",
    body: "At your counter, as usual. Card payments and split bills from the table can be switched on when you're ready.",
  },
];

const FEATURES = [
  {
    icon: Sparkles,
    title: "A waiter on every table",
    body: "Guests ask in their own words, by typing or speaking, and add dishes straight from the answer.",
  },
  {
    icon: ShieldCheck,
    title: "Careful with allergies",
    body: "Allergens are shown as you list them. A dish that conflicts with a guest's allergy is held until they confirm.",
  },
  {
    icon: ChefHat,
    title: "A kitchen board that keeps up",
    body: "Tickets arrive live and move through preparing, ready and served with one tap.",
  },
  {
    icon: Printer,
    title: "Tickets on paper, too",
    body: "Send orders to a kitchen printer so the line can work the way it always has.",
  },
  {
    icon: CreditCard,
    title: "Pay and split at the table",
    body: "Card payments through Stripe or Square, with tips and split bills. Switched on when you're ready.",
  },
  {
    icon: Languages,
    title: "Your menu in their language",
    body: "Offer translations you've approved, so more guests can read the menu without asking.",
  },
];

const FAQ: FaqItem[] = [
  {
    q: "Do guests have to install an app?",
    a: "No. The code on the table opens a web page on their phone. There's nothing to install and nothing to sign up for.",
  },
  {
    q: "Can the AI get my menu wrong?",
    a: "It only uses what you entered, and orders go through the same checks as the buttons. It can't invent a dish, a price or a discount. You review what it knows about your menu before any guest sees it.",
  },
  {
    q: "Do I need new hardware?",
    a: "No. Any tablet or laptop can run the kitchen board. A kitchen printer and a card reader are optional, and you can keep taking payment the way you do today.",
  },
  {
    q: "How long does setup take?",
    a: "Upload a photo or PDF of your menu, paste a link, or import from Square, then check the dishes and print your table codes.",
  },
  {
    q: "What if the internet drops?",
    a: "Your staff take orders the way they always have, and the kitchen board keeps working on any device that still has a connection.",
  },
];

export default function Home() {
  return (
    <>
      <JsonLd data={organizationJsonLd()} />

      {/* Hero */}
      <section className="mk-paper overflow-hidden border-b">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-14 px-4 pt-14 pb-16 sm:px-6 sm:pt-20 lg:grid-cols-[1.1fr_1fr] lg:pb-24">
          <div className="flex flex-col items-start gap-6">
            <p className="mk-eyebrow text-primary">
              An AI waiter for restaurants.
            </p>
            <h1 className="mk-display text-[3.25rem] sm:text-7xl">
              <span className="sr-only">Tableside: </span>
              Your menu, with <em className="text-primary">a waiter</em> in it.
            </h1>
            <p className="text-muted-foreground max-w-lg text-lg text-pretty">
              Guests scan the code on the table, ask what they&apos;d ask a
              server, and order. The ticket reaches your kitchen. Nothing about
              your counter has to change.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/signup" className={buttonVariants({ size: "lg" })}>
                Get started free
              </Link>
              <Link
                href="/demo"
                className={buttonVariants({ variant: "outline", size: "lg" })}
              >
                Try the live demo
                <ArrowRight data-icon="inline-end" />
              </Link>
            </div>
            <p className="text-muted-foreground text-sm">
              Free to use. No commission on your orders.
            </p>
          </div>
          <HeroStage />
        </div>
      </section>

      {/* How it works: a real sequence, so the steps are numbered. */}
      <Section labelledBy="how-heading">
        <SectionHeading
          id="how-heading"
          eyebrow="How it works"
          title="From the table to the kitchen, without the wait."
        />
        <ol className="mt-14 grid gap-px overflow-hidden rounded-2xl border bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="bg-card flex flex-col gap-3 p-6">
              <span className="mk-eyebrow text-muted-foreground">
                Step {i + 1}
              </span>
              <h3 className="text-lg leading-snug font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="text-muted-foreground text-sm">{step.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* The waiter, and why it can be trusted */}
      <Section
        className="dark bg-background text-foreground"
        labelledBy="waiter-heading"
      >
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <div className="flex flex-col gap-8">
            <SectionHeading
              id="waiter-heading"
              eyebrow="The waiter"
              title={
                <>
                  Knows your menu.{" "}
                  <em className="text-[var(--ai)]">Never guesses.</em>
                </>
              }
              lead="Guests get a straight answer about every dish, any time, even on your busiest night. And when an answer matters for someone's health, the waiter slows down."
            />
            <ul className="flex flex-col gap-4">
              {[
                "Answers only from the dishes, ingredients and allergens you entered.",
                "Holds a dish that conflicts with a guest's allergy until they say yes.",
                "You review everything it knows before a single guest sees it.",
              ].map((point) => (
                <li key={point} className="flex gap-3">
                  <ShieldCheck
                    className="mt-0.5 size-5 shrink-0 text-[var(--ai)]"
                    aria-hidden
                  />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>

          <Reveal>
            <figure className="bg-card mx-auto flex max-w-md flex-col gap-3 rounded-3xl border p-5 text-sm">
              <figcaption className="mk-eyebrow text-muted-foreground mb-1">
                Example conversation
              </figcaption>
              <p className="bg-primary text-primary-foreground ml-auto max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2">
                Add the cashew curry. I&apos;m allergic to nuts though.
              </p>
              <p className="bg-ai-soft text-ai-foreground max-w-[88%] rounded-2xl rounded-bl-md px-3.5 py-2.5">
                The Cashew Curry contains tree nuts, as listed by the
                restaurant, so I haven&apos;t added it. The Coconut Vegetable
                Curry has no nuts listed. Want that instead?
              </p>
              <p className="bg-primary text-primary-foreground ml-auto max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2">
                Yes, the coconut one.
              </p>
            </figure>
          </Reveal>
        </div>
      </Section>

      {/* Features */}
      <Section labelledBy="features-heading">
        <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
          <SectionHeading
            id="features-heading"
            eyebrow="What you get"
            title="Everything the floor needs, nothing it doesn't."
          />
          <Link
            href="/features"
            className={cn(
              buttonVariants({ variant: "outline" }),
              "self-start sm:self-auto",
            )}
          >
            All features
            <ArrowRight data-icon="inline-end" />
          </Link>
        </div>
        <ul className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <li key={f.title}>
              <Reveal delay={(i % 3) * 80} className="h-full">
                <div className="bg-card flex h-full flex-col gap-3 rounded-2xl border p-6 transition-shadow hover:shadow-[var(--shadow-float)]">
                  <span className="bg-secondary text-primary flex size-10 items-center justify-center rounded-xl">
                    <f.icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="text-lg font-semibold tracking-tight">
                    {f.title}
                  </h3>
                  <p className="text-muted-foreground text-sm">{f.body}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ul>
      </Section>

      {/* For the kitchen and staff */}
      <Section
        className="bg-secondary/60 border-y"
        labelledBy="kitchen-heading"
      >
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.1fr]">
          <div
            className="relative order-last mx-auto h-[22rem] w-full max-w-sm lg:order-first"
            aria-hidden
          >
            <KitchenTicket
              className="absolute top-2 left-0 -rotate-[4deg]"
              table="TABLE 3"
              orderNumber={139}
              time="7:31 PM"
              lines={[
                { qty: 2, name: "Crispy cauliflower" },
                { qty: 1, name: "Lantern burger", note: "medium" },
              ]}
            />
            <KitchenTicket
              className="absolute top-16 right-0 rotate-[3deg]"
              table="TABLE 12"
              orderNumber={141}
              time="7:38 PM"
              lines={[
                { qty: 1, name: "Coconut veg curry" },
                { qty: 2, name: "Garlic naan" },
                { qty: 1, name: "Mango lassi" },
              ]}
              footer="— allergy: tree nuts —"
            />
          </div>
          <div className="flex flex-col gap-8">
            <SectionHeading
              id="kitchen-heading"
              eyebrow="For your kitchen and staff"
              title="Built for a Saturday night."
              lead="Orders arrive complete, with the guest's notes, at the moment they're placed. Your team spends the night cooking and serving, not writing things down."
            />
            <ul className="grid gap-4 sm:grid-cols-2">
              {[
                { icon: ChefHat, text: "Live kitchen board on any tablet" },
                { icon: Printer, text: "Tickets to a kitchen printer" },
                { icon: Bell, text: "Alerts when a table needs someone" },
                { icon: Smartphone, text: "Staff app for iPhone and Android" },
                {
                  icon: FileUp,
                  text: "Menu import from a photo, PDF or Square",
                },
                {
                  icon: MessageSquareHeart,
                  text: "Private feedback after every meal",
                },
              ].map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-start gap-3 text-sm">
                  <Icon
                    className="text-primary mt-0.5 size-4 shrink-0"
                    aria-hidden
                  />
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* Pricing in one breath */}
      <Section labelledBy="pricing-heading" innerClassName="sm:py-24">
        <div className="bg-card grid gap-8 rounded-3xl border p-8 sm:p-12 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <div className="flex flex-col gap-4">
            <p className="mk-eyebrow text-primary">Pricing</p>
            <h2
              id="pricing-heading"
              className="mk-display text-4xl sm:text-5xl"
            >
              Free to use. No commission on your orders.
            </h2>
            <p className="text-muted-foreground text-pretty">
              No monthly fee and no cut of your sales. If you take card
              payments, Stripe or Square charge their usual processing fee, just
              as they do today.
            </p>
          </div>
          <div className="flex flex-col gap-3 lg:items-end">
            <Link href="/signup" className={buttonVariants({ size: "lg" })}>
              Get started free
            </Link>
            <Link
              href="/pricing"
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              How pricing works
            </Link>
          </div>
        </div>
      </Section>

      <Section labelledBy="faq-heading" innerClassName="pt-0 sm:pt-0">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <SectionHeading
            id="faq-heading"
            eyebrow="Questions"
            title="What owners ask first."
          />
          <Faq items={FAQ} />
        </div>
      </Section>

      <ClosingCta />
    </>
  );
}
