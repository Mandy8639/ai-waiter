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
   The **Time Sensitive Notifications** capability also comes from `App/App.entitlements`, so new
   orders ring through Focus; if Xcode asks, add it there too.
2. Run on a simulator or a phone to try it. iOS Simulator on Apple silicon receives real APNs
   pushes (sandbox gateway).
3. **Product → Archive**, then **Distribute App → App Store Connect → Upload**.

Version: `MARKETING_VERSION` (1.0.0) and `CURRENT_PROJECT_VERSION` (build 1) in the target's build
settings. Every upload needs a higher build number.

## The order ring

New-order alerts play `App/order-ring.caf`, a 29-second chime bundled in the app (Apple's limit
for notification sounds is 30 seconds), and the server repeats the alert every 30 seconds until
the order is accepted (docs/security.md, "Order ring"). To change the sound, replace the file with
another CAF under 30 seconds and keep the name; `tests/unit/apns-core.test.ts` checks it's bundled.

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

## Tap to Pay on iPhone

Staff take card payments on the phone itself from Settle up (Stripe Terminal through
`@capacitor-community/stripe-terminal`; server side in `src/lib/payments/tap-to-pay.ts`). The code
and the location and Bluetooth purpose strings are in the app; what's left needs the Apple account:

1. **Request the entitlement.** In the Apple Developer account, request **Tap to Pay on iPhone**
   (Apple reviews it; the form asks how the app is used and by whom). Development access comes
   first, distribution access later.
2. **Add the capability** once granted: Xcode → App target → Signing & Capabilities → **+ Tap to
   Pay on iPhone**. That adds `com.apple.developer.proximity-reader.payment.acceptance` to
   `App.entitlements`. Don't add it by hand before Apple grants it: signing fails without it on the
   provisioning profile.
3. **Test on a real iPhone XS or newer** (the simulator can't). The first tap on a phone shows
   Apple's terms for the merchant, which an owner or manager accepts once.
4. **Before App Review**, Apple checks its Tap to Pay requirements (education screens, the
   "Tap to Pay on iPhone" name and mark). See Apple's Tap to Pay on iPhone marketing and
   implementation guidelines.

On Android nothing extra is needed beyond NFC switched on (Android 11+). Live payments only work
from the Play build, not a debug build.

## App Store review notes

The app is for restaurant staff. Reviewers need a staff sign-in: see
`docs/play-store/app-content-answers.md` §2 for the reviewer account (a manager of a demo
restaurant), and `docs/app-store/listing.md` for the review notes to paste.
