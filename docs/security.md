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
- **A password change or reset shuts out a sign-in that was already in flight.** A change or reset writes the new hash, then revokes the account's sessions; a sign-in starts its session, then re-reads the password, and takes the session back if it changed since the check. Each side commits before it reads, so one sees the other — a sign-in that checked the *old* password does not keep a session past a reset meant to recover the account (lukk 0.7.0). A [two-factor challenge](/two-factor-authentication) carries a fingerprint of the password it stands in for and is refused once that password changes. It holds while:
  - **the re-read is authoritative** — lukk reads an Eloquent provider's user from the primary connection; a custom `UserProvider` must not answer `retrieveById` from a read replica or a cache;
  - **no database transaction wraps the login, change-password or reset requests** — a transaction-per-request middleware on those routes reopens the race;
  - **`APP_KEY` rotations use `APP_PREVIOUS_KEYS`**, or two-factor challenges in flight at the moment of rotation are refused (the user signs in again); deployments redeeming each other's challenges must share `APP_KEY` as well as the signing secret.

  With [`Lukk::authenticateUsing`](/customization), lukk did not read the password itself, so it compares against the stored password read right after your callback returns.
- **Non-cacheable token responses.** Token responses carry `Cache-Control: no-store, private` so a shared cache/CDN never stores them.
- **Fail-safe error codes.** Invalid, expired, revoked, reused and unclaimed refresh tokens all return `401`, not 500, without leaking which of those it was. Expired or not-yet-valid access tokens — and tokens whose `sub` user was deleted — are rejected at the guard.
- **Logout ends the session with either credential the client holds.** From lukk 0.7.0 `POST /auth/logout` is no longer behind `auth:{guard}`: a valid access token *or* the client's refresh token ends the session, so the most ordinary client state there is — an idle tab whose 15-minute access token has lapsed — can still log out instead of getting a `401` and leaving a refresh cookie valid for its whole TTL (RFC 7009 §2.1–2.2, ASVS 5.0 V7.4.1). An **expired** access token alone ends nothing, whatever its signature: honouring one would make every token that ever reached a log or a crash report a durable capability to end that session. The refresh cookie is honoured — and cleared — only on a request shape a cross-site form cannot produce: `Content-Type: application/json` (not CORS-safelisted, so a cross-origin page must pass a preflight your CORS policy governs, and matched on the MIME essence so `text/plain; x=/json` doesn't slip through), or `Sec-Fetch-Site: same-origin`/`none`. Not `same-site` — that is the sibling-subdomain attacker, whom `SameSite=Strict` does not stop. A throttled refresh-token lookup answers `429` with `Retry-After` and leaves the cookie in place, because the session is still live and the client must retry.

## Transport hardening (client)

Where the tokens physically live is a [transport-mode](/transport-modes) choice, and each mode has its own containment.

### BFF mode — nothing in the browser

- **No token in `localStorage`, ever.** BFF keeps every session token — access, refresh, **and** the step-up confirmation token — server-side in a sealed, encrypted cookie, so XSS can't exfiltrate one. Two things qualify "the browser holds only the opaque session cookie". There are also two short-lived cookies that drive a [logout](/authentication#logging-out-1) (`__Host-lukk-logout`, one minute; `__Host-lukk-signed-out`, ten seconds). Neither is a credential: their *presence* is what the server acts on. The first carries one value — the moment the logout was asked for, which the page that finishes the note needs and cannot otherwise know; without it that page used its own load time, and a sign-in already on the wire could never count as having happened since. Both are readable by JavaScript because the page writes and reads them itself. And the **two-factor login challenge token** is held client-side in both modes: it is issued before any session exists, so there is nothing server-side to seal it into and the browser has to present it back. It is short-lived, single-use, account-throttled, and never written into the SSR payload.
- **Credential stripping.** The proxy replaces a token- or confirmation-bearing response body with `{ ok: true }` (plus `expires_in` where the client needs it) before it reaches the browser, and separately strips those three keys from any body passing through — into arrays and nested objects, to a depth of 4, and strips every upstream `Set-Cookie` (except names you opt into with [`api.forwardSetCookie`](/configuration#api), which defaults to none and can never carry a lukk session name) (re-emitting only lukk's sealed session cookie).
- **CSRF containment.** Moving tokens server-side trades XSS-exfiltration risk for CSRF risk, closed two ways: the session cookie is `__Host-lukk-session` (`SameSite=Strict; Secure; HttpOnly; Path=/`, no `Domain` — the `__Host-` prefix the browser enforces), **and** the proxy rejects a state-changing request whose `Origin` doesn't match the app's own host (`403`). A request carrying **no** `Origin` is not refused on that test alone — it has already had to pass the `Sec-Fetch-Site` check, which refuses `cross-site` *and* `same-site`, and the session cookie is `SameSite=Strict`. CSRF is enforced by origin, not a token, so Laravel's token-based CSRF (`419`) doesn't apply.
- **SSRF containment.** The proxied subpath is contained to lukk's base URL (no traversal); the app-API proxy forwards to a **fixed** `target`. Both strip the inbound cookie/authorization and the browser-spoofable forwarding headers on a fixed deny-list (`x-forwarded-host`, `-proto`, `-port`, the path/scheme family `x-forwarded-prefix`/`-scheme`/`-ssl`/`-uri`/`x-original-url`/`x-rewrite-url`, and the rest of `SPOOFABLE_FORWARDING` in `runtime/shared.ts`; `x-forwarded-for` is re-stamped from the socket rather than dropped) (stamping a trusted client IP so Laravel's per-IP throttling/logging can't be poisoned) and mark responses non-cacheable.

> [!WARNING]
> **Keep the sealed session under ~4 KB.** The `__Host-lukk-session` cookie holds the access JWT plus the refresh and confirmation tokens and a session id, iron-sealed (~1.34× inflation on top of a fixed envelope). Per [RFC 6265bis §5.6](https://httpwg.org/specs/rfc6265bis.html#section-5.6) a browser **silently drops** any cookie whose `name`+`value` exceeds **4096 octets** — so a bloated access token can make login appear to succeed while the cookie never persists and every following request is anonymous. This only bites with large custom claims via [`Lukk::tokenClaimsUsing`](/customization); keep claims lean and put bulky authorization data behind an API lookup keyed by `sub`. lukk-nuxt emits a `console.warn` as the sealed session nears the limit.

### Direct mode — hardened cookie, in-memory access

- The access token lives **in client memory** (never `localStorage`) and is never written during SSR, so it never lands in the hydration payload.
- The refresh token rides lukk's `__Host-refresh` cookie (`HttpOnly; Secure; SameSite=Strict`), sent automatically only on refresh.
- **Web storage holds no credential, but it isn't empty.** lukk-js writes `lukk:logging-out:<app.baseURL>[#<session.name>]` (`sessionStorage`, one minute) and `lukk:signed-in-at:<app.baseURL>[#<session.name>]` (`localStorage`) so the page load after a logout can finish it. Both hold bookkeeping only — a timestamp and, when known, the session's refresh-token family id, which is not a credential and cannot be exchanged for anything. Clearing `localStorage` on logout can make the next page load end a *newer* session; see [Transport Modes → Direct](/transport-modes#direct-mode).
- **Credentials are origin-scoped.** The client attaches the bearer / confirmation header (and cookies) only to a same-origin-as-`baseURL` target, never to an absolute cross-origin URL, and uses `credentials: 'same-origin'`.

> [!WARNING]
> **The access token is reachable by JavaScript in direct mode.** Any script on the page — including injected script under XSS — can read the in-memory token and call the API as the user until it expires. Minimise your XSS surface and set a strict Content-Security-Policy. If you need the browser to hold *no* token at all, use **BFF mode**.

### SSR hydration

In BFF mode the server can hydrate the authenticated `user` during server rendering. The invariants hold: **no token in the payload** (only your app `user` resource is serialized; the access/refresh token never leaves the server), a page embedding a per-user identity is marked `Cache-Control: no-store` so a shared cache can't cross-serve renders, and an anonymous/tampered/expired-seal request **fails safe** as logged-out with no minted cookie and no 500. See [Transport Modes → SSR hydration](/transport-modes#ssr-hydration).

> [!NOTE]
> **Throttling under BFF.** Every user's auth traffic egresses from the BFF server's IP, so lukk's *per-IP* refresh/login throttles collapse onto one address — including the [logout refresh-token lookup](/configuration#throttles-without-a-key-of-their-own), which the proxy's own background revokes of replaced sessions spend as well. (The claim route keys on the authenticated user and is unaffected.) Forward the real client with [`clientIpHeader`](/configuration#clientipheader) (and restore any limits you had raised to compensate — inflated limits become a per-attacker budget once forwarding works). Keep `grace_seconds > 0`: the proxy single-flights refresh, but a zero grace window turns any concurrent refresh into a full-family revocation.

## Standards mapping

| Requirement | Standard |
|---|---|
| Pin the algorithm on decode; reject `alg=none` and mismatches | RFC 8725 |
| Validate `iss`/`aud`/`exp` (required) + `nbf`/`iat` when present; carry `jti` | RFC 7519, 8725 |
| `typ=at+jwt` header | RFC 9068 |
| Access TTL ≤ 15 min | RFC 9700 |
| Refresh-token rotation | OAuth 2.1 §6 |
| Reuse detection → family revoke | RFC 9700 §4.14 |
| Concurrency without false logout (grace window) — a [deliberate deviation](/tokens-and-rotation#a-deliberate-deviation-from-the-spec) | fosite / Okta reuse interval |
| Refresh opaque + `sha256` at rest; never logged | RFC 9700 / OWASP |
| Instant revocation (denylist by `fid`/`jti`) | OWASP Session Management |
| Login throttled + constant-time (no user enumeration) | OWASP ASVS |
| Consecutive failed attempts on one account capped (**opt-in**) | NIST SP 800-63B §5.2.2, ASVS V2.2.1 |
| Tokens kept out of the browser; sealed `__Host-` cookie | OAuth 2.0 for Browser-Based Apps |
| Token responses non-cacheable (`Cache-Control: no-store, private`) | RFC 6749 §5.1 |
| Reuse/family-revoke emits a security event | RFC 9700 §4.14.2 |

## Known limitations

Five behaviours are accepted trade-offs rather than gaps. All are bounded, and all are here so you can weigh them yourself rather than discover them.

**The rotation grace window departs from RFC 9700 §4.14.2.** A refresh token replayed *within* `grace_seconds` of a legitimate refresh yields a sibling instead of a family revoke, so a thief winning that race gets a parallel chain that reuse detection won't catch. The alternative — strict invalidate-on-replay — logs out any client with two tabs open. See [the full reasoning](/tokens-and-rotation#a-deliberate-deviation-from-the-spec); [`RefreshFamilyForked`](/events) makes the fork visible.

**An erased identifier survives briefly as a rate-limiter cache key.** [Erasure](/account-deletion) sweeps every durable artifact — including the [lockout](/account-lockout) counters, which are keyed by identifier rather than by user id — but the *decaying* login throttle buckets live in the cache under keys derived from the identifier itself (`acct|<guard>|<identifier>`, and an identifier↔address pair). Those keys expire on their own within [`rate_limits.login.decay_seconds`](/configuration#rate-limits), so the residue is self-clearing and short. lukk does not sweep them: the per-address bucket cannot be reconstructed after the fact (the addresses aren't known), so a partial sweep would clear the tidy half and leave the other, while implying completeness. If your retention posture can't accept a bounded window here, shorten `decay_seconds` or point [`denylist_store`](/configuration#denylist) at a store you flush on erasure.

**Look-alike identifiers share a rate-limit bucket.** The decaying login throttle keys on the identifier normalized (trimmed, lowercased, transliterated), which is many-to-one across distinct accounts — `аdmin@example.com` with a Cyrillic а folds onto `admin@example.com`. Two such accounts can therefore throttle each other for `decay_seconds`. This does **not** affect the [account lockout](/account-lockout), which keys on the resolved user id and so satisfies NIST SP 800-63B §5.2.2's "single account" scoping literally. Keying the throttle the same way would put a user lookup in front of every login attempt, including unauthenticated floods — a worse trade than the one it closes.

**The logout lookup budget is itself a side channel, and anyone sharing your address can spend it.** `POST /auth/logout` has no authenticated identity to meter by, so the [refresh-token lookup](/configuration#throttles-without-a-key-of-their-own) is bucketed by caller address, and only unproductive lookups — a miss, or a family already revoked — are counted. Two consequences, both accepted rather than engineered away:

*It leaks one bit per budget.* Spend `max_attempts − 1` misses, present a candidate token, then one known miss: a `204` means the candidate resolved to a live family, a `429` means it did not. That is a whole bucket (30 requests by default) per bit about a 256-bit random token, which is why the cost is judged acceptable; the alternative is either not metering the lookup at all, or answering something other than the truth about the throttle. A burst racing past the pre-check can also overshoot the limit by its own concurrency before the counts land.

*It is exhaustible by a neighbour.* Junk misses from one client behind a NAT, a carrier, or a proxy that doesn't forward the real address spend the bucket for everyone behind it, and their cookie-only logouts answer `429` until it decays. Nobody is logged out wrongly and everyone can retry — a `429` leaves the refresh cookie in place — but the refusal is real. Behind a BFF, set [`clientIpHeader`](/configuration#clientipheader); the same forwarding that fixes the login and refresh buckets fixes this one.

**An unfinished logout can expire before anything finishes it.** When `logout()` can't complete — the page navigated away, lukk is unreachable — lukk-js leaves a note (a one-minute cookie in BFF mode, a one-minute `sessionStorage` entry in direct mode) and the next page load ends the session from it. In BFF mode that page renews the note's minute (carrying forward the moment the logout was asked for, never re-stamping it). Direct mode does not renew: its note's minute runs from the moment `logout()` was called, whether or not it names a session. The visitor reads as signed out either way, locally and on every render. But if lukk stays unreachable, the browser's own retry never lands, and no page load happens inside that minute, the note expires and the session stays live on lukk until its refresh token does. The alternative — a note with no expiry — means a stale note ending a session signed into days later, which is a worse failure. If the window matters for your threat model, shorten `refresh_ttl`, and use `DELETE /auth/sessions` for the "sign me out everywhere, now" case, which is a single authenticated request with no note involved.

**A logout that stands down still resolves successfully.** A `logout()` whose work outlives the page leaves a note, and the page load that finds it stands down instead of sending, if there is positive evidence of a sign-in on this app *since that logout was asked for* — the tab signed in again, or another tab did. Standing down is the right answer (the session the note was for is gone, and sending would end the newer one), but the original `logout()` call had already resolved without throwing, so a `.then()` that shows "signed out" was right about the old session and says nothing about the new one. Read the reactive state (`loggedIn`, `user`), not the promise, if what you want to show is whether *this browser* is signed in now.

**A sign-in that arrives with no session cookie can be read as signed out, once.** In BFF mode a sign-in records that it replaced the session it arrived with — which is how an in-flight request that is still finishing an older logout knows not to answer "signed out" to a browser that has since signed in again. A sign-in whose request carries *no* session cookie (the logout that preceded it had already cleared it) has nothing to record: the old session's key is not in that request, and the server has no other way to name it. A page load still in flight for the old session can therefore set the ten-second signed-out marker on a browser that now holds a new one, and that one page renders signed out. The session cookie itself is untouched, the visitor's other tabs correct it through the cross-tab channel, and the next load is normal. Fixing it would need a per-browser identifier that outlives the cookie, which is the thing the design deliberately does not keep.

**Your password hasher may silently truncate.** Laravel's default bcrypt driver ignores everything past the 72th byte, so `('a' × 72) . 'anything'` authenticates a user registered with `('a' × 72) . 'something-else'`. lukk validates `max:255` on every password field and imposes no composition rules of its own, but the hashing is your application's — NIST SP 800-63B §5.1.1.2 says a verifier SHALL NOT truncate, and argon2id has no such limit. Set `HASH_DRIVER=argon2id` if long passphrases matter to you.

**No per-session listing or revoke.** You can end the current session (`POST /auth/logout`), every session (`DELETE /auth/sessions`) and every *other* session (`DELETE /auth/sessions/others`) — but there is no "here are your five devices, sign out the third" surface. The data exists (`RefreshTokenRepository::allForUser`), and `GET /auth/account/export` returns it for the GDPR path, but nothing revokes one session by id. If you need that, build it on the repository.

## Security checklist

- [x] Decode always passes an explicit algorithm; `alg=none` and mismatches rejected.
- [x] `iss`/`aud`/`exp`/`nbf` validated on every request; `aud` bound to the API.
- [x] Access TTL ≤ 15 min; header `typ=at+jwt` stamped **and asserted** — a 2FA/step-up challenge token (same key/iss/aud) is rejected as a bearer.
- [x] Refresh tokens opaque, `sha256` at rest, never logged, never JS-readable.
- [x] Invalid/expired/revoked/reused/unclaimed refresh tokens return `401`, not 500, without leaking the reason.
- [x] Rotation on; post-grace replay revokes the whole family.
- [x] Logout works without a valid access token: a live refresh token ends the session, an **expired** access token alone ends nothing, and the refresh cookie is honoured and cleared only on a request shape a cross-site form can't produce (`Content-Type: application/json`, or `Sec-Fetch-Site: same-origin`/`none` — never `same-site`). A throttled lookup answers `429` and leaves the cookie for the retry.
- [x] Grace window prevents false logout under concurrency.
- [x] Denylist (`fid`/`jti`) kills access within one request; global logout (`DELETE /auth/sessions`) works.
- [x] Login throttled; password check constant-time; unknown user indistinguishable from wrong password.
- [x] A sign-in checked against a password that is changed or reset before its session exists keeps no session — on the password path and on the two-factor path.
- [x] Step-up confirmation throttled per user **and** per IP, so a stolen access token can't brute-force the password behind the sudo gate.
- [ ] **(Optional)** [Account lockout](/account-lockout) enabled if you must meet NIST SP 800-63B §5.2.2 — the throttles bound a *rate*, not a run of consecutive failures. Off by default: a hard lockout is a denial-of-service primitive, so set `release_after` to bound the denial.
- [x] HS256 secret ≥ 256-bit random (`php artisan lukk:secret`); v7 enforces the minimum.
- [x] Token responses carry `Cache-Control: no-store, private`.
- [x] Reuse/family-revoke dispatches `Events\RefreshTokenReused`.
- [x] Expired/not-yet-valid tokens, and tokens whose `sub` user was deleted, rejected at the guard.
- [x] BFF: browser holds no token; session cookie `__Host-`, `SameSite=Strict`; proxy `Origin`-checks state-changing requests; upstream `Set-Cookie` and `X-Forwarded-*` stripped; app-API proxy has a fixed SSRF-safe target.
- [x] **(2FA)** Challenge single-use + short TTL; TOTP single-use within its window; account-throttled; recovery codes salted+hashed and single-use; secret encrypted; enroll→confirm before activation; step-up to manage; `amr` reflects `otp`.
- [x] **(Passkeys)** Challenge server-generated, single-use, origin/RP-ID bound; assertion checks UP/UV + signature + pinned algorithms; sign-count regression rejected but `0` never flagged; credential IDs globally unique; public key encrypted at rest; `amr` reflects `webauthn`.

Next: **[Architecture](/architecture)**
