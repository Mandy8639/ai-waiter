import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { publicPageMetadata } from "@/lib/seo/metadata";
import { STAFF_APP } from "@/lib/marketing/content";
import { storeForUserAgent } from "@/lib/staff-app/core";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { StoreLinks } from "@/components/marketing/store-links";

export const metadata = publicPageMetadata({
  title: "Get the app — Tableside",
  description:
    "Tableside for Restaurants, the staff app: new-order alerts and the kitchen board on your phone. For iPhone and Android.",
  path: "/get-app",
});

/**
 * One link for the staff app, whatever the phone: an iPhone goes straight
 * to the App Store, an Android phone to Google Play, and a computer gets
 * this page with both. The dashboard's QR code and the Settings card point
 * here, and it's safe to put in emails and printed notes.
 */
export default async function GetAppPage() {
  const store = storeForUserAgent((await headers()).get("user-agent"));
  if (store === "ios") redirect(STAFF_APP.appStore);
  if (store === "android") redirect(STAFF_APP.googlePlay);

  return (
    <>
      <PageHero
        eyebrow="Staff app"
        title={
          <>
            Tableside, <em className="text-primary">on your phone.</em>
          </>
        }
        lead="New-order alerts and the kitchen board for your kitchen and floor, even when the phone is locked. Guests never need an app."
      />
      <Section labelledBy="get-app-heading" innerClassName="pt-10 sm:pt-12">
        <div className="flex flex-col items-start gap-5">
          <h2 id="get-app-heading" className="sr-only">
            Download
          </h2>
          <StoreLinks />
          <p className="text-muted-foreground text-sm">
            Sign in with your Tableside account. New here?{" "}
            <Link
              href="/signup"
              className="text-primary font-medium underline-offset-4 hover:underline"
            >
              Create your free account
            </Link>{" "}
            first.
          </p>
        </div>
      </Section>
    </>
  );
}
