import type { LucideIcon } from "lucide-react";
import {
  Bell,
  CalendarDays,
  ChartColumn,
  ChefHat,
  CreditCard,
  FileUp,
  Gauge,
  ImageIcon,
  Languages,
  MessageSquareHeart,
  Mic,
  Printer,
  QrCode,
  Receipt,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Split,
} from "lucide-react";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { PageHero } from "@/components/marketing/page-hero";
import { Section, SectionHeading } from "@/components/marketing/section";
import { Reveal } from "@/components/marketing/reveal";
import { ClosingCta } from "@/components/marketing/closing-cta";
import { cn } from "@/lib/utils";
import { StoreLinks } from "@/components/marketing/store-links";

export const metadata = publicPageMetadata({
  title: "Features — Tableside",
  description:
    "QR ordering with an AI waiter, a live kitchen board and ticket printing, payments and split bills, staff apps and reports. Everything Tableside does today.",
  path: "/features",
});

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
  /** Show the App Store / Google Play links under it. */
  storeLinks?: true;
}

/**
 * Every feature listed here is live in the product. Grouped by who it's
 * for, because an owner reads this page asking "what does it do for my
 * guests, my kitchen, my money".
 */
const GROUPS: {
  id: string;
  label: string;
  eyebrow: string;
  title: string;
  lead: string;
  features: Feature[];
}[] = [
  {
    id: "guests",
    label: "Guests",
    eyebrow: "For your guests",
    title: "Ordering that feels like being looked after.",
    lead: "Guests scan, browse and order from their own phone, with a waiter they can ask anything.",
    features: [
      {
        icon: QrCode,
        title: "Scan and order",
        body: "A code on each table opens your menu in the browser. No app, no account.",
      },
      {
        icon: Sparkles,
        title: "Ask the waiter",
        body: "Plain-language questions about any dish, answered from your menu. Guests add dishes straight from the answer.",
      },
      {
        icon: Mic,
        title: "Speak instead of typing",
        body: "Guests can say what they want, which helps when typing on a phone is a chore.",
      },
      {
        icon: ShieldCheck,
        title: "Allergy care",
        body: "Allergens shown as you list them. A dish that conflicts with a stated allergy is held until the guest confirms.",
      },
      {
        icon: Languages,
        title: "Menu translations",
        body: "Offer the menu in other languages once you've approved the translations.",
      },
      {
        icon: ImageIcon,
        title: "Dish photos",
        body: "Upload your own, or generate photos for dishes without one and approve each before guests see it.",
      },
    ],
  },
  {
    id: "kitchen",
    label: "Kitchen and floor",
    eyebrow: "For your kitchen and floor",
    title: "Every order, complete, the moment it's placed.",
    lead: "Tickets carry the guest's notes and choices, so nothing is lost between the table and the pass.",
    features: [
      {
        icon: ChefHat,
        title: "Live kitchen board",
        body: "Orders appear instantly and move through preparing, ready and served. Guests see the status change too.",
      },
      {
        icon: Printer,
        title: "Ticket printing",
        body: "Send tickets to a cloud-connected kitchen printer for a line that works on paper.",
      },
      {
        icon: Gauge,
        title: "Busy mode",
        body: "When the kitchen is slammed, add time to every estimate or pause new orders. Guests are told why.",
      },
      {
        icon: Bell,
        title: "Table requests",
        body: "Guests can ask for the bill or call someone over, and staff get an alert.",
      },
      {
        icon: Smartphone,
        title: "Staff app",
        body: "Tableside for Restaurants on iPhone and Android, with push alerts for new orders and requests.",
        storeLinks: true,
      },
      {
        icon: MessageSquareHeart,
        title: "Private feedback",
        body: "Guests rate their meal once it's served. You hear about a problem while they're still at the table.",
      },
    ],
  },
  {
    id: "payments",
    label: "Payments",
    eyebrow: "When you're ready",
    title: "Get paid at the table, or keep your counter.",
    lead: "Guests pay at your counter as they do now. When you want more, we switch on payments, bookings and takings reports for your restaurant.",
    features: [
      {
        icon: CreditCard,
        title: "Pay from the phone",
        body: "Guests pay by card when they're ready, with a tip if they choose.",
      },
      {
        icon: Split,
        title: "Split the bill",
        body: "Friends split a table's bill between them without anyone doing the maths.",
      },
      {
        icon: Receipt,
        title: "Receipts and refunds",
        body: "Email a receipt, refund all or part of a payment, and record cash.",
      },
      {
        icon: ChartColumn,
        title: "Reports and day close",
        body: "Sales, best sellers and payment methods, with an end-of-day close you can export.",
      },
      {
        icon: CalendarDays,
        title: "Reservations",
        body: "Take table bookings from the same page guests already use.",
      },
    ],
  },
  {
    id: "setup",
    label: "Setup",
    eyebrow: "For getting started",
    title: "Your menu, live in an afternoon.",
    lead: "Bring the menu you already have. Check it, print your table codes, and you're open.",
    features: [
      {
        icon: FileUp,
        title: "Import your menu",
        body: "From a photo or PDF of the menu, a link to it, or straight from Square.",
      },
      {
        icon: ShoppingBag,
        title: "Choices and sold out",
        body: "Sizes, add-ons and spice levels. Mark a dish sold out for the night and it comes back tomorrow.",
      },
      {
        icon: ShieldCheck,
        title: "Staff roles and two-step sign-in",
        body: "Give each person the pages their job needs, and protect accounts with a second step.",
      },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        eyebrow="Features"
        title={
          <>
            Everything Tableside does, <em className="text-primary">today.</em>
          </>
        }
        lead="No roadmap promises on this page. Every feature below is live and free to use."
      >
        <nav aria-label="On this page" className="flex flex-wrap gap-2 pt-2">
          {GROUPS.map((g) => (
            <a
              key={g.id}
              href={`#${g.id}`}
              className="bg-card hover:bg-secondary rounded-full border px-4 py-1.5 text-sm transition-colors"
            >
              {g.label}
            </a>
          ))}
        </nav>
      </PageHero>

      {GROUPS.map((group, gi) => (
        <Section
          key={group.id}
          id={group.id}
          labelledBy={`${group.id}-heading`}
          className={cn(
            "scroll-mt-16",
            gi % 2 === 1 && "bg-secondary/60 border-y",
          )}
        >
          <div className="grid gap-12 lg:grid-cols-[1fr_1.7fr]">
            <SectionHeading
              id={`${group.id}-heading`}
              eyebrow={group.eyebrow}
              title={group.title}
              lead={group.lead}
              className="lg:sticky lg:top-28 lg:self-start"
            />
            <ul className="grid gap-x-8 gap-y-10 sm:grid-cols-2">
              {group.features.map((f, i) => (
                <li key={f.title}>
                  <Reveal delay={(i % 2) * 80} className="flex flex-col gap-3">
                    <span className="bg-card text-primary flex size-10 items-center justify-center rounded-xl border">
                      <f.icon className="size-5" aria-hidden />
                    </span>
                    <h3 className="text-lg font-semibold tracking-tight">
                      {f.title}
                    </h3>
                    <p className="text-muted-foreground text-sm text-pretty">
                      {f.body}
                    </p>
                    {f.storeLinks && <StoreLinks />}
                  </Reveal>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ))}

      <ClosingCta />
    </>
  );
}
