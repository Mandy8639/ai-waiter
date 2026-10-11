import type { ReactNode } from "react";
import Link from "next/link";
import { PRIVACY_POLICY_PATH } from "@/lib/legal/privacy";
import { SUPPORT_CONTACT_EMAIL } from "@/lib/legal/support";

export const metadata = {
  title: "Support — Tableside",
  description:
    "Help with Tableside: signing in, kitchen alerts on your phone, your team, and how to reach us.",
};

/**
 * Help for restaurant staff, and the App Store listing's Support URL (Apple
 * requires one that leads to real contact details).
 *
 * The answers describe what the app does today; the sources are the same as
 * the store listings (docs/play-store/listing/, docs/app-store/listing.md).
 * Nothing here sells a plan: the page opens inside the store apps too.
 */
export default function SupportPage() {
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
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Support</h1>

      <div className="text-muted-foreground mt-8 flex flex-col gap-4 leading-relaxed">
        <p>
          Tableside lets diners order from their table by scanning a QR code,
          and gives your team a live kitchen board, table requests and order
          alerts. The Tableside app on Google Play and the App Store is for
          restaurant staff.
        </p>
        <p>
          Need a hand? Email {email}. Tell us your restaurant&apos;s name and
          what you were doing when the problem happened. We aim to reply within
          two business days.
        </p>
      </div>

      <Section title="Signing in">
        <p>
          The app uses the same account as tableside.menu. If you&apos;re new,
          your restaurant&apos;s owner or manager can invite you from the Staff
          page; open the invite link, set a password, then sign in with that
          email in the app. Forgotten your password or locked out? Email us from
          your account&apos;s address.
        </p>
      </Section>

      <Section title="Order alerts on your phone">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Open the kitchen board and tap <Term>Turn on alerts</Term>, then
            allow notifications when your phone asks.
          </li>
          <li>
            Not getting them? On iPhone, check{" "}
            <Term>Settings → Tableside → Notifications</Term>. On Android, check{" "}
            <Term>Settings → Apps → Tableside → Notifications</Term>. A Focus or
            Do Not Disturb mode can also hold them back.
          </li>
          <li>
            Alerts go to the devices of the people on your restaurant&apos;s
            team who turned them on. Use <Term>Send a test</Term> on the kitchen
            board to check a device.
          </li>
        </ul>
      </Section>

      <Section title="Your team">
        <p>
          Owners and managers invite people from the <Term>Staff</Term> page and
          choose each person&apos;s role: owner, manager, kitchen or staff.
          Removing someone from the team ends their access to your restaurant
          and stops their alerts.
        </p>
      </Section>

      <Section title="Your account and data">
        <p>
          Delete your account any time from <Term>Account</Term> in the app or
          on tableside.menu. Our{" "}
          <Link
            href={PRIVACY_POLICY_PATH}
            className="text-foreground font-medium underline underline-offset-4"
          >
            privacy policy
          </Link>{" "}
          explains what we keep and why.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Beacon Digital Consulting LLC, Jersey City, New Jersey, USA.
          <br />
          Email: {email}
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
