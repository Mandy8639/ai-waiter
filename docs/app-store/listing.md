# App Store listing

Draft for App Store Connect, Tableside staff app (`menu.tableside.app`), written 2026-10-11 and
refreshed 2026-10-20 for what the app does now, and entered into App Store Connect 2026-10-24 (version 1.0.0, build 1). Every
claim describes something the app does today. The Google Play counterpart is
`docs/play-store/listing/README.md`; the two stores' privacy answers agree.

## App information

| Field              | Value                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| Name (max 30)      | `Tableside for Restaurants` (25). Plain `Tableside` was already taken (2026-10-24) |
| Subtitle (max 30)  | `Kitchen board & order alerts` (28)                                                |
| Bundle ID          | `menu.tableside.app`                                                               |
| SKU                | `tableside-staff`                                                                  |
| Primary language   | English (U.S.)                                                                     |
| Primary category   | Business                                                                           |
| Secondary category | Food & Drink                                                                       |
| Content rights     | No third-party content                                                             |
| Age rating         | 4+ (answers below)                                                                 |
| Price              | Free                                                                               |
| Availability       | United States to start (add countries any time)                                    |
| Privacy Policy URL | `https://tableside.menu/privacy`                                                   |
| Support URL        | `https://tableside.menu/support`                                                   |
| Marketing URL      | `https://tableside.menu`                                                           |
| Copyright          | `2026 Beacon Digital Consulting LLC`                                               |
| Version            | 1.0.0 (build 1), as set in Xcode                                                   |
| Export compliance  | Already answered in the build (`ITSAppUsesNonExemptEncryption` = NO: HTTPS only)   |

## Promotional text (max 170)

Can be changed any time without a new version.

```
Every order on one live board, table requests the moment they happen, and alerts on your phone, for restaurants that take orders with Tableside.
```

## Keywords (max 100, comma-separated, no spaces after commas)

```
restaurant,kitchen,orders,KDS,QR menu,waiter,POS,staff,tickets,cafe,dine-in,table service,alerts
```

## Description (max 4000)

```
Tableside is the staff app for restaurants that take orders with Tableside. Diners scan the QR code on their table, browse your menu and order from their own phone. This app is for your team: it puts every order, table request and alert in one place.

KITCHEN BOARD
• Every order appears on a live board the moment a diner places it, dine-in and pickup.
• New orders keep chiming until someone accepts them, so nothing waits unseen.
• Move tickets through confirmed, preparing, ready and served with one tap, with a few seconds to undo.
• Split an order across tickets or merge several, and send dishes to kitchen stations.
• Print kitchen tickets on a receipt printer, automatically or by hand.
• If a diner cancels before you accept, the board tells you.

TAKE ORDERS
• Ring up a table, a walk-in or a phone order on the Take order screen and send it straight to the kitchen.
• Add options, quantities and a note for the kitchen to each dish.
• Record cash or card-machine payments as soon as a takeout order is placed.

BUSY NIGHTS
• Mark a dish sold out until tomorrow, or an add-on like oat milk, and diners see it straight away.
• Add wait time when you're slammed, or pause new orders for a while.
• Or just tell the Waiter, the built-in assistant: "86 the paneer tikka", "pause ordering for an hour". It asks before changing prices, and every change can be undone.

TABLE REQUESTS
• See straight away when a table wants a waiter or the bill.
• Mark a request done when it's handled.

ORDER ALERTS
• Get a notification on your iPhone or iPad for new orders and table requests, even when the app is closed.
• Tap an alert to open the order.
• Mute alerts during a quiet moment, or turn them off any time.

ORDERS AND REPORTS
• Find any order by number or dish, and filter by status or date.
• See today's orders and takings at a glance, with reports for each day.
• See how often guests come back and what they order.

YOUR MENU
• Add and edit dishes, prices, photos, allergens and modifiers, and diners see the changes right away.
• Import a menu from photos of your printed one, then check every dish before it goes live.
• No photos yet? Generate a picture of each dish, approve the ones you like, and diners see them labelled "AI-generated".
• Translate your menu and add nutrition information.

YOUR TEAM
• Invite staff with a link and give each person the right role: owner, manager, kitchen or staff.

Tableside needs a restaurant account. Your restaurant's owner sets it up at tableside.menu and invites the team; then sign in here with the same email.

Support: https://tableside.menu/support
Privacy policy: https://tableside.menu/privacy
```

The Play description's PAYMENTS paragraph is left out on purpose. Diners paying restaurants by card
is allowed (physical goods, Guideline 3.1.3(e)), but the in-app copy stays away from anything that
reads like buying something.

## Screenshots

| Display     | Files                                                             | Size        |
| ----------- | ----------------------------------------------------------------- | ----------- |
| iPhone 6.9" | `screenshots/iphone-6.9/1-kitchen.png` … `4-menu.png`             | 1320 × 2868 |
| iPhone 6.3" | the same four scaled with `sips -z 2622 1206` (what was uploaded) | 1206 × 2622 |
| iPad 13"    | `screenshots/ipad-13/1-kitchen.png` … `4-menu.png`                | 2064 × 2752 |

As of October 2026, App Store Connect's iPhone slot is "iPhone with Dynamic Island (medium display)" and only accepts 6.1"/6.3" sizes (1179 × 2556 or 1206 × 2622); it rejected 1320 × 2868, so the 6.3" copies were uploaded and used for every iPhone size. iPad
screenshots are required because the app runs on iPad (`TARGETED_DEVICE_FAMILY` 1,2).

They show the fictional demo restaurant "Saffron & Sage" on the disposable test project, signed in
as the demo owner in iOS app mode, never real restaurant or diner data. Captions are in the brand
colours (`#FEF2DF` on `#842B02`), like the Play set.

## Age rating questionnaire

Every question is **None** or **No**, which gives **4+**:

- Parental controls, age assurance: No.
- Unrestricted web access: **No**. The app only opens tableside.menu; any other link opens in
  Safari.
- User-generated content, messaging and chat: **No**. The app shows a restaurant's own orders,
  menu and table requests to that restaurant's staff. Diners' requests and feedback go privately to
  the restaurant they ordered from; nothing is published to other users, and there's no chat between
  users. (Play's questionnaire asks differently and got "Yes"; Apple's question is about content
  shared with other users, which would also bring in Guideline 1.2's report and block tools.)
- Advertising: No.
- Violence, sexual content, profanity, horror, drugs, medical, gambling, contests, loot boxes: None.
- Alcohol, tobacco or drug use or references: **None**. A restaurant may list drinks on its menu,
  but the app isn't about them (the same answer as Play's "focus on" question).

## App Privacy ("nutrition label")

**Do you or your third-party partners collect data from this app?** Yes.
**Tracking:** No data is used to track users. No advertising, no data brokers.

| Apple data type                     | Linked to the user | Purposes          | What it is                                                                    |
| ----------------------------------- | ------------------ | ----------------- | ----------------------------------------------------------------------------- |
| Contact Info → Email Address        | Yes                | App Functionality | Sign-in, staff invites, owner emails                                          |
| Contact Info → Name                 | Yes                | App Functionality | The name a diner gives with a reservation request                             |
| Contact Info → Phone Number         | Yes                | App Functionality | Reservation requests, the restaurant's phone                                  |
| Identifiers → User ID               | Yes                | App Functionality | The account ID                                                                |
| Identifiers → Device ID             | Yes                | App Functionality | The device's push token, for order alerts. Only if alerts are on              |
| Purchases → Purchase History        | Yes                | App Functionality | Orders, payments, refunds (card numbers never reach Tableside)                |
| User Content → Photos or Videos     | Yes                | App Functionality | Dish photos, menu photos for import, the hero video owners upload             |
| User Content → Other User Content   | Yes                | App Functionality | AI waiter chats, staff Waiter commands, order notes, table requests, feedback |
| Usage Data → Product Interaction    | **No**             | Analytics         | Dish open/add/order counts per day, with no session or user                   |
| Diagnostics → Crash Data            | **No**             | App Functionality | Sentry error reports, IP addresses and personal details left out              |
| Diagnostics → Other Diagnostic Data | **No**             | App Functionality | The same error reports                                                        |

Not collected: location, contacts, health, financial info (card details stay with Stripe), browsing
or search history, sensitive info, audio (voice input runs on the device's speech service and sends
Tableside text only).

## App Review information

**Sign-in required: Yes.** Enter the reviewer account's email and password in App Store Connect's
sign-in fields, never in this repo. The account is the same one Google Play's reviewers use
(`docs/play-store/app-content-answers.md` §2): a **manager** of a demo restaurant on production with
a few dishes and tables, never a real restaurant's data.

**Contact:** your name, phone and email (Apple only uses them if something blocks the review).

**Notes** (paste, and fill in the restaurant's menu link):

```
Tableside is a staff app for restaurants. Diners order from a QR code on their table in the browser; this app is for the restaurant's team.

To try it: sign in with the account above (a manager of our demo restaurant). The Kitchen tab is the live order board. To see a new order arrive, open this demo table's menu in Safari on another device or the simulator, add a dish and place the order:
https://tableside.menu/r/tableside-demo-cafe/table/12294b71-fb06-4647-9d41-cade6da866d2
It appears on the board within seconds and chimes until you tap Confirm. On the kitchen board, "Turn on alerts" asks for notification permission; after that, new orders and table requests arrive as push notifications even when the app is closed, and tapping one opens the order. "Send a test" sends one straight away. "Take order" lets staff ring up an order themselves.

Native features: push notifications through APNs, notification taps that open the order, and an offline screen when there's no connection.

AI features: the "Waiter" button lets staff type kitchen changes ("86 the paneer tikka"); a third-party AI model only interprets the command, and nothing changes without the rules behind it, prices only after a yes. Owners can also generate pictures of dishes; each is approved by the restaurant before diners see it and is always labelled "AI-generated". No diner or staff personal data is sent to AI models from this app.

Accounts: restaurant owners create their restaurant at tableside.menu and invite staff. Staff can delete their account in the app from Account (top of the dashboard).

Payments: there are no purchases in the app. Restaurants' Tableside subscriptions are sold to businesses on our website and the app neither offers nor links to them (Guidelines 3.1.1 and 3.1.3(c)). Diners pay restaurants for food in the browser, which is a physical-goods purchase.
```

## Before you submit

1. **APNs on Vercel.** Set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` and `APNS_BUNDLE_ID`
   (see `ios/README.md`) and redeploy. Until then the kitchen board hides the alerts button in the
   iPhone app, and the description's ORDER ALERTS section isn't true yet.
2. **The reviewer account** exists, and you've signed in with it in the app once.
3. **A demo table's menu link** for the review notes (Tables & QR, on the demo restaurant).
4. **Fresh screenshots.** The set in `screenshots/` is from 2026-10-11; the dashboard has changed since
   (Waiter button, Sold out, busy mode, menu photos). Retake both sizes from a fictional demo
   restaurant before uploading.
5. **Build uploaded** from Xcode (Product → Archive → Distribute App → App Store Connect) and
   selected on the version page.
