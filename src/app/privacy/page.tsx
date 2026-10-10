import type { ReactNode } from "react";
import Link from "next/link";
import {
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_POLICY_UPDATED,
} from "@/lib/legal/privacy";

export const metadata = {
  title: "Privacy policy — Tableside",
  description:
    "What Tableside collects from restaurant staff and diners, why, who it's shared with, and how to have it deleted.",
};

/**
 * The privacy policy, linked from the landing page, the sign-in and sign-up
 * pages, and the Google Play listing (which requires one).
 *
 * Every statement here describes what the code actually does, so a change
 * to what Tableside collects or where it sends it means a change here too
 * (and to PRIVACY_POLICY_UPDATED). The sources:
 *   - what's stored: supabase/migrations, docs/database.md
 *   - dish statistics and the 2-day marks: docs/security.md (dish funnel)
 *   - the AI waiter's providers: src/lib/ai/providers, docs/ai.md
 *   - voice input never sending audio: src/lib/voice/dictation.ts
 *   - error reports without personal details: src/lib/observability
 *
 * Diner visits and AI conversations have no automatic deletion yet
 * (docs/database.md, "Known limitations"), and the policy says so rather
 * than promising a retention period the code doesn't enforce.
 */
export default function PrivacyPolicyPage() {
  const email = (
    <a
      href={`mailto:${PRIVACY_CONTACT_EMAIL}`}
      className="text-foreground font-medium underline underline-offset-4"
    >
      {PRIVACY_CONTACT_EMAIL}
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
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">
        Privacy policy
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Last updated {PRIVACY_POLICY_UPDATED}
      </p>

      <div className="text-muted-foreground mt-8 flex flex-col gap-4 leading-relaxed">
        <p>
          Tableside is a restaurant ordering service at tableside.menu, operated
          by Beacon Digital Consulting LLC, a New Jersey limited liability
          company (&ldquo;we&rdquo;). This policy explains what information
          Tableside collects, why, who it&apos;s shared with, and the choices
          you have. It covers the website, the menus diners open by scanning the
          QR code on their table, and the Tableside app for restaurant staff on
          Google Play.
        </p>
      </div>

      <Section title="Who this covers">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">
              Restaurant owners and staff
            </strong>
            , who have Tableside accounts.
          </li>
          <li>
            <strong className="text-foreground">Diners</strong>, who use a
            restaurant&apos;s menu by scanning the code on their table. Diners
            don&apos;t create an account.
          </li>
        </ul>
        <p>
          When you order at a restaurant, that restaurant sees your order and
          the details you send it, and uses them to serve you. We handle
          diners&apos; information to provide the service to the restaurant.
        </p>
      </Section>

      <Section title="What we collect">
        <h3 className="text-foreground font-medium">
          From restaurant owners and staff
        </h3>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Term>Your account:</Term> your email address and password. The
            password is stored only as a secure hash, and we can&apos;t see it.
          </li>
          <li>
            <Term>Your restaurant:</Term> what you enter, such as its name,
            address, phone number, opening hours, menus, dish photos and videos,
            prices, ingredients, allergen and nutrition information, tables and
            settings.
          </li>
          <li>
            <Term>Your team:</Term> the email addresses you invite and each
            person&apos;s role.
          </li>
          <li>
            <Term>Order alerts:</Term> if you turn on notifications on a device,
            that device&apos;s push subscription (an address issued by your
            browser&apos;s push service) and a description of the browser and
            device, so we can alert you to new orders and table requests.
          </li>
          <li>
            <Term>Payments and billing:</Term> if your restaurant accepts cards
            or subscribes to a paid plan, Stripe collects the business and bank
            details it needs to pay you and bill you. We keep Stripe&apos;s
            account and payment references and the status and amounts of
            payments, refunds and subscriptions, never card or bank numbers.
          </li>
          <li>
            <Term>Email:</Term> the address that receives your daily summary and
            other emails about your restaurant.
          </li>
        </ul>

        <h3 className="text-foreground mt-2 font-medium">From diners</h3>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Term>Your visit:</Term> scanning a table&apos;s code starts an
            anonymous session for that table. We don&apos;t ask for your name,
            email or phone number to browse the menu or order.
          </li>
          <li>
            <Term>Orders:</Term> what you add to your order, any notes, how you
            pay (card, cash, tip, splitting the bill) and the order&apos;s
            status.
          </li>
          <li>
            <Term>Table requests</Term>, such as asking for a server or the
            bill.
          </li>
          <li>
            <Term>Feedback</Term> you choose to leave about your visit or a
            dish. Only the restaurant sees it.
          </li>
          <li>
            <Term>Reservation requests:</Term> if you ask for a table, the name
            and phone number you give, plus any email address and notes. These
            go to the restaurant.
          </li>
          <li>
            <Term>Card payments:</Term> your card details go straight to Stripe,
            the payment processor, and never reach Tableside. We receive the
            payment&apos;s status and amount.
          </li>
          <li>
            <Term>AI waiter conversations:</Term> what you ask the AI waiter and
            its replies, kept with your visit so the conversation survives a
            page reload. See &ldquo;The AI waiter&rdquo; below.
          </li>
          <li>
            <Term>Voice input:</Term> if you use the microphone button, your
            browser&apos;s own speech service turns speech into text
            (Google&apos;s in Chrome, Apple&apos;s in Safari) under its own
            privacy terms. Tableside never receives audio, only the text, and
            only when you send it.
          </li>
          <li>
            <Term>Dish statistics:</Term> opening, adding or ordering a dish is
            counted in daily totals per dish, which contain no session, account,
            table or time of day. A short-lived note that your visit was already
            counted, so that opening a dish twice counts once, is deleted after
            2 days.
          </li>
        </ul>

        <h3 className="text-foreground mt-2 font-medium">From everyone</h3>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Term>Error reports:</Term> when something breaks, technical details
            are recorded (through Sentry) so we can fix it. They are set up to
            leave out IP addresses and personal details, and table links are
            removed before a report leaves your browser.
          </li>
          <li>
            <Term>Server logs:</Term> our hosting provider records requests to
            the service, which can include your IP address, for security and
            troubleshooting. Our AI waiter logs record timing and counts, not
            what anyone wrote.
          </li>
          <li>
            <Term>Cookies:</Term> only the ones needed to keep you signed in and
            to keep your visit to a table working. No advertising or analytics
            cookies, and no tracking across other sites.
          </li>
        </ul>
      </Section>

      <Section title="How we use it">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            To run Tableside: show menus, take orders and send them to the
            kitchen, process payments, show order status, and send alerts and
            emails.
          </li>
          <li>To answer diners&apos; questions with the AI waiter.</li>
          <li>
            To give restaurants reports, such as sales and how often each dish
            is ordered.
          </li>
          <li>
            To keep the service secure and reliable, prevent abuse (for example,
            limits on how many messages the AI waiter takes) and fix problems.
          </li>
          <li>To contact restaurant owners about their account.</li>
        </ul>
        <p>
          We don&apos;t sell personal information, use it for advertising, or
          share it with data brokers.
        </p>
      </Section>

      <Section title="The AI waiter">
        <p>
          When a diner asks the AI waiter something, we send the message, the
          recent conversation and the relevant parts of the restaurant&apos;s
          menu to an AI model provider, which writes the answer. That provider
          is Anthropic, or OpenRouter, which passes the request to the company
          running the model. Providers handle messages under their own terms,
          and some, especially those offering free models, may keep them or use
          them to improve their models. Please don&apos;t share sensitive
          personal information with the AI waiter.
        </p>
        <p>
          Answers are based on the restaurant&apos;s menu, but AI can make
          mistakes. If you have an allergy or a dietary requirement, always
          confirm with the restaurant&apos;s staff.
        </p>
      </Section>

      <Section title="Who we share it with">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Term>The restaurant</Term> you order from or work for.
          </li>
          <li>
            <Term>Service providers</Term> that run parts of Tableside for us:
            Supabase (database and sign-in), Vercel (hosting), Stripe
            (payments), Anthropic and OpenRouter (the AI waiter), Sentry (error
            reports), Resend (email), and your browser&apos;s push service, such
            as Google, Apple or Mozilla (notifications).
          </li>
          <li>
            <Term>When the law requires it</Term>, or to protect the rights,
            safety or property of diners, restaurants, Tableside or others.
          </li>
          <li>
            <Term>If Tableside is sold or reorganized</Term>, to the new owner,
            who must keep honoring this policy.
          </li>
        </ul>
      </Section>

      <Section title="How long we keep it">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Accounts and restaurant information: for as long as the account is
            open.
          </li>
          <li>
            Orders and payment records: these are the restaurant&apos;s business
            records. We keep them while the restaurant uses Tableside, and as
            long as needed for accounting, tax and payment disputes.
          </li>
          <li>
            Diner visits and AI waiter conversations: kept with the
            restaurant&apos;s records. We don&apos;t delete them automatically
            yet, and you can ask us to delete yours at any time.
          </li>
          <li>The note that a visit was already counted for a dish: 2 days.</li>
        </ul>
      </Section>

      <Section title="Your choices">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <Term>See, correct, delete or get a copy of your information:</Term>{" "}
            email {email}. Restaurant owners and staff, please write from the
            address on your account. Diners, tell us the restaurant, the table
            and roughly when you visited. We&apos;ll reply within 30 days, and
            we honor these requests wherever you live.
          </li>
          <li>
            <Term>Delete your account:</Term> email {email} from your
            account&apos;s address. We&apos;ll delete the account and its
            personal information, except records we must keep, such as payment
            records. Owners can also remove a staff member from their team on
            the Staff page.
          </li>
          <li>
            <Term>Order alerts:</Term> turn them off with the &ldquo;Turn
            off&rdquo; button on the kitchen board, or in your browser or phone
            settings.
          </li>
        </ul>
      </Section>

      <Section title="Security">
        <p>
          Information travels over encrypted connections (HTTPS). Each
          restaurant&apos;s data is kept separate at the database level, so one
          restaurant can&apos;t see another&apos;s, and staff see only what
          their role allows. Card details are held only by Stripe. No system is
          perfectly secure, so we can&apos;t guarantee absolute security, but we
          work to protect your information.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Tableside isn&apos;t directed at children under 13, and we don&apos;t
          knowingly collect their personal information. If you think a child has
          given us personal information, contact us and we&apos;ll delete it.
        </p>
      </Section>

      <Section title="Where it's processed">
        <p>
          We&apos;re based in the United States. Our service providers may
          process information in the United States and other countries.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          When we change this policy, we&apos;ll update the date at the top. If
          a change is significant, we&apos;ll also tell restaurant owners by
          email or in Tableside.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Beacon Digital Consulting LLC, Jersey City, New Jersey, USA.
          <br />
          Privacy questions and requests: {email}
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
