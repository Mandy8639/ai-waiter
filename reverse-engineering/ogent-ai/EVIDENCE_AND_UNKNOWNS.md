# Ogent.AI — evidence, limitations, next steps

## How evidence was gathered

- **REA tools:** none available. The `reverse-engineer-anything` skill is not installed in this
  session. `ToolSearch` for `binary_session`, `analyze_javascript_application`,
  `list_browser_targets`, `open_binary` and `trace_application_feature` returned no tools.
  **There are no REA Evidence IDs.** The IDs below are this report's own.
- **Only working channel:** the WebSearch tool, which returns a search engine's index entries and
  a model-written summary quoting fragments of each page. This is **secondary, summarised
  evidence of vendor claims**. It is not a page capture. Summaries can merge pages, drop
  context, or reflect stale index copies (one result was flagged as about 151 days old).
- **Classification used across the report:** _Observed_ = present in indexed Ogent copy
  (vendor claim, not exercised). _Inferred_ = this investigation's reasoning. _Unknown_ = no
  evidence either way. **No finding is runtime-observed.**

## Evidence index

All queries ran on 2026-10-18. Most were restricted to `allowed_domains: ["ogent.ai"]`.

| ID  | Source page(s)                                                                                              | Used for                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| E01 | `ogent.ai/` (homepage)                                                                                      | Positioning, segments, pricing, "Coming Soon" AI chat, gateways                               |
| E02 | `ogent.ai/ogent-features`                                                                                   | Merchant app, analytics, refunds, 86 auto-restore, scheduling, delivery radius, special hours |
| E03 | `ogent.ai/site-index`                                                                                       | 46 pages / 9 sections; partner program; company pages                                         |
| E04 | `ogent.ai/faq`                                                                                              | Setup time, tips, AI Assisted Ordering plan, Grubhub coming soon, merchant app cost           |
| E05 | `restaurant.ogent.ai/qr-code-menu-best-practices-for-restaurants/`                                          | Split-bill advice (not a feature claim); blog host                                            |
| E06 | `ogent.ai/table-service-ordering`                                                                           | Table QR flow, reorder, 86 by text, pause                                                     |
| E07 | `ogent.ai/counter-service-ordering`                                                                         | Pickup slots, status machine, SMS, delay, change pickup time, pause presets                   |
| E08 | `ogent.ai/bar-qr-code-ordering`                                                                             | Saved last round, tip per round, 0% commission claim                                          |
| E09 | `ogent.ai/integrations`, Square / Clover / MicroSale integration pages                                      | POS import/push, KDS, printers, Apple/Google Pay, pay-per-order                               |
| E10 | `ogent.ai/get-started`, `ogent.ai/lp/free-qr-ordering`                                                      | Onboarding, "4% of sales", AI assistant by plain English                                      |
| E11 | `ogent.ai/gloriafood-alternative`, `/gloriafood-shutdown`, FAQ link to `migrate-to.ogentai.com`             | Migration tool behaviour, shutdown date claim, partner program                                |
| E12 | `ogent.ai/compare/*` (Toast, Chowly, Tabski, Olo, CloudWaitress, UpMenu)                                    | 86 with countdown timer, AI upsell, month-to-month                                            |
| E13 | Google Play listing `com.ogentai.operator` ("Ogent.ai: Restaurant Operator"), as indexed                    | Merchant app features, biometric login, menu editing                                          |
| E14 | Features/compare pages linking App Store + Play                                                             | iOS availability claim                                                                        |
| E15 | Homepage / about content (also mirrored on `torchfi.com`)                                                   | Company, founder, location, "300+ partners"                                                   |
| E16 | `ogent.ai/ogent-terms-privacy-policy`                                                                       | Card data "conduit" statement                                                                 |
| E17 | `ogent.ai/integrations/square-doordash-integration`, `/guides/doordash-merchant-portal-vs-square-dashboard` | No own processor; payouts via merchant processor                                              |

The full list of observed URLs is in [API_AND_DATA.md](API_AND_DATA.md#observed-public-urls-e03-and-others).

### Contradictions found in the evidence

| Topic               | Conflict                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| Pay As You Go price | 4% of net sales (E01, E10) vs. "0% commission / you pay nothing" (E08, E11) vs. a $29 activation fee (one page) |
| Other tiers         | A $99.99–$149.99/month tier and a $299.99 AI tier appear on one page only                                       |
| AI menu chat        | "Coming Soon" (E01) vs. described as live (E02, E06, E10)                                                       |
| App menu editing    | "On the roadmap" (E02) vs. available (E13)                                                                      |
| Setup time          | ~15 min (E01, E07) vs. under 30 min (E04, Clover page)                                                          |
| POS coverage        | "Any POS" (E01) vs. three named native POSs (E09)                                                               |
| Migration URL       | `ogent.ai/gloriafood-alternative` vs. `migrate-to.ogentai.com` (E11)                                            |

## Blockers

| ID  | Attempt                                                                                     | Result                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| B01 | REA skill and MCP tools                                                                     | Not installed; no tool schemas discoverable                                                                                            |
| B02 | `curl https://ogent.ai` (sandbox, via egress proxy)                                         | `CONNECT tunnel failed, response 403`; proxy status `connect_rejected`                                                                 |
| B03 | `curl` to `ogentai.com`, `migrate-to.ogentai.com`, `restaurant.ogent.ai`, `play.google.com` | Same 403                                                                                                                               |
| B04 | `curl` to `web.archive.org` CDX API and DNS-over-HTTPS (`dns.google`, `cloudflare-dns.com`) | Same 403                                                                                                                               |
| B05 | WebFetch `ogent.ai`, `www.ogent.ai`, `migrate-to.ogentai.com`, `play.google.com`            | `getaddrinfo ENOTFOUND` for every host, including Google. This is a fetch-backend DNS failure, **not** evidence that ogent.ai is down. |
| B06 | WebFetch `web.archive.org`                                                                  | "unable to fetch from web.archive.org"                                                                                                 |

Because of B02–B06, Playwright Chromium (pre-installed) was not launched: it would go through the
same proxy and hit the same denial. Nothing was installed and no REA or client configuration was
changed.

## Unknowns (prioritised)

1. Guest app and dashboard hostnames, frontend framework, API style (REST/GraphQL), and auth
   mechanism.
2. Actual request/response contracts for menu, cart, order, slot, and status updates.
3. How the 4% fee is collected and how processor fees interact with it.
4. The AI assistant's channel (SMS number vs. app chat), sender authorisation, confirmation
   behaviour, and model provider.
5. Pickup-slot granularity, capacity and lead-time rules.
6. Whether 86 / stock changes write back to Square/Clover; menu re-sync cadence.
7. Open-tab vs. pay-per-order at tables; split-check support.
8. Tip default percentages; partial-refund tax/tip proration.
9. Delivery fees, minimums, and dispatch mechanism (Drive/Direct APIs vs. marketplace).
10. Roles and permissions inside a merchant account.
11. Visual design system (entirely unknown).
12. Multilingual support.

## Next investigations

| Step | Needs                                                                                                                                                                                  | Resolves                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| N1   | Add `ogent.ai`, `ogentai.com`, `restaurant.ogent.ai` (optionally `web.archive.org`, `play.google.com`) to this environment's allowed domains (Settings → environment → Network access) | B02–B04                        |
| N2   | Install or connect the REA skill/MCP server (needs your approval; not done here)                                                                                                       | B01                            |
| N3   | Passive capture: homepage, `/get-started`, `/faq`, `/site-index`, `/sitemap.xml`; save HTML, JS bundles, a HAR, and 390/1440 px screenshots                                            | Unknowns 1, 11; UI_SPEC        |
| N4   | Bundle analysis of the guest app on a **public demo storefront** if one exists (read-only)                                                                                             | Unknowns 1, 2, 5, 7            |
| N5   | Static analysis of the merchant APK `com.ogentai.operator` from a legitimate source: strings, API base URLs, auth, push setup                                                          | Unknowns 1, 2, 4, 10           |
| N6   | With Ogent's agreement or a sanctioned trial: a **test store only**, test-mode payments, no real orders or SMS to third parties; run V01–V12 from FEATURES.md                          | Most of the remaining unknowns |

## Resuming this investigation

There is no REA session or retained records to export. To resume, re-run the queries implied by
the evidence index, or better, complete N1 and capture the pages directly. Then upgrade findings
from _Observed (indexed copy)_ to _Observed (runtime)_ and update the coverage matrix in
[README.md](README.md#coverage-matrix).
