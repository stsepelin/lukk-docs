---
layout: home

hero:
  name: lukk
  text: First-party JWT auth for Laravel
  tagline: Short-lived access JWTs and rotating refresh tokens on the server — with a TypeScript client and a Nuxt module that mirror the contract exactly. One package on each side, documented together.
  actions:
    - theme: brand
      text: Get Started
      link: /introduction
    - theme: alt
      text: How It Works
      link: /how-it-works
    - theme: alt
      text: View on GitHub
      link: https://github.com/stsepelin/lukk

features:
  - title: First-party by design
    details: Not Passport, Sanctum, or OAuth. No client IDs, redirect URIs, or PKCE — just the patterns that carry their weight when you own both the client and the API.
  - title: Rotation + reuse detection
    details: Opaque refresh tokens stored only as a hash, rotated on every use. Replaying a consumed token revokes the whole session. A cache-backed denylist revokes instantly.
  - title: A client that can't drift
    details: lukk-core mirrors the HTTP contract in TypeScript and is conformance-tested against a real lukk instance. lukk-nuxt adds composables, route middleware, and a sealed BFF proxy.
  - title: Opt-in, feature-gated
    details: One runtime dependency on the server. Two-factor (TOTP) and passkeys (WebAuthn) each pull a single extra library, only when you enable the feature.
---

## The two halves

lukk is documented as one story with two sides:

- **[lukk](https://packagist.org/packages/lukk/lukk)** — the Laravel package. Issues and verifies the tokens, owns rotation, reuse detection, the denylist, and the optional 2FA / passkey / email-verification flows.
- **[lukk-js](https://www.npmjs.com/package/lukk-nuxt)** — the TypeScript client (`lukk-core`) and Nuxt module (`lukk-nuxt`). Attaches the bearer, refreshes before requests fail, and drives the browser ceremonies.

Throughout these docs, a feature page shows **both sides**: what you configure on the server, and how you call it from the client. New here? Start with the **[Introduction](/introduction)**.
