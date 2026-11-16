import Link from "next/link";
import { Instrument_Serif } from "next/font/google";
import { Download, Mail, MessageCircle, Phone, PlayCircle } from "lucide-react";
import { publicPageMetadata, PRIVATE_PAGE_ROBOTS } from "@/lib/seo/metadata";
import {
  BUSINESS_CARD as card,
  formatUsPhone,
  whatsappUrl,
} from "@/lib/marketing/business-card";

const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata = {
  ...publicPageMetadata({
    title: `${card.name}, ${card.title} — Tableside`,
    description:
      "Tableside: the menu that answers. Save my contact or try the demo.",
    path: "/card",
  }),
  // Opened from the printed card's QR code; nothing for search engines.
  robots: PRIVATE_PAGE_ROBOTS,
};

/**
 * The digital business card. The printed card's QR code opens this page,
 * so it's built for a phone held in one hand at a restaurant's front
 * counter: who I am, one tap to call, WhatsApp or save the contact, and
 * the demo to try right there. Details live in src/lib/marketing/business-card.ts.
 */
export default function CardPage() {
  const actions = [
    card.phone && {
      href: `tel:${card.phone}`,
      label: "Call",
      detail: formatUsPhone(card.phone),
      icon: Phone,
    },
    card.phone && {
      href: whatsappUrl(card.phone),
      label: "WhatsApp",
      detail: "Message me",
      icon: MessageCircle,
    },
    card.email && {
      href: `mailto:${card.email}`,
      label: "Email",
      detail: card.email,
      icon: Mail,
    },
  ].filter(Boolean) as {
    href: string;
    label: string;
    detail: string;
    icon: typeof Phone;
  }[];

  return (
    <main
      className={`${instrumentSerif.variable} bg-background flex min-h-dvh flex-col items-center px-4 py-10`}
    >
      <div className="w-full max-w-sm">
        <div className="bg-primary text-primary-foreground rounded-2xl px-6 pt-8 pb-7 shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element -- a static brand SVG */}
          <img
            src="/brand/tableside-mark-white.svg"
            alt=""
            width={44}
            height={38}
            className="mb-6 h-[38px] w-auto"
          />
          <h1 className="mk-display text-4xl leading-tight">{card.name}</h1>
          <p className="mt-1 text-base opacity-90">
            {card.title}, {card.company}
          </p>
          <p className="mk-display mt-6 text-xl italic opacity-95">
            The menu that answers.
          </p>
        </div>

        <div className="mt-5 flex flex-col gap-3">
          {actions.map(({ href, label, detail, icon: Icon }) => (
            <a
              key={label}
              href={href}
              className="bg-card border-border hover:bg-accent flex items-center gap-4 rounded-xl border px-4 py-3.5 transition-colors"
            >
              <Icon className="text-primary size-5 shrink-0" aria-hidden />
              <span className="flex flex-col">
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground text-sm">{detail}</span>
              </span>
            </a>
          ))}
          <a
            href="/card/vcard"
            className="bg-primary text-primary-foreground flex items-center justify-center gap-2 rounded-xl px-4 py-3.5 font-medium"
          >
            <Download className="size-5" aria-hidden />
            Save contact
          </a>
          <Link
            href="/demo"
            className="border-primary text-primary flex items-center justify-center gap-2 rounded-xl border px-4 py-3.5 font-medium"
          >
            <PlayCircle className="size-5" aria-hidden />
            Try the AI waiter: ask &ldquo;is this Jain?&rdquo;
          </Link>
        </div>

        <p className="text-muted-foreground mt-6 text-sm leading-relaxed">
          Guests ask about spice, Jain, vegetarian and allergens in English,
          Hindi or Hinglish, and order from their phone. Your servers keep the
          Friday rush.
        </p>
        <p className="mt-6 text-center text-sm">
          <Link
            href="/"
            className="text-primary underline-offset-4 hover:underline"
          >
            tableside.menu
          </Link>
        </p>
      </div>
    </main>
  );
}
