import { Instrument_Serif } from "next/font/google";
import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";

// Headlines only (the mk-display utility). Loaded here rather than in the
// root layout so the diner menu and dashboard never download it.
const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

/** The public site an owner reads: header, page, footer. */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <div className={`${instrumentSerif.variable} flex flex-1 flex-col`}>
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-4 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex flex-1 flex-col">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
