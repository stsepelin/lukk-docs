# Security Model

This is the security reference for reviewers and the security-minded: the invariants lukk holds, how the client keeps tokens out of the browser, and a checklist you can audit against. For the code layering behind these guarantees see [Architecture](/architecture); for the token internals, [Tokens & Rotation](/tokens-and-rotation).

## The signing invariants

- **Algorithm pinning.** The verifier pins the algorithm from config and stamps it onto every key; it **never reads the alg from the token header.** So an attacker cannot present an HS256 token signed with the public key as the HMAC secret (the classic RS256→HS256 confusion), and `alg=none` is rejected outright. Alg mismatches are rejected too.
- **Delegated crypto.** The JWS layer is delegated entirely to the audited `firebase/php-jwt`. lukk never hand-rolls JWS, TOTP, or WebAuthn — the only sanctioned extra libraries are the 2FA and passkey ones, and they're loaded only when the feature is enabled.
- **Claim validation on every request.** `iss`/`aud`/`exp` (required) plus `nbf`/`iat` (when present) are validated, and the `typ=at+jwt` header is asserted — so a 2FA/step-up **challenge** token (same key, `iss`, `aud`) can't be replayed as a bearer.
- **Secret floor.** The HS256 secret is ≥ 256-bit random (`php artisan lukk:secret`); `firebase/php-jwt` v7 hard-enforces the minimum, so a too-short secret fails loudly instead of weakly signing.

## Rotation, reuse & revocation

- **Opaque, hashed refresh tokens.** Refresh tokens are opaque 256-bit random strings, stored **only as `sha256`** at rest, never logged, never JS-readable, never serialized into any client bundle or hydration payload.
- **Rotation + reuse detection.** Every refresh rotates the token. A post-grace replay of a consumed (or revoked) token revokes the **entire family** and denylists it by `fid`, killing every live access token for that session within one `access_ttl`. It dispatches [`RefreshTokenReused`](/events) for alerting.
- **Revoke-then-throw runs outside the transaction.** The family revoke happens **after** the rotate transaction commits — revoking inside it then throwing would roll back the revoke while the denylist cache write persisted, an inconsistency hole.
- **Grace window prevents false logout.** The `grace_seconds` window serves concurrent legitimate refreshes (multiple tabs, SSR + hydration) a fresh sibling under the same family rather than treating them as theft. See [Tokens & Rotation → The grace window](/tokens-and-rotation#the-grace-window) for the accepted residual trade-off.
- **Instant, cheap revocation.** The denylist lives in the **cache** (keyed by `jti`/`fid`), killing access within one request; global logout (`DELETE /auth/sessions`) works. Each entry self-evicts when its token would have expired anyway.

## Login & responses

- **Constant-time login.** The password check is constant-time; the unknown-user path runs an equivalent `Hash::check`, so a wrong email is indistinguishable from a wrong password (no user enumeration). Login is throttled.
- **Non-cacheable token responses.** Token responses carry `Cache-Control: no-store, private` so a shared cache/CDN never stores them.
- **Fail-safe error codes.** Invalid/expired/revoked/reused refresh tokens return `401`, not 500, without leaking the reason. Expired or not-yet-valid tokens — and tokens whose `sub` user was deleted — are rejected at the guard.

## Transport hardening (client)

Where the tokens physically live is a [transport-mode](/transport-modes) choice, and each mode has its own containment.

### BFF mode — nothing in the browser

- **No token in `localStorage`, ever.** BFF keeps every token — access, refresh, **and** the step-up confirmation token — server-side in a sealed, encrypted cookie. The browser holds only the opaque session cookie, so XSS can't exfiltrate a token.
- **Credential stripping.** The proxy replaces any token- or confirmation-bearing response body with `{ ok: true }` before it reaches the browser, and strips every upstream `Set-Cookie` (re-emitting only lukk's sealed session cookie).
- **CSRF containment.** Moving tokens server-side trades XSS-exfiltration risk for CSRF risk, closed two ways: the session cookie is `__Host-lukk-session` (`SameSite=Strict; Secure; HttpOnly; Path=/`, no `Domain` — the `__Host-` prefix the browser enforces), **and** the proxy rejects any state-changing request whose `Origin` doesn't match your app (`403`). CSRF is enforced by origin, not a token, so Laravel's token-based CSRF (`419`) doesn't apply.
- **SSRF containment.** The proxied subpath is contained to lukk's base URL (no traversal); the app-API proxy forwards to a **fixed** `target`. Both strip the inbound cookie/authorization and any browser-spoofable `X-Forwarded-*` headers (stamping a trusted client IP so Laravel's per-IP throttling/logging can't be poisoned) and mark responses non-cacheable.

> [!WARNING]
> **Keep the sealed session under ~4 KB.** The `__Host-lukk-session` cookie holds the access JWT plus the refresh and confirmation tokens, iron-sealed (~1.34× inflation on top of a fixed envelope). Per [RFC 6265bis §5.6](https://httpwg.org/specs/rfc6265bis.html#section-5.6) a browser **silently drops** any cookie whose `name`+`value` exceeds **4096 octets** — so a bloated access token can make login appear to succeed while the cookie never persists and every following request is anonymous. This only bites with large custom claims via [`Lukk::tokenClaimsUsing`](/customization); keep claims lean and put bulky authorization data behind an API lookup keyed by `sub`. lukk-nuxt emits a `console.warn` as the sealed session nears the limit.

### Direct mode — hardened cookie, in-memory access

- The access token lives **in client memory** (never `localStorage`) and is never written during SSR, so it never lands in the hydration payload.
- The refresh token rides lukk's `__Host-refresh` cookie (`HttpOnly; Secure; SameSite=Strict`), sent automatically only on refresh.
- **Credentials are origin-scoped.** The client attaches the bearer / confirmation header (and cookies) only to a same-origin-as-`baseURL` target, never to an absolute cross-origin URL, and uses `credentials: 'same-origin'`.

> [!WARNING]
> **The access token is reachable by JavaScript in direct mode.** Any script on the page — including injected script under XSS — can read the in-memory token and call the API as the user until it expires. Minimise your XSS surface and set a strict Content-Security-Policy. If you need the browser to hold *no* token at all, use **BFF mode**.

### SSR hydration

In BFF mode the server can hydrate the authenticated `user` during server rendering. The invariants hold: **no token in the payload** (only your app `user` resource is serialized; the access/refresh token never leaves the server), a page embedding a per-user identity is marked `Cache-Control: no-store` so a shared cache can't cross-serve renders, and an anonymous/tampered/expired-seal request **fails safe** as logged-out with no minted cookie and no 500. See [Transport Modes → SSR hydration](/transport-modes#ssr-hydration).

> [!NOTE]
> **Throttling under BFF.** Every user's auth traffic egresses from the BFF server's IP, so lukk's *per-IP* refresh/login throttles collapse onto one address — raise them for a BFF deployment and forward `X-Forwarded-For`. Keep `grace_seconds > 0`: the proxy single-flights refresh, but a zero grace window turns any concurrent refresh into a full-family revocation.

## Standards mapping

| Requirement | Standard |
|---|---|
| Pin the algorithm on decode; reject `alg=none` and mismatches | RFC 8725 |
| Validate `iss`/`aud`/`exp` (required) + `nbf`/`iat` when present; carry `jti` | RFC 7519, 8725 |
| `typ=at+jwt` header | RFC 9068 |
| Access TTL ≤ 15 min | RFC 9700 |
| Refresh-token rotation | OAuth 2.1 §6 |
| Reuse detection → family revoke | RFC 9700 §4.14 |
| Concurrency without false logout (grace window) | fosite / Okta reuse interval |
| Refresh opaque + `sha256` at rest; never logged | RFC 9700 / OWASP |
| Instant revocation (denylist by `fid`/`jti`) | OWASP Session Management |
| Login throttled + constant-time (no user enumeration) | OWASP ASVS |
| Tokens kept out of the browser; sealed `__Host-` cookie | OAuth 2.0 for Browser-Based Apps |
| Token responses non-cacheable (`Cache-Control: no-store, private`) | RFC 6749 §5.1 |
| Reuse/family-revoke emits a security event | RFC 9700 §4.14.2 |

## Security checklist

- [x] Decode always passes an explicit algorithm; `alg=none` and mismatches rejected.
- [x] `iss`/`aud`/`exp`/`nbf` validated on every request; `aud` bound to the API.
- [x] Access TTL ≤ 15 min; header `typ=at+jwt` stamped **and asserted** — a 2FA/step-up challenge token (same key/iss/aud) is rejected as a bearer.
- [x] Refresh tokens opaque, `sha256` at rest, never logged, never JS-readable.
- [x] Invalid/expired/revoked/reused refresh tokens return `401`, not 500, without leaking the reason.
- [x] Rotation on; post-grace replay revokes the whole family.
- [x] Grace window prevents false logout under concurrency.
- [x] Denylist (`fid`/`jti`) kills access within one request; global logout (`DELETE /auth/sessions`) works.
- [x] Login throttled; password check constant-time; unknown user indistinguishable from wrong password.
- [x] HS256 secret ≥ 256-bit random (`php artisan lukk:secret`); v7 enforces the minimum.
- [x] Token responses carry `Cache-Control: no-store, private`.
- [x] Reuse/family-revoke dispatches `Events\RefreshTokenReused`.
- [x] Expired/not-yet-valid tokens, and tokens whose `sub` user was deleted, rejected at the guard.
- [x] BFF: browser holds no token; session cookie `__Host-`, `SameSite=Strict`; proxy `Origin`-checks state-changing requests; upstream `Set-Cookie` and `X-Forwarded-*` stripped; app-API proxy has a fixed SSRF-safe target.
- [x] **(2FA)** Challenge single-use + short TTL; TOTP single-use within its window; account-throttled; recovery codes salted+hashed and single-use; secret encrypted; enroll→confirm before activation; step-up to manage; `amr` reflects `otp`.
- [x] **(Passkeys)** Challenge server-generated, single-use, origin/RP-ID bound; assertion checks UP/UV + signature + pinned algorithms; sign-count regression rejected but `0` never flagged; credential IDs globally unique; public key encrypted at rest; `amr` reflects `webauthn`.

Next: **[Architecture](/architecture)**
