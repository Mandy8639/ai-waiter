import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Tableside iOS app (ios/): the staff dashboard at tableside.menu in a
 * native shell, plus what a website can't do on iPhone:
 *   - kitchen alerts through Apple's push service (src/lib/push/apns.ts,
 *     src/components/kitchen/native-push.ts), with notification taps
 *     opening the order;
 *   - a proper offline screen (ios-shell/offline.html) instead of a web
 *     view error;
 *   - its own icon, launch screen and app-mode behaviour: no plan
 *     purchases inside the app (src/lib/app-shell/core.ts).
 *
 * The start URL announces app mode (?app=ios) and every request carries
 * the user agent mark, so the site knows it's inside the app.
 *
 * Android uses a Trusted Web Activity instead (android/); see
 * android/README.md.
 */
// For trying a local build against the dev server (`npm run dev`), e.g.
// CAP_SERVER_URL=http://127.0.0.1:3099/dashboard/kitchen?app=ios npx cap sync ios
// (127.0.0.1, not localhost: Capacitor uses "localhost" for its own bundled
// pages and would open a localhost URL in Safari.)
// The iOS Simulator reaches the Mac directly. Unset, the app
// loads the live site.
const serverUrl =
  process.env.CAP_SERVER_URL ??
  "https://tableside.menu/dashboard/kitchen?app=ios";

const config: CapacitorConfig = {
  appId: "menu.tableside.app",
  appName: "Tableside",
  // Bundled pages: the offline screen, and a placeholder index the live
  // site replaces on launch.
  webDir: "ios-shell",
  server: {
    url: serverUrl,
    // Only a local dev URL is plain http.
    cleartext: serverUrl.startsWith("http://"),
    // Pages on these hosts stay in the app; anything else (Stripe, other
    // sites) opens in Safari. The server URL's own host is listed because
    // Capacitor otherwise only keeps URLs that start with the full
    // server.url, path and all, and a redirect such as sign-in leaves it.
    allowNavigation: [...new Set(["tableside.menu", new URL(serverUrl).hostname])],
    errorPath: "offline.html",
  },
  ios: {
    appendUserAgent: "TablesideApp/ios",
    backgroundColor: "#faf8f5",
    contentInset: "automatic",
  },
  plugins: {
    PushNotifications: {
      // Show alerts even while the app is open on another screen; the
      // kitchen board itself also chimes.
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
