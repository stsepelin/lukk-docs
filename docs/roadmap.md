# Roadmap

Where **lukk** (the Laravel package) and **lukk-js** (the TypeScript/Nuxt client) are headed, and what's already shipped. Nothing here is a commitment or a dated milestone — priorities move with real demand, and everything ships **opt-in and backward-compatible**. Detail for what's built lives in the [CHANGELOG](https://github.com/stsepelin/lukk/blob/main/CHANGELOG.md).

## lukk (Laravel package)

### Planned

Grouped by theme; likely order: change password → abilities/scopes → account deletion → impersonation → personal access tokens.

**Account & identity management** — the remaining [Fortify](https://laravel.com/docs/fortify)-parity flows for a signed-in user.

- **Change password (while authenticated)** — rotate a password without the forgot-password email round-trip. An authenticated `POST /auth/password` that re-verifies the current password (constant-time), validates the new one (`confirmed` + `Password::defaults()`), revokes the user's *other* sessions while keeping the current one, and fires a `PasswordChanged` event. (A profile / email update endpoint is its natural sibling — an email change should re-trigger verification.)
- **Account deletion & GDPR** — the right to erasure (plus data export). A step-up-confirmed `DELETE /auth/account` that re-verifies identity, revokes all sessions, cascades lukk's own auth artifacts (refresh families, passkeys, 2FA secret + recovery codes), and fires `AccountDeleting` / `AccountDeleted` so the app can erase or anonymize *its* domain data (lukk owns only the auth side).

**Authorization in the token**

- **Abilities / scopes** — coarse, **stateless** authorization carried in the access token ("this token may do `orders.read`"), à la [Sanctum](https://laravel.com/docs/sanctum) abilities. A `scope` claim minted per session, an enforcing route middleware (`lukk.ability:orders.read`), and helpers (`$user->tokenCan(...)`). Already possible via `Lukk::tokenClaimsUsing()`; this makes it first-class. Trade-off: a JWT-baked scope is immutable until the token expires (short TTL mitigates; the denylist can hard-kill a family) — and it stays *coarse*, never a substitute for per-object authorization (OWASP API1 BOLA, which is the app's Policies/Gates).

**Delegated & machine access**

- **Personal access tokens** *(needs design)* — long-lived, named, individually-revocable API keys for scripts / CI / machine-to-machine (the one Sanctum use case lukk doesn't cover). Open fork: opaque DB tokens (Sanctum-style, but a *stateful* model in a stateless-JWT package) vs. long-lived scoped JWTs revoked via the denylist (fits the architecture). Depends on abilities/scopes.

**Administration & support**

- **Impersonation ("act as user")** — an admin/support agent safely acting as another user, **audited and reversible**. Policy- + step-up-gated, mints a short-lived, non-refreshable token for the target user carrying an `act` (actor) claim recording the real admin (RFC 8693-style delegation). Composes with [multiple guards](/multiple-guards) — the admin guard impersonates a users-guard subject.

### Shipped

- **JWT session authentication** — short-lived HS256 access tokens + opaque **rotating refresh tokens** with reuse detection, a concurrency grace window, and a cache-backed denylist. Login (constant-time, per-account + per-IP throttled), refresh, logout, logout-all, and revoke-other-sessions.
- **[Multiple guards](/multiple-guards)** — per-guard cryptographic token identity, guard-scoped refresh/revocation/throttling, per-guard routes (path or subdomain), boot-time isolation guardrails.
- **[Registration](/registration)** — `POST /auth/register` mirroring login, fully customizable, with an auto-login toggle.
- **Configurable login identifier** — `lukk.username` (default `email`); login by any unique column.
- **[Two-factor (TOTP)](/two-factor-authentication)** — enrol, confirm, challenge at login, single-use recovery codes (+ remaining count), disable.
- **[Passkeys (WebAuthn)](/passkeys)** — register, passwordless login, list, remove.
- **[Step-up confirmation](/confirmation)** — "sudo" re-auth (password or passkey) gating sensitive routes via `lukk.confirm`.
- **[Email verification](/email-verification)** & **[password reset](/password-reset)** — opt-in, stateless where possible, enumeration-safe.
- **RS256 / ES256 + JWKS with key rotation** — asymmetric signing behind the token contracts, a `kid`-addressed key set, `GET /auth/jwks`, and `lukk:keygen`.
- **BFF & direct transport** — `cookie_mode` for a browser client's `__Host-` refresh cookie, body mode for the sealed-cookie BFF.

## lukk-js (TypeScript / Nuxt client)

### Planned & deferred

- **Laravel Precognition** — real-time, server-driven form validation (`validate()`, `valid`/`invalid`, `validating`) in `useLukkForm`. A sizeable feature; only if there's demand.
- **Upload progress** (`form.progress`) — *blocked by the platform:* `fetch`/`ofetch` can't stream request-upload progress in the browser (Inertia uses XHR). Would mean abandoning the `useLukkFetch` transport for uploads. Unlikely.
- **More framework bindings** — `lukk-react` and friends on the framework-agnostic `lukk-core`. The monorepo is structured for it.
- **MCP server** — a Model Context Protocol server for live doc search / setup scaffolding. Deferred — `llms.txt` already covers most of the value without the hosting/upkeep.

### Shipped

- **`lukk-core`** — a framework-agnostic auth client (`createLukkClient` hooks seam), WebAuthn helpers, and the full contract types (zero runtime deps).
- **`lukk-nuxt`** — a Nuxt 3/4 module with **BFF** (sealed-cookie proxy) and **direct** transport modes behind one composable API.
- **Composables** — `useLukkAuth` (login + 2FA challenge + register + logout + sessions + restore + user), `useLukkTwoFactor`, `useLukkConfirmation`, `useLukkPasskeys`, `useLukkEmailVerification`, `useLukkPasswordReset`, `useLukkFetch` (an auth-aware `$fetch`), and `useLukkForm` (Inertia-`useForm`-parity with nested errors + `rememberKey`).
- **Route middleware** — `lukk-auth`, `lukk-guest`, `lukk-verified`, `lukk-confirmed`.
- **Typed identifier** — the `LukkIdentifier` union (`{ email } | { username }`) so `login()` / `register()` take the configured identifier with type safety.
- **User shaping** — an augmentable `LukkUser` contract with automatic `{ data }`-wrapper unwrapping.
- **SSR hydration** — the BFF hydrates the session on the server so a first paint is authenticated, without leaking the access token into the payload.

## Contributing

Have a use case that needs one of the planned items — or something not listed? Open an issue on [lukk](https://github.com/stsepelin/lukk/issues) (server) or [lukk-js](https://github.com/stsepelin/lukk-js/issues) (client). Real demand is what moves things up this list.
