# Tableside for iOS (staff app)

The staff dashboard at tableside.menu in a native iOS shell, built with
[Capacitor](https://capacitorjs.com) (`capacitor.config.ts` at the repo root). It adds what a
website can't do on iPhone and iPad:

- **Kitchen alerts through Apple's push service.** The kitchen board's "Turn on alerts" asks iOS for
  permission, registers with APNs, and saves the device token (`native_push_tokens`,
  `src/components/kitchen/native-push.ts`). The server sends order and table-request alerts there
  (`src/lib/push/apns.ts`) alongside web push. Tapping an alert opens the order
  (`src/components/kitchen/native-app-bridge.tsx`).
- **An offline screen** (`ios-shell/offline.html`) instead of a web view error.
- **App mode:** no plan purchases inside the app (`src/lib/app-shell/core.ts`), for App Store
  Guideline 3.1.1.

Android is a Trusted Web Activity instead: see `android/README.md`.

## Build

Needs Xcode 26 or later (App Store Connect requires it since April 2026).

```bash
npm install
npx cap sync ios          # writes ios/App/App/capacitor.config.json and the web assets
npx cap open ios          # opens the project in Xcode
```

In Xcode, select the **App** target:

1. **Signing & Capabilities:** choose your team. Bundle ID `menu.tableside.app`. The **Push
   Notifications** capability comes from `App/App.entitlements`; if Xcode asks, add it there.
2. Run on a simulator or a phone to try it. iOS Simulator on Apple silicon receives real APNs
   pushes (sandbox gateway).
3. **Product → Archive**, then **Distribute App → App Store Connect → Upload**.

Version: `MARKETING_VERSION` (1.0.0) and `CURRENT_PROJECT_VERSION` (build 1) in the target's build
settings. Every upload needs a higher build number.

## Push alerts: the server side

In the Apple Developer account, **Certificates, Identifiers & Profiles → Keys**, create a key with
**Apple Push Notifications service (APNs)** and download the `.p8` (only possible once). Then set on
Vercel (Production):

| Variable           | Value                                                  |
| ------------------ | ------------------------------------------------------ |
| `APNS_KEY_ID`      | the key's ID                                           |
| `APNS_TEAM_ID`     | your Team ID (Membership details)                      |
| `APNS_PRIVATE_KEY` | the `.p8` contents (one line: newlines written as `\n`) |
| `APNS_BUNDLE_ID`   | `menu.tableside.app` (the default)                     |

Redeploy. One key works for both the sandbox gateway (Xcode builds) and production (TestFlight,
App Store). The server learns which one each phone's token belongs to.

## App Store review notes

The app is for restaurant staff. Reviewers need a staff sign-in: see
`docs/play-store/app-content-answers.md` §2 for the reviewer account (a manager of a demo
restaurant), and `docs/app-store/listing.md` for the review notes to paste.
