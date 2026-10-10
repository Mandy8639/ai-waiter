# Google Play: App content answers

Draft answers for Play Console → **Policy and programs → App content** for the Tableside staff app
(`menu.tableside.app`), written 2026-10-10. Every answer is checked against what the app actually
does and matches the privacy policy at https://tableside.menu/privacy. If the app starts collecting
something new, update the policy, this file and the Data safety form together.

Already done: **Privacy policy** → `https://tableside.menu/privacy` (saved 2026-10-10).

---

## 1. Ads

**Does your app contain ads?** → **No**

There are no ads, and no ad or analytics SDKs (the built app requests only `POST_NOTIFICATIONS`).

## 2. Sign in details (App access)

**All or some functionality is restricted** → provide instructions.

Reviewers need a working sign-in. **Create a dedicated reviewer account first**: don't give Google
your own or Nashta's.

1. Sign up at tableside.menu with a new address you control (e.g. a `+playreview` Gmail alias) and a
   long random password.
2. From your own owner account, create a small **demo restaurant** with a few dishes and a table, and
   invite the reviewer account as a **manager** (not owner).
   - As a manager, the reviewer sees every staff screen.
   - The reviewer can also try account deletion, which a restaurant's only owner can't.
   - If they do delete it, recreate the account before the next review.

Instructions to paste:

> Tableside is the staff app for restaurants using Tableside: kitchen board, table requests and
> order alerts. Sign in with the details below. The account is a manager of a demo restaurant, so
> every staff screen is available. To see an order arrive, open the demo table's link in any
> browser (Dashboard → Tables → the table's QR page → copy its link), add a dish and place the
> order. It appears on the kitchen board and sends a notification if alerts are on. Account
> deletion: Account (top of the dashboard) → Delete your account.

Fields: username = the reviewer email; password = its password; "Any other information" = the demo
table's link.

## 3. Content ratings (IARC questionnaire)

Answered 2026-10-10 in Play Console. The answers are saved; the owner submits the rating from the Summary step.

- **Email for IARC:** the Play Console address. **Category:** All Other App Types.

| Section → question                                                                                                          | Answer       | Why                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| Downloaded app: ratings-relevant content in the app package itself                                                          | No           | Everything comes from tableside.menu; the package has no content of its own                     |
| User content sharing: users interact or exchange content (text, images...)                                                  | **Yes**      | Diners send table requests and feedback text to staff; restaurants publish menus to diners      |
| ↳ User-generated content is the primary source of content                                                                   | **Yes**      | Menus, orders and requests are created by restaurants and diners, not by Tableside              |
| ↳ Public sharing of nudity / graphic violence                                                                               | No / No      | —                                                                                               |
| ↳ Block users or content / report / chat moderation                                                                         | No / No / No | No such features: there is no user-to-user chat                                                 |
| ↳ Interactions limited to invited friends                                                                                   | No           | No friends feature                                                                              |
| Online content: features content not in the download                                                                        | **Yes**      | Menus load from the site; the AI waiter generates text                                          |
| ↳ Violence / sexuality / offensive language / illegal or recreational drugs                                                 | No ×4        | —                                                                                               |
| Age-restricted products: does the app **focus on** promoting or selling alcohol, tobacco, firearms, gambling?               | **No**       | It's for ordering restaurant food; a restaurant may list drinks, but that isn't the app's focus |
| Miscellaneous: shares precise location / digital goods / cash rewards or crypto / web browser or search / news or education | No ×5        | —                                                                                               |

Resulting ratings (driven by "Users Interact" and user-generated content as the main content):
ESRB **Teen**, PEGI **Parental guidance**, USK **16+** ("Increased Communication Risks"), ClassInd
and IARC generic **12+**. That's fine for a staff tool whose target audience is 18+.

## 4. Target audience and content

- **Target age groups:** **18 and over** only.
- **Could your app unintentionally appeal to children?** → **No** (a restaurant operations tool, no
  child-oriented content).
- Ads to children / Families policy: not applicable.

## 5. Data safety

Entered 2026-10-10 and **saved as a draft**: all 14 data types completed and checked in Play's preview. Play won't take the final Save until Target audience is done, which waits on Sign in details (the reviewer account).

**Overview**

| Question                                                                                    | Answer                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does your app collect or share any of the required user data types?                         | **Yes**                                                                                                                                                                                                                                                                  |
| Is all of the user data collected by your app encrypted in transit?                         | **Yes** (HTTPS only)                                                                                                                                                                                                                                                     |
| Which methods of account creation does your app support?                                    | **Username and password** (email + password)                                                                                                                                                                                                                             |
| Delete account URL                                                                          | `https://tableside.menu/privacy` (entered 2026-10-10). Google wants this page to show the deletion steps and what's kept to someone signed out, and `/account` only shows sign-in. A dedicated public `/delete-account` page would fit Google's wording best (follow-up) |
| Can users request that some or all of their data is deleted without deleting their account? | **Yes**, by emailing privacy@tableside.menu (privacy policy, "Your choices"). Delete data URL: `https://tableside.menu/privacy`                                                                                                                                          |

**Data types**

_Collected_ means it leaves the device and reaches Tableside's servers. _Shared_ means a third party
gets it for its own purposes. Service providers acting for Tableside (Supabase, Vercel, Stripe,
Sentry, Resend) are not "sharing" under Google's definition. All collection is **required** (not
optional) unless noted, and none is processed only ephemerally.

| Category → type                                            | Collected | Shared             | Purposes                                                        | Notes                                                                              |
| ---------------------------------------------------------- | --------- | ------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Personal info → **Email address**                          | Yes       | No                 | Account management, App functionality, Developer communications | Sign-in, staff invites, owner emails                                               |
| Personal info → **Name**                                   | Yes       | No                 | App functionality                                               | The name a diner gives with a reservation request                                  |
| Personal info → **Phone number**                           | Yes       | No                 | App functionality                                               | Reservation requests, restaurant phone                                             |
| Personal info → **User IDs**                               | Yes       | No                 | Account management, App functionality                           | The account ID                                                                     |
| Financial info → **Purchase history**                      | Yes       | No                 | App functionality                                               | Orders, payments, refunds (amounts and status; card numbers never reach Tableside) |
| Messages → **Other in-app messages**                       | Yes       | **Yes** (see note) | App functionality                                               | AI waiter conversations, order notes, table requests, feedback                     |
| Photos and videos → **Photos**, **Videos**                 | Yes       | No                 | App functionality                                               | Dish photos and the restaurant's hero video uploaded by owners. Optional           |
| App activity → **App interactions**                        | Yes       | No                 | Analytics                                                       | Dish open/add/order counts, aggregated per day with no session or user             |
| App info and performance → **Crash logs**, **Diagnostics** | Yes       | No                 | Analytics                                                       | Sentry error reports with IP addresses and personal details left out               |
| Device or other IDs                                        | Yes       | No                 | App functionality                                               | The device's push-notification subscription, for order alerts. Optional            |

**Not collected:** location, contacts, calendar, files, audio (voice input goes to the browser's
own speech service, never to Tableside), web browsing history, health, financial account or card
details, installed apps, advertising ID.

**Note: AI waiter messages as "Shared".** Diners' questions to the AI waiter go to an AI model
provider (Anthropic, or a model via OpenRouter). The privacy policy says free-model providers may
keep messages or use them to improve their models, which is "for their own purposes". So
**declare Messages as shared**. Over-declaring is allowed, and under-declaring is a policy
violation. If the AI waiter only ever uses a provider that contractually doesn't retain or train
on data, this can change to "not shared".

## 6. Advertising ID

**Does your app use advertising ID?** → **No**

The built app's only permission is `POST_NOTIFICATIONS`; there's no `AD_ID` permission and no
advertising SDK.

## 7. Government apps

**Is your app developed by or on behalf of a government?** → **No**

## 8. Financial features

→ **My app doesn't provide any financial features.**

Diners pay restaurants for food and drink through Stripe, like a shopping app. Tableside isn't a
bank, wallet, lender, trading app or money-transfer service, and staff only record and refund
payments for their own restaurant's orders.

## 9. Health apps

→ **My app does not have any health features.**

Dishes can show nutrition facts, but the app doesn't track anyone's intake, weight, fitness or
health. It's menu information, not a nutrition or health tool.

---

## After the declarations

- **Store listing:** short description, full description, app icon (512×512), feature graphic
  (1024×500), at least 2 phone screenshots.
- **Publishing overview → Send for review:** sends the privacy policy and everything above to Google
  together.
