import type { ReactNode } from "react";
import Link from "next/link";
import { PRIVACY_POLICY_PATH } from "@/lib/legal/privacy";
import { SUPPORT_CONTACT_EMAIL } from "@/lib/legal/support";
import { HAS_SCHEDULED_BACKUPS, SECURITY_PATH } from "@/lib/legal/security";
import { publicPageMetadata } from "@/lib/seo/metadata";

export const metadata = publicPageMetadata({
  title: "Security — Tableside",
  description:
    "How Tableside keeps a restaurant's data safe: where it's stored, who can see it, sign-in, card payments, the AI waiter, and getting your data out.",
  path: SECURITY_PATH,
});

/**
 * For the owner who asks the technical questions. Written to be sent as a
 * link. Every claim is something the system does today (see
 * src/lib/legal/security.ts); nothing here is a promise we haven't built.
 */
export default function SecurityPage() {
  const email = (
    <a
      href={`mailto:${SUPPORT_CONTACT_EMAIL}`}
      className="text-foreground font-medium underline underline-offset-4"
    >
      {SUPPORT_CONTACT_EMAIL}
    </a>
  );

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12 sm:py-16">
      <p className="text-sm">
        <Link
          href="/"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          Tableside
        </Link>
      </p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Security</h1>

      <div className="text-muted-foreground mt-8 flex flex-col gap-4 leading-relaxed">
        <p>
          Your menu, orders, payments and guests are the heart of your business.
          This page explains, in plain terms, how Tableside looks after them.
          Questions we haven&apos;t answered? Email {email}.
        </p>
      </div>

      <Section title="Where your data lives">
        <p>
          Your restaurant&apos;s data is stored in a managed Postgres database
          run by <Term>Supabase</Term>, in the United States (Oregon). The app
          itself runs on <Term>Vercel</Term>, also in Oregon. Both providers are
          independently audited for security (SOC 2 Type 2).
        </p>
        <p>
          Everything travels over encrypted connections (HTTPS), and the
          database is encrypted at rest.
        </p>
        {HAS_SCHEDULED_BACKUPS && (
          <p>
            The database is backed up automatically every day, and backups are
            kept for seven days.
          </p>
        )}
      </Section>

      <Section title="Who can see what">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Term>Each restaurant sees only its own data.</Term> This is
            enforced inside the database itself (row-level security), not just
            by the app, so a bug in a page can&apos;t show one restaurant
            another&apos;s orders.
          </li>
          <li>
            <Term>Staff see what their role needs.</Term> There are four roles:
            owner, manager, kitchen and staff. A kitchen account sees the
            kitchen board, not your takings, and only owners and managers see
            reports, payment history and guest insights.
          </li>
          <li>
            <Term>Diners see only their own order.</Term> Scanning a
            table&apos;s QR code starts a private visit for that phone. Diners
            don&apos;t need an account, and can&apos;t see anyone else&apos;s
            order, even at the same table.
          </li>
          <li>
            <Term>Tableside&apos;s own team</Term> reaches restaurant data only
            to run and support the service, and our admin tools require two-step
            verification.
          </li>
        </ul>
      </Section>

      <Section title="Signing in">
        <p>
          Staff sign in with an email and password of at least eight characters.
          Passwords are never stored in readable form. Anyone can turn on{" "}
          <Term>two-step verification</Term> with an authenticator app from
          their Account page. Anyone can also delete their own account there.
        </p>
      </Section>

      <Section title="Card payments">
        <p>
          Card payments go through <Term>Stripe</Term>, which is certified to
          the highest level of the card industry&apos;s security standard (PCI
          DSS Level 1). Card numbers go straight to Stripe and never reach
          Tableside. Each restaurant connects its own Stripe account, so the
          money goes to you, not through us.
        </p>
      </Section>

      <Section title="The AI waiter">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Term>It answers from your menu, not from imagination.</Term> It
            looks up every dish, price and ingredient as it answers, and checks
            in the app stop it from naming dishes you don&apos;t serve.
          </li>
          <li>
            <Term>
              Allergens are shown only once you&apos;ve confirmed them.
            </Term>{" "}
            If you haven&apos;t, it tells the diner to ask your staff.
          </li>
          <li>
            <Term>It can&apos;t be talked into things.</Term> What a diner types
            is treated as a message, never as an instruction. It can&apos;t
            change prices, and it only places or cancels an order after the
            diner says yes in a separate message.
          </li>
          <li>
            <Term>What it sends to AI providers.</Term> To answer, the
            diner&apos;s message and the relevant menu details go to an AI model
            through our provider, OpenRouter. We don&apos;t send diners&apos;
            names, emails, phone numbers or payment details.
          </li>
        </ul>
      </Section>

      <Section title="Reliability">
        <p>
          The kitchen board updates live, and checks in regularly in case a live
          update is missed, so a dropped connection catches up on its own. Order
          changes are made one at a time inside the database: if two people tap
          the same order at once, exactly one change wins. Errors are reported
          to our monitoring (Sentry) with personal details removed, so we often
          know about a problem before you do.
        </p>
      </Section>

      <Section title="Your data is yours">
        <p>
          Owners can download everything Tableside holds for their restaurant at
          any time, in one file: Settings → <Term>Your data</Term>. Reports can
          also be exported as spreadsheets. How we handle personal information
          is in our{" "}
          <Link
            href={PRIVACY_POLICY_PATH}
            className="text-foreground underline underline-offset-4"
          >
            privacy policy
          </Link>
          .
        </p>
      </Section>

      <Section title="Found a problem?">
        <p>
          If you think you&apos;ve found a security issue, email {email}. Tell
          us what you saw and how to reproduce it. We&apos;ll reply, keep you
          updated, and won&apos;t take action against anyone reporting in good
          faith.
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-foreground text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="text-muted-foreground mt-4 flex flex-col gap-4 leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function Term({ children }: { children: ReactNode }) {
  return <strong className="text-foreground font-medium">{children}</strong>;
}
