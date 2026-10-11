# Google Play store listing

Draft for Play Console → **Grow users → Store presence → Main store listing**, Tableside staff app
(`menu.tableside.app`), written 2026-10-10. Every claim describes something the app does today.

**Entered in Play Console on 2026-10-11:**

- the default store listing (text, icon, feature graphic, 4 screenshots in order);
- store settings (category Business, contact email, website);
- countries (United States);
- the 1.1.0 production release, saved as a draft.

All of it waits in Publishing overview until App content is complete (see the end of this page).

## App name (max 30)

```
Tableside
```

## Short description (max 80)

```
Kitchen board, table requests and order alerts for restaurants using Tableside.
```

(79 characters.)

## Full description (max 4000)

```
Tableside is the staff app for restaurants that take orders with Tableside. Diners scan the QR code on their table, browse your menu and order from their own phone. This app is for your team: it puts every order, table request and alert in one place.

KITCHEN BOARD
• Every order appears on a live board the moment a diner places it.
• New orders keep chiming until someone accepts them, so nothing waits unseen.
• Move tickets through confirmed, preparing, ready and served with one tap.
• Split an order across tickets or merge several, and send dishes to kitchen stations.

TABLE REQUESTS
• See straight away when a table wants a waiter or the bill.
• Mark a request done when it's handled.

ORDER ALERTS
• Get a notification on this device for new orders and table requests, even when the app is closed.
• Mute alerts during a quiet moment, or turn them off any time.

ORDERS AND REPORTS
• Find any order by number or dish, and filter by status or date.
• See today's orders and takings at a glance, with reports for each day.

YOUR MENU
• Add and edit dishes, prices, photos, allergens and modifiers, and diners see the changes right away.
• Translate your menu and add nutrition information.

YOUR TEAM
• Invite staff with a link and give each person the right role: owner, manager, kitchen or staff.

PAYMENTS
• Diners can pay by card at the table, straight into your own Stripe account, or pay cash.

Tableside needs a restaurant account. Sign up and set up your restaurant at tableside.menu, then sign in here with the same email.

Support: https://tableside.menu/support
Privacy policy: https://tableside.menu/privacy
```

## Graphics

| Asset             | File                                       | Spec                                                |
| ----------------- | ------------------------------------------ | --------------------------------------------------- |
| App icon          | `icon-512.png`                             | 512 × 512 PNG, full-bleed (Play rounds the corners) |
| Feature graphic   | `feature-graphic-1024x500.jpg`             | 1024 × 500 JPG, no transparency                     |
| Phone screenshots | `phone-1-kitchen.png` … `phone-4-menu.png` | 1080 × 1920 (9:16), PNG                             |

The screenshots show a fictional demo restaurant ("Saffron & Sage") on the disposable test project,
never real restaurant or diner data. They're framed with a caption, in the brand colours (`#842B02`
on `#FEF2DF`).

## Store settings

- **App category:** Business
- **Tags:** pick from Play's list. Likely fits: Restaurant management, Point of sale, Business tools.
- **Contact email (shown publicly):** `privacy@tableside.menu`, the address the support page uses
  (`src/lib/legal/support.ts`). If you add a `support@tableside.menu` forward in Porkbun, switch both.
- **Website:** https://tableside.menu
- **Phone:** optional; leave blank.

## Countries

United States to start, the same as the App Store. Add more under **Production → Countries /
regions** any time; the listing is English only.

## Production release

- **Bundle:** `android/app-release-bundle.aab`, version 1.1.0 (code 2). It starts in app mode
  (`/dashboard/kitchen?app=android`), so no plan purchases appear in the app. Build it with the
  steps in `android/README.md`; the file is gitignored.
- **Release name:** `1.1.0`
- **Release notes (en-US, max 500):**

```
<en-US>
First release of the Tableside staff app: a live kitchen board, table requests and order alerts for restaurants that take orders with Tableside.
</en-US>
```

- It can't be sent for review until App content is complete: Sign in details needs the reviewer
  account, which unblocks Target audience, which unblocks the final Data safety save
  (`docs/play-store/app-content-answers.md`). Until then, save the release as a draft.
