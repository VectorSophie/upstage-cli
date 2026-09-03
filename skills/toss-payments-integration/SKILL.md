---
name: toss-payments-integration
description: >
  Use when integrating Korean payment gateways (Toss Payments, PortOne/아임포트, KG이니시스, NHN KCP) into a
  Korean web/app project — covers the two dominant PG provider families, the client-key vs secret-key
  confusion that's a constant source of bugs, webhook/callback verification, and test-mode pitfalls.
license: MIT
---

# Korean payment gateway integration

Korea's payment ecosystem is structurally different from Stripe-style
single-provider integrations: most projects go through an aggregator
(PortOne/아임포트, formerly "I'mport") that fronts multiple underlying PGs
(NHN KCP, KG이니시스, 나이스페이 etc.), or integrate a specific provider
directly (Toss Payments is the most common direct integration for new
projects).

**Recurring real-world gotchas, check for these specifically:**
- **Client key vs. secret key confusion.** The client-side SDK key
  (safe to expose in frontend code) and the server-side secret key (used
  to confirm/capture a payment) are easy to mix up — a secret key
  accidentally shipped to the frontend is a real, recurring incident
  class. When reviewing payment integration code, explicitly check which
  key is used where.
- **Test mode vs. live mode keys are entirely separate credential pairs**,
  not a flag on one key — a common bug is deploying with test-mode keys
  still in production env vars (payments silently never actually charge)
  or the reverse (accidentally charging real cards from a staging
  environment).
- **Payment confirmation is a two-step flow**: the client-side SDK
  initiates a payment and gets a `paymentKey`/`impUid`-style token, but
  the actual charge must be *confirmed* from the server with the secret
  key against that token — trusting a client-reported "success" without
  a server-side confirmation call is a spoofable payment bypass.
- **Webhook/callback signature verification** — treat an unverified
  webhook payload as untrusted input; don't mark an order paid based on
  a webhook call alone without verifying its signature against the
  provider's documented method.

**When writing this integration**, prefer reading the target provider's
current official docs over relying on memorized specifics — payment APIs
change field names and flows across versions, and getting this wrong has
real financial consequences. This skill is about knowing *which
categories of mistakes to check for*, not a substitute for the current
API reference.
