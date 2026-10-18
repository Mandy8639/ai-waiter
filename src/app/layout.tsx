import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SITE_URL } from "@/lib/seo/metadata";
import { WebAnalytics } from "@/components/analytics/web-analytics";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Only a few screens use the monospace face (setup keys, invite links, code
// in AI replies), so it isn't preloaded on every page; it still loads, with
// a size-matched fallback, wherever it is used.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

export const metadata: Metadata = {
  // Canonical, Open Graph and image URLs resolve against the production
  // domain on every host the app answers on (src/lib/seo/metadata.ts).
  metadataBase: new URL(SITE_URL),
  title: "Tableside",
  description: "An AI waiter for restaurants.",
  // Added to an iPhone or iPad home screen, it opens full screen and is
  // labelled "Tableside". The icon itself is app/apple-icon.png.
  appleWebApp: {
    title: "Tableside",
    statusBarStyle: "default",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {children}
        <WebAnalytics />
      </body>
    </html>
  );
}
