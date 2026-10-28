import type { ReactNode } from "react";
import Link from "next/link";
import { PRIVACY_POLICY_PATH } from "@/lib/legal/privacy";
import { SECURITY_PATH } from "@/lib/legal/security";
import { SUPPORT_CONTACT_EMAIL } from "@/lib/legal/support";
import { LEGAL_ENTITY, TERMS_PATH, TERMS_UPDATED } from "@/lib/legal/terms";
import { publicPageMetadata } from "@/lib/seo/metadata";

export const metadata = publicPageMetadata({
  title: "Terms of Service — Tableside",
  description:
    "The terms for restaurants using Tableside: accounts, the price (free), card payments through Stripe, the AI features, your data, and what each side is responsible for.",
  path: TERMS_PATH,
});

/**
 * The Terms of Service. Written to describe what Tableside actually does:
 *   - the price: free, no fee (20261125090000_basic_mode.sql: every
 *     restaurant billing-exempt, platform fee 0);
 *   - card payments: direct charges on the restaurant's own Stripe account
 *     (src/lib/payments/checkout.ts, tap-to-pay.ts), fee on food not tips;
 *   - allergens shown only once confirmed; AI drafts reviewed; AI images
 *     approved and labelled;
 *   - data export (Settings → Your data) and account deletion (/account).
 * A change to any of those means a change here and to TERMS_UPDATED.
 */
export default function TermsPage() {
  const email = (
    <a
      href={`mailto:${SUPPORT_CONTACT_EMAIL}`}
      className="text-foreground font-medium underline underline-offset-4"
    >
      {SUPPORT_CONTACT_EMAIL}
    </a>
  );
  const privacy = (
    <Link
      href={PRIVACY_POLICY_PATH}
      className="text-foreground underline underline-offset-4"
    >
      Privacy policy
    </Link>
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
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">
        Terms of Service
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Last updated {TERMS_UPDATED}
      </p>

      <div className="text-muted-foreground mt-8 flex flex-col gap-4 leading-relaxed">
        <p>
          Tableside is operated by <Term>{LEGAL_ENTITY}</Term>, a New Jersey
          limited liability company (&ldquo;Tableside&rdquo;, &ldquo;we&rdquo;,
          &ldquo;us&rdquo;). These terms are an agreement between us and the
          restaurant business that signs up (&ldquo;you&rdquo;), and they cover
          the website, the dashboard and the Tableside apps. By creating an
          account or using Tableside for your restaurant, you agree to them on
          behalf of that business, and you confirm you&apos;re allowed to.
        </p>
        <p>
          How we handle personal information is in our {privacy}, which is part
          of these terms. Questions about anything here: {email}.
        </p>
      </div>

      <Section title="1. Your account">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            You must be at least 18 and give us accurate information about
            yourself and your restaurant, and keep it up to date.
          </li>
          <li>
            Keep your password private. We recommend turning on two-step
            verification from your Account page. Tell us straight away if you
            think someone else has got into your account.
          </li>
          <li>
            You decide who joins your team and in which role (owner, manager,
            kitchen or staff), and you&apos;re responsible for what people you
            invite do in Tableside.
          </li>
        </ul>
      </Section>

      <Section title="2. Price">
        <p>
          <Term>Tableside is free to use.</Term> There&apos;s no subscription
          and no fee on your orders or payments.
        </p>
        <p>
          If we introduce paid plans, we&apos;ll tell you at least 30 days
          before anything changes, by email or in the dashboard. Nothing is ever
          charged unless you choose a plan.
        </p>
      </Section>

      <Section title="3. Card payments through Stripe">
        <p>
          Card payments for restaurants on Tableside are processed by{" "}
          <Term>Stripe</Term> and are subject to the{" "}
          <a
            href="https://stripe.com/legal/connect-account"
            className="text-foreground underline underline-offset-4"
          >
            Stripe Connected Account Agreement
          </a>
          , which includes the{" "}
          <a
            href="https://stripe.com/legal/ssa"
            className="text-foreground underline underline-offset-4"
          >
            Stripe Services Agreement
          </a>{" "}
          (together, the &ldquo;Stripe Services Agreement&rdquo;). By agreeing
          to these terms or continuing to take payments through Tableside, you
          agree to the Stripe Services Agreement, as Stripe may change it from
          time to time. So that we can offer payments through Stripe, you agree
          to give us accurate and complete information about you and your
          business, and you allow us to share it, and information about your
          payments, with Stripe.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Payments are made directly to your own Stripe account. Tableside
            never holds your money; our fee is deducted by Stripe.
          </li>
          <li>
            You&apos;re the seller to your diners. Refunds, chargebacks and
            disputes are between you, the diner and Stripe; you can issue
            refunds from the dashboard.
          </li>
          <li>
            Payments you record yourself (cash, or your own card machine) are
            records only: no money moves through Tableside, and we take no fee
            on them.
          </li>
        </ul>
      </Section>

      <Section title="4. What you're responsible for">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Term>Your menu.</Term> Dishes, prices, availability, descriptions,
            photos, taxes and service charges are yours to set and keep
            accurate.
          </li>
          <li>
            <Term>Allergens and dietary information.</Term> Tableside shows
            diners only the allergens you&apos;ve confirmed, and otherwise tells
            them to ask your staff. Confirming them correctly, and answering
            diners&apos; allergy questions, is your responsibility.
          </li>
          <li>
            <Term>Your food and your business.</Term> Food safety, licences
            (including for alcohol), taxes, and following the laws that apply to
            your restaurant are yours.
          </li>
          <li>
            <Term>What you upload.</Term> You confirm you have the right to use
            the photos, videos, text and other material you add, and that it
            doesn&apos;t break anyone else&apos;s rights or the law.
          </li>
        </ul>
      </Section>

      <Section title="5. The AI features">
        <p>
          Tableside uses AI models from third-party providers for the
          diners&apos; AI waiter, the staff Waiter assistant, menu import from
          photos, drafted descriptions, translations and nutrition estimates,
          and dish illustrations.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            The AI waiter answers from your menu, and checks in Tableside stop
            it naming dishes or allergens you haven&apos;t listed, but AI can
            still make mistakes. It tells diners to check allergies with your
            staff, and it is not a substitute for your staff on safety
            questions.
          </li>
          <li>
            Drafts the AI writes for you (descriptions, translations, nutrition
            estimates, imported menus) are marked as drafts. Check them before
            you publish them: once published, they&apos;re part of your menu.
          </li>
          <li>
            Dish illustrations are drawn by AI, shown to diners only after you
            approve them, and always labelled &ldquo;AI-generated&rdquo;.
          </li>
        </ul>
      </Section>

      <Section title="6. Diners">
        <p>
          Diners use Tableside to read your menu, order and pay, usually without
          an account. The sale of food and drink is between the diner and your
          restaurant; Tableside isn&apos;t a party to it. Diners should take
          questions about an order or a refund to the restaurant. A diner can
          cancel their own order only until your kitchen accepts it.
        </p>
      </Section>

      <Section title="7. Acceptable use">
        <p>Don&apos;t use Tableside to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>break the law, or help anyone else to;</li>
          <li>
            place fake orders, harass anyone, or send spam or misleading
            content;
          </li>
          <li>
            access accounts or data that aren&apos;t yours, or interfere with
            the service or its security (to report a security issue, see our{" "}
            <Link
              href={SECURITY_PATH}
              className="text-foreground underline underline-offset-4"
            >
              security page
            </Link>
            );
          </li>
          <li>
            copy, resell or scrape the service, or reverse-engineer it except
            where the law allows.
          </li>
        </ul>
      </Section>

      <Section title="8. Your data">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Term>Your restaurant&apos;s data is yours</Term>: your menu,
            orders, payments, reservations, guests&apos; feedback and the rest.
            You can download all of it at any time from Settings → Your data.
          </li>
          <li>
            You allow us to store, process and display it as needed to run
            Tableside for you, including showing your menu publicly to diners,
            and to use it in aggregate, without identifying you or your guests,
            to keep the service working well and improve it.
          </li>
          <li>
            We don&apos;t sell your data, and we don&apos;t use it for
            advertising.
          </li>
        </ul>
      </Section>

      <Section title="9. Our service">
        <p>
          We work to keep Tableside running and improving, and may add, change
          or remove features. We aim to keep it available at all times but
          can&apos;t promise it will be uninterrupted or error-free, including
          when a provider we rely on (such as Stripe, our hosting or our AI
          providers) has a problem. The Tableside apps are also subject to the
          terms of the App Store or Google Play you download them from.
        </p>
      </Section>

      <Section title="10. Ending or suspending">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            You can stop using Tableside at any time. Download your data first
            if you want to keep it; you can delete your account from the Account
            page.
          </li>
          <li>
            We may suspend or end your access if you break these terms, use
            Tableside unlawfully, put diners or other users at risk, or
            don&apos;t pay. Where it&apos;s reasonable, we&apos;ll tell you
            first and give you a chance to put things right.
          </li>
        </ul>
      </Section>

      <Section title="11. Disclaimers">
        <p>
          To the fullest extent the law allows, Tableside is provided &ldquo;as
          is&rdquo; and &ldquo;as available&rdquo;, without warranties of any
          kind, whether express or implied, including of merchantability,
          fitness for a particular purpose and non-infringement.
        </p>
      </Section>

      <Section title="12. Limits on liability">
        <p>
          To the fullest extent the law allows: we aren&apos;t liable for
          indirect, incidental, special or consequential losses, or for lost
          profits, revenue or data; and our total liability for any claim about
          Tableside is limited to the greater of the amount you paid us in the
          12 months before the claim, or US$100. Nothing in these terms limits
          liability that can&apos;t be limited by law.
        </p>
      </Section>

      <Section title="13. Indemnity">
        <p>
          You&apos;ll defend and compensate us against claims by others arising
          from your food and service, the information on your menu (including
          allergens), material you upload, your dealings with your diners, or
          your breach of these terms.
        </p>
      </Section>

      <Section title="14. Changes to these terms">
        <p>
          We may update these terms. We&apos;ll post the new version here and
          change the date above, and for changes that matter we&apos;ll tell you
          by email or in the dashboard at least 30 days before they take effect.
          Continuing to use Tableside after that means you accept the new terms.
        </p>
      </Section>

      <Section title="15. Law and disputes">
        <p>
          These terms are governed by the laws of the State of New Jersey,
          without regard to its conflict-of-law rules. Any dispute will be
          decided by the state or federal courts located in New Jersey, and both
          sides agree to their jurisdiction. Either side may still bring a claim
          in small-claims court where it qualifies.
        </p>
      </Section>

      <Section title="16. Contact">
        <p>
          {LEGAL_ENTITY}, New Jersey, United States. Email {email}.
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
