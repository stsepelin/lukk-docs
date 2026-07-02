# Introduction

lukk is a small, focused authentication system for **first-party** applications — apps where you own both the client and the API, so there's no third party to delegate to. It has two halves that are designed and documented together:

- **lukk** (Laravel) issues short-lived **access tokens** (signed JWTs) and long-lived, opaque, **rotating refresh tokens**, with reuse detection and instant revocation.
- **lukk-js** (TypeScript / Nuxt) is the client that talks to it — attaching the bearer, refreshing before requests fail, surviving a 401, and driving the 2FA and passkey ceremonies.

lukk-js mirrors lukk's HTTP contract in TypeScript and is [conformance-tested against a real lukk instance](/architecture#conformance), so the types you code against can't silently drift from the server.

## Not OAuth

lukk is intentionally **not** Passport, Sanctum, or an OAuth2 server. There are no client IDs, redirect URIs, or authorization-code/PKCE flows — that machinery exists to delegate access to third parties, and a first-party app has none. lukk keeps only the patterns that carry their weight:

- **Short-lived access JWTs** — stateless, verified on every request.
- **Opaque rotating refresh tokens** — rotated on every use, stored only as a hash.
- **Reuse detection** — replaying a consumed token revokes the entire session.
- **A denylist** — revoke an access token or a whole session instantly.

If you need third-party sign-in (users authenticating *your* app against *someone else's* identity provider), that's an OAuth/OIDC problem, and lukk is not the tool.

## The token model

| | |
|---|---|
| **Access token** | An HS256 JWT, valid for 15 minutes. Carries `iss`, `aud`, `sub`, `fid` (refresh family id), `jti`, `iat`, `nbf`, `exp`, with the header `typ=at+jwt`. On every request the algorithm is pinned, `iss`/`aud` are asserted, and the denylist is checked by both `jti` and `fid`. |
| **Refresh token** | An opaque, 256-bit random string, valid for 30 days. Returned to the client once and stored only as a `sha256` hash. Rotated on every refresh; replaying one after the grace window revokes the whole token family. |

HS256 (a shared secret) is the right default while your app is the only thing verifying its own tokens — no keypair to manage, no JWKS to publish. If an independent service ever needs to verify your tokens, RS256/ES256 + a JWKS endpoint + `kid` rotation are built in behind the same contracts: run `php artisan lukk:keygen`, flip `LUKK_ALGORITHM`, done. See [Deployment → Asymmetric keys](/deployment#asymmetric-keys).

## The packages

| Package | What it is |
|---|---|
| **lukk** | The Laravel package (`Lukk\` namespace). One runtime dependency ([`firebase/php-jwt`](https://github.com/firebase/php-jwt)); optional 2FA and passkeys each add one library, only when enabled. |
| **lukk-core** | Framework-agnostic TypeScript: the contract **types**, an auth **client** (`createLukkClient`) that attaches tokens and refreshes on a 401 with single-flight, and **WebAuthn helpers**. No runtime dependencies. |
| **lukk-nuxt** | A Nuxt 3/4 module built on `lukk-core`: auto-imported composables, route middleware, the BFF proxy, and the transport wiring. |

On Nuxt, install `lukk-nuxt` and never touch `lukk-core` directly. On another framework (or none), use `lukk-core` — see [Using lukk-core](/lukk-core).

## The two transport modes

The client speaks to lukk in one of two modes. The mode is a single config value; **your component code is identical either way.**

- **`bff`** — a Nitro proxy holds the tokens in a sealed, server-side cookie and forwards requests to lukk. The browser only ever talks to your own origin and never sees a token. Best for SSR or a served SPA.
- **`direct`** — the client calls lukk directly. The access token lives in memory; the refresh token lives in lukk's hardened `__Host-` cookie. The only option for a fully static site (SSG).

See [Transport Modes](/transport-modes) for the full comparison.

## Requirements

**Server:** PHP `^8.3` · Laravel `^12.0 | ^13.0` · `firebase/php-jwt` `^7.0`.
**Client:** Node `>= 20` · Nuxt `3` (`>= 3.13`) or `4` (for `lukk-nuxt`).

> [!WARNING]
> `firebase/php-jwt` v7 hard-enforces an HMAC secret of at least 256 bits. A too-short `LUKK_SECRET` fails loudly at signing time instead of weakly signing — `php artisan lukk:secret` generates a key that clears the floor.

Next: **[How It Works](/how-it-works)**, or jump to **[Installation](/installation)**.
