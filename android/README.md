# Tableside for Android (staff app)

The staff dashboard at tableside.menu in a native Android shell, built with
[Capacitor](https://capacitorjs.com) (`capacitor.config.ts` at the repo root), like the iOS app
(`ios/`). Package `menu.tableside.app` on Google Play.

Versions 1.0.0 and 1.1.0 (codes 1 and 2) were a Trusted Web Activity built with Bubblewrap; it
lives in git history. The native app replaced it in 1.2.0 so new orders can **ring until someone
accepts them**, which a TWA can't do.

## What it adds over the website

- **Orders that ring like a delivery tablet.** The server sends data-only Firebase Cloud Messaging
  messages (`src/lib/push/fcm.ts`). `OrderAlertService` receives them, and `OrderAlerts` shows a new
  order on its own **silent "New orders"** channel. **`OrderRingService` plays the ring itself**
  (`res/raw/order_ring.wav`, looped on the alarm stream). Some phone makers (vivo/iQOO) replace an
  app's channel sound with the system default, but not a sound the app plays. It's a short
  foreground service (`shortService` on Android 14+, so no extra permission or Play declaration):
  - it rings in 28-second bursts, and the server re-sends every 30 seconds while the order waits,
    so it sounds near-continuously;
  - touching or swiping the alert silences it;
  - when anyone accepts, a "stop" message silences every phone.
- **Table requests** go on a separate, ordinary "Table requests and other alerts" channel.
- **App mode:** every request carries `TablesideApp/android` in the user agent, so the site hides
  plan purchases (Google Play Payments policy, `src/lib/app-shell/core.ts`).
- **An offline screen** (`ios-shell/offline.html`, shared) instead of a web view error.

## Build

Needs JDK 21 and the Android SDK (platform 36). On this machine:

```bash
export JAVA_HOME="$HOME/.tableside/jdk-21.0.12.1+1/Contents/Home"
export ANDROID_HOME="$HOME/.bubblewrap/android_sdk"
npx cap sync android        # copies capacitor.config and the plugins into android/
cd android && ./gradlew assembleDebug
```

`app/google-services.json` (from the Firebase project's Android app) must be present, or the app
builds but can't register for alerts.

### Release (Play upload)

The upload key never lives in the repo (`~/Documents/tableside-signing/`). Gradle reads it from the
environment:

```bash
export TABLESIDE_KEYSTORE="$HOME/Documents/tableside-signing/upload.keystore"
export TABLESIDE_KEY_ALIAS=upload
export TABLESIDE_KEYSTORE_PASSWORD=…   # from PASSWORD.txt in that folder
export TABLESIDE_KEY_PASSWORD=…
cd android && ./gradlew bundleRelease
# → app/build/outputs/bundle/release/app-release.aab
```

Every upload needs a higher `versionCode` (`app/build.gradle`).

## The server side

In the Firebase console: **Project settings → Service accounts → Generate new private key**, then
set on Vercel (Production) from that JSON and redeploy:

| Variable           | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| `FCM_PROJECT_ID`   | `project_id`                                                   |
| `FCM_CLIENT_EMAIL` | `client_email`                                                 |
| `FCM_PRIVATE_KEY`  | `private_key` (one line, with the `\n` line breaks as written) |

Until they're set, the kitchen board hides "Turn on alerts" in the Android app.
