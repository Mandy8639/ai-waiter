# Tableside for Android (staff app)

A Trusted Web Activity: the live site (`https://tableside.menu`, opening on
`/dashboard/kitchen`) wrapped as a Play Store app, generated with Google's
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap). There is no
native code to maintain; changes to the website reach the app immediately.

`twa-manifest.json` is the source of truth. The rest of this folder is
generated from it, so edit that file and regenerate rather than editing the
Gradle files by hand.

## Rebuild

Needs Bubblewrap (`npm i -g @bubblewrap/cli`), with its JDK 17 and Android
SDK paths in `~/.bubblewrap/config.json`.

```bash
cd android
bubblewrap update            # regenerate after editing twa-manifest.json (bumps the version)
bubblewrap build             # asks for the keystore password
```

Outputs `app-release-bundle.aab` (upload this to Play) and
`app-release-signed.apk` (for installing directly on a test phone). Both are
git-ignored.

Every Play upload needs a higher `appVersionCode`; `bubblewrap update` bumps
it. Use `--skipVersionUpgrade` when only regenerating.

## Signing

The upload key lives outside the repo in `~/Documents/tableside-signing/`
(keystore + password file). It is never committed. With Play App Signing,
Google holds the key that signs what users install; this upload key only
proves uploads come from us, and Google can reset it if it is lost.

## Digital Asset Links

`public/.well-known/assetlinks.json` tells Android that this app and
tableside.menu belong together; without it the app shows a browser address
bar. It must list:

1. the upload key's SHA-256 (for test installs of the signed APK), and
2. Play's **app signing key** SHA-256, from Play Console → Test and
   release → App integrity, after the first upload.

Check it with:
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://tableside.menu&relation=delegate_permission/common.handle_all_urls
