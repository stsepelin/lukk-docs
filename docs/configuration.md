# Configuration

The full configuration reference for both halves. The server is configured in `config/lukk.php` (published, env-driven); the client under the `lukk` key in `nuxt.config.ts`. Deep topics — asymmetric keys, transport modes, local-dev cookies — get the key here and a link to their dedicated page.

## Server (Laravel)

After publishing the config with `php artisan vendor:publish --tag=lukk-config`, all options live in `config/lukk.php`. Every option has a default, and most are driven by environment variables so you can tune them per environment without editing the file.

### Signing

```php
'algorithm' => env('LUKK_ALGORITHM', 'HS256'),
'secret' => env('LUKK_SECRET'),
```

| Key | Default | Description |
|---|---|---|
| `algorithm` | `HS256` | The JWS algorithm. Keep `HS256` while this app is the sole verifier of its own tokens; switch to `RS256`/`ES256` only when an independent service must verify them. |
| `secret` | `env('LUKK_SECRET')` | The 256-bit HS256 signing key. Generate it with [`php artisan lukk:secret`](/installation#generate-the-signing-secret). Unused under an asymmetric algorithm. |

#### Asymmetric keys (RS256 / ES256)

Used only when `algorithm` is asymmetric. Generate a keypair with `php artisan lukk:keygen` (add `--algorithm=ES256` for EC), which populates a `keys` block (`active` kid, `private`, `passphrase`, `public` kid→key map). Under an asymmetric algorithm, `GET {path}/jwks` publishes the public keys as a JWK Set (RFC 7517). See [Deployment → Asymmetric keys](/deployment) for the full block, key-rotation procedure, and the JWKS endpoint.

### Issuer & audience

```dotenv
LUKK_ISSUER=https://api.example.com
LUKK_AUDIENCE=https://api.example.com
```

The `iss` and `aud` claims stamped into every token and validated on every request. Set both to your API's URL.

`LUKK_AUDIENCE` is **comma-separated**. To mint tokens for **several services**, list them all — `LUKK_AUDIENCE=https://api.example.com,https://billing.example.com`. The token then lists both, and each service accepts it when its own audience is in the list. A single audience is stamped as a plain string. See [Deployment](/deployment).

### Token lifetimes

```php
'access_ttl' => (int) env('LUKK_ACCESS_TTL', 900),       // 15 minutes
'refresh_ttl' => (int) env('LUKK_REFRESH_TTL', 2592000), // 30 days
```

| Key | Default | Description |
|---|---|---|
| `access_ttl` | `900` (15 min) | Access-token lifetime, in seconds. Keep it short — revocation latency is bounded by this value. |
| `refresh_ttl` | `2592000` (30 days) | The **absolute** session lifetime, in seconds. It is set at login and inherited by every rotation — it does **not** slide, so a session ends `refresh_ttl` after login regardless of activity, and the user must log in again. |

### Refresh behavior

```php
'grace_seconds' => (int) env('LUKK_GRACE', 30),
'leeway' => (int) env('LUKK_LEEWAY', 5),
```

| Key | Default | Description |
|---|---|---|
| `grace_seconds` | `30` | The overlap window during which a just-rotated token is still tolerated, so concurrent refreshes (multiple tabs, SSR + hydration) do not trip reuse detection. Within this window the old token yields a fresh access token only — see [Authentication → Refreshing tokens](/authentication#refreshing-tokens). |
| `leeway` | `5` | Clock-skew tolerance, in seconds, applied when validating the `exp` and `nbf` claims. |

### Rate limits

Every throttle lives here, each shaped as `{ max_attempts, decay_seconds }` (login adds `ip_max_attempts` and `account_max_attempts`), plus one scalar — `ipv6_prefix` — that applies to them all:

```php
'rate_limits' => [
    'ipv6_prefix' => 64,
    'login' => ['max_attempts' => 5, 'decay_seconds' => 60, 'ip_max_attempts' => 30],
    'two_factor' => ['max_attempts' => 5, 'decay_seconds' => 60],
    'refresh' => ['max_attempts' => 30, 'decay_seconds' => 60],
    'passkeys' => ['max_attempts' => 30, 'decay_seconds' => 60],
],
```

| Limit | Default | Keyed on | Notes |
|---|---|---|---|
| `login` | 5 / 60s (+ `ip_max_attempts` 30) | normalized email + IP | Failures-only: only failed attempts count, a success clears the counter; lockout returns a `429` validation error. **`ip_max_attempts`** (env `LUKK_LOGIN_IP_MAX_ATTEMPTS`) is a separate coarse per-IP cap on *all* login attempts, bounding password-spraying across many emails. |
| `two_factor` | 5 / 60s | account (`sub`) | Throttles challenge-code guesses for a single account. Also guards the endpoint per IP. |
| `refresh` | 30 / 60s | IP | Per-IP guard on `POST /auth/refresh`. |
| `passkeys` | 30 / 60s | IP | Per-IP guard on the passkey login + assertion-options endpoints. |

Each maps to a named limiter (`lukk-refresh`, `lukk-passkeys`, `lukk-2fa`) you can also override with your own `RateLimiter::for()`. Tune any of them with the matching env vars — `LUKK_REFRESH_MAX_ATTEMPTS`, `LUKK_2FA_DECAY`, and so on.

**What "keyed on IP" actually means.** Every throttle buckets on `Lukk::rateLimitKey()`, which is the caller's address with IPv6 collapsed to **`ipv6_prefix`** (default `/64`, env `LUKK_RATE_LIMIT_IPV6_PREFIX`). A subscriber is typically handed a whole `/64`, so keying on the full address would let one visitor mint effectively unlimited buckets and walk through every per-IP limit. IPv4 is used as-is, and addresses that embed IPv4 (IPv4-mapped, NAT64's `64:ff9b::/96`) are unwrapped rather than masked — otherwise a whole translated client population would share one counter. Raise it toward `128` if your users share a `/64` (an office or campus LAN does); lower it if your attackers hold larger delegations.

Behind a BFF or reverse proxy that address is the **proxy** until the deployment forwards the real client — see [`clientIpHeader`](#clientipheader). Replace the identity entirely when the source address isn't the right bucket for you (a shared API gateway, a tenant, a CDN's own visitor token):

```php
// A service provider's boot()
Lukk::rateLimitKeyUsing(fn (Request $request) => 'tenant-'.$request->user()?->tenant_id);
```

The value must be something the caller cannot forge — it also buckets the login limiter, so a spoofable header would let an attacker mint a fresh bucket per request. It is used verbatim as part of a cache key, so namespace anything untrusted. Returning an empty value falls back to the address rather than silently putting every caller in one bucket.

### Denylist

```php
'denylist_store' => env('LUKK_DENYLIST_STORE'),
```

The cache store backing the revocation denylist. `null` uses your application's default cache store. The denylist is self-evicting (entries expire with the tokens they revoke), so any cache driver works — Redis is recommended in production. Use a store that **throws** when unreachable (Redis, database): a denylist read error then propagates and access-token verification **fails closed** (rejects), rather than silently treating a revoked token as valid. Avoid a store that swallows connection errors into a `null`/miss.

> [!IMPORTANT]
> Across **multiple nodes** this must be a **shared, persistent** store (e.g. Redis) — not the `array` driver and not a per-node cache. The same store also backs the TOTP replay cache and the passkey/2FA throttles; if it isn't shared, a revoked token can still be honored on another node and replay protection isn't authoritative.

### Output mode

```php
'cookie_mode' => (bool) env('LUKK_COOKIE_MODE', false),

'cookie' => [
    'refresh_name' => '__Host-refresh',
    'secure' => (bool) env('LUKK_COOKIE_SECURE', true),
],
```

| Mode | Behavior |
|---|---|
| `false` (default) | **BFF mode.** Both tokens are returned in the JSON body, for a server-side client (such as a Nuxt BFF) that seals them itself. |
| `true` | **Direct browser mode.** The refresh token is set in a `__Host-refresh` cookie (HttpOnly, Secure, `Path=/`, no `Domain`); only the access token and its expiry are in the body. |

`cookie.secure` (env `LUKK_COOKIE_SECURE`, default `true`) controls the refresh cookie's `Secure` attribute. **Keep it `true` in production** — the refresh token must never travel over plain http. Set it to `false` **only for local development over http**; lukk then also strips the `__Host-` prefix, which requires `Secure`. Never ship `secure=false` — see [Local Development](/local-development).

See [Authentication → Output modes](/authentication#output-modes) for the full response shapes, and [Transport Modes](/transport-modes) for which client mode pairs with each (BFF ↔ body mode, direct ↔ cookie mode).

### Guard & provider

```php
'guard' => 'api',
'user_provider' => 'users',
```

| Key | Default | Description |
|---|---|---|
| `guard` | `api` | The auth guard your app maps to the `lukk-jwt` driver. Used by the package's route middleware. |
| `user_provider` | `users` | The `config/auth.php` user provider used to resolve and validate credentials during login. |

### Routes

```php
'routes' => true,
'path' => 'auth',
```

| Key | Default | Description |
|---|---|---|
| `routes` | `true` | Whether to register the package's built-in routes. Set to `false` to define your own. |
| `path` | `auth` | The URI prefix the routes are mounted under (e.g. `/auth/login`). |

### Feature toggles

```php
'features' => [
    'rotation' => true,
    'reuse_detection' => true,
    'denylist' => true,
    'logout_all' => true,
    'two_factor' => false,
    'passkeys' => false,
],
```

| Feature | Default | Description |
|---|---|---|
| `rotation` | `true` | Rotate the refresh token on every refresh. |
| `reuse_detection` | `true` | Revoke the whole family when a consumed token is replayed. |
| `denylist` | `true` | Honor the cache-backed revocation denylist. |
| `logout_all` | `true` | Enable the "revoke every session" path. |
| `two_factor` | `false` | Enable [two-factor authentication](/two-factor-authentication). Requires `pragmarx/google2fa`. |
| `passkeys` | `false` | Enable [passkeys](/passkeys). Requires a WebAuthn library. |

> [!WARNING]
> The rotation, reuse-detection, and denylist features are the security core of the package. Disable them only if you fully understand the consequence.

### Two-factor

Used only when `features.two_factor` is enabled. See [Two-Factor Authentication](/two-factor-authentication).

```php
'two_factor' => [
    'issuer' => env('LUKK_2FA_ISSUER'),
    'window' => (int) env('LUKK_2FA_WINDOW', 1),
    'recovery_codes' => (int) env('LUKK_2FA_RECOVERY_CODES', 8),
    'challenge_ttl' => (int) env('LUKK_2FA_CHALLENGE_TTL', 300),
],
```

| Key | Default | Description |
|---|---|---|
| `issuer` | `config('app.name')` | The label shown in the authenticator app. |
| `window` | `1` | Accepted clock drift, in 30-second steps (±1). Do not widen this — it multiplies brute-force odds. |
| `recovery_codes` | `8` | How many recovery codes are generated. |
| `challenge_ttl` | `300` (5 min) | How long a login challenge token is valid. |

### Confirmation

Settings for [step-up confirmation](/confirmation).

```php
'confirm' => [
    'ttl' => (int) env('LUKK_CONFIRM_TTL', 300),
    'header' => env('LUKK_CONFIRM_HEADER', 'X-Lukk-Confirmation'),
],
```

| Key | Default | Description |
|---|---|---|
| `ttl` | `300` (5 min) | How long a confirmation ("sudo") proof remains valid. |
| `header` | `X-Lukk-Confirmation` | The request header that carries the confirmation token. Must match the client's [`confirmationHeader`](#confirmationheader). |

### Passkeys

Used only when `features.passkeys` is enabled. See [Passkeys](/passkeys).

```php
'passkeys' => [
    'rp_name' => env('LUKK_PASSKEY_RP_NAME'),
    'rp_id' => env('LUKK_PASSKEY_RP_ID'),
    'origins' => array_values(array_filter(array_map('trim', explode(',', (string) env('LUKK_PASSKEY_ORIGINS', ''))))),
    'challenge_ttl' => (int) env('LUKK_PASSKEY_CHALLENGE_TTL', 120),
    'user_verification' => env('LUKK_PASSKEY_UV', 'required'),
],
```

| Key | Default | Description |
|---|---|---|
| `rp_name` | `config('app.name')` | The relying-party name shown in the OS passkey prompt. |
| `rp_id` | **required** | The registrable domain shared by your front-end and API — e.g. `example.com`, **not** `api.example.com`. Throws if unset when passkeys are enabled. |
| `origins` | **required** | Allowed browser origins (your front-end), as a comma-separated `LUKK_PASSKEY_ORIGINS` value. An empty list is rejected. |
| `challenge_ttl` | `120` (2 min) | How long a WebAuthn challenge is valid. |
| `user_verification` | `required` | Whether the authenticator must verify the user (biometric/PIN), not just their presence. Default `required` makes passwordless login + step-up phishing-resistant (AAL2). Lower to `preferred` only for authenticators that can't verify the user. One of `required`, `preferred`, `discouraged`. |

## Client (Nuxt)

Everything is configured under the `lukk` key in `nuxt.config.ts`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `baseURL` | `string` | `''` | Your lukk auth URL, including the route prefix. |
| `mode` | `'bff' \| 'direct'` | `'bff'` | Transport mode — see [Transport Modes](/transport-modes). |
| `ssrHydrate` | `bool` | `true` | BFF-only — hydrate `user`/`loggedIn` during SSR (no flash). |
| `user.endpoint` | `string` | `''` | Your app's authenticated user route (per-mode). |
| `api.path` / `api.target` / `api.forceJson` / `api.forwardSetCookie` | `string` / `string` / `bool` / `string[]` | `''` / `''` / `true` / `[]` | BFF-only app-API proxy. |
| `session.password` | `string` | env | BFF sealed-session secret (≥ 32 chars). |
| `session.cookieSecure` | `bool` | auto | BFF session cookie `Secure`/`__Host-` — see [Local Development](/local-development). |
| `session.name` | `string` | — | BFF session-cookie namespace, so co-hosted apps don't collide. |
| `confirmationHeader` | `string` | `'X-Lukk-Confirmation'` | Header carrying the step-up token. |
| `clientIpHeader` | `string` | `''` | BFF-only, opt-in — forward the real visitor IP upstream. |
| `storage` | `string` | `'cookie'` | BFF token storage backend. |

```ts
export default defineNuxtConfig({
  modules: ['lukk-nuxt'],
  lukk: {
    baseURL: 'https://api.example.com/auth',
    mode: 'bff',
    user: { endpoint: '/api/me' },
    confirmationHeader: 'X-Lukk-Confirmation',
    storage: 'cookie',
  },
})
```

### `baseURL`

The fully-qualified URL of your lukk auth routes, including lukk's route prefix (`lukk.path`, default `auth`):

```ts
baseURL: 'https://api.example.com/auth'
```

In `bff` mode this is read **only on the server** and is never shipped to the browser. In `direct` mode it is part of the public runtime config, because the browser calls lukk directly — so it must be reachable from the browser and [CORS-configured on lukk](/transport-modes).

**It is validated at build time.** A `baseURL` that isn't a valid absolute URL fails `nuxt build` / `nuxt prepare` with the offending value in the message, rather than building an app that answers `400` on every auth call. The check requires an `http://` or `https://` scheme — note that `localhost:3000/auth` is *parseable* (as a `localhost:` scheme) but is not a usable base, so it's rejected too.

> [!WARNING]
> The fault this catches is an **unset build-time environment variable**. A config like `` baseURL: `${process.env.API_URL}/auth` `` interpolates an undefined variable into the string `"undefined/auth"` — non-empty, so it used to build fine and then fail at runtime. Make sure the variable is present wherever you run `nuxt build` **and** `nuxt prepare` (including CI postinstall steps).

In `direct` mode a **root-relative** base (`/auth`) is also accepted: the browser resolves it against the current origin, which is the right setup when lukk is served from the same origin as your app. A server-fetched base (`bff` mode) has no valid relative form.

> [!CAUTION]
> A root-relative base is **browser-only**. Node has no page to resolve it against, so calling lukk during SSR with it — e.g. `useAsyncData(() => useLukkAuth().fetchUser())` — fails to parse the URL. lukk itself never fetches this base on the server, so ordinary use is fine; just don't drive lukk calls from server-rendered data fetching. Use an absolute URL if you need that.

> [!NOTE]
> If `baseURL` is empty the module logs a warning at build time — "not configured yet" is treated differently from "configured wrong". It is the one option you always set.

A base carrying a **query or fragment** (`https://api.example.com/auth?tenant=1`) is rejected as well: the request path is appended *after* it, so `/login` would resolve to `/auth?tenant=1/login` — every route would silently hit the same upstream endpoint, including `/logout`.

There is also a build-time **warning** (not an error, because only you can tell it apart from a deliberate setup) when a **production build points at loopback** (`http://localhost:…`, `127.0.0.1`) — legitimate when you're testing a production build locally, but also exactly what a dev `.env` leaking into a real deploy looks like.

> [!TIP]
> If you **build once and deploy to many environments**, don't bake a template string into `baseURL`. Leave it empty (that only warns) and supply the override for your mode at runtime: `NUXT_LUKK_BASE_URL` in `bff` mode, or `NUXT_PUBLIC_LUKK_BASE_URL` in `direct` mode — the browser reads the *public* copy, so the private one alone would leave it empty. See [environment variables](#overriding-with-environment-variables).
>
> One caveat in `direct` mode: the [`useLukkFetch()`](/use-lukk-fetch) app-API base is derived at **build** time, so a runtime `baseURL` override doesn't feed it. Set [`api.target`](#api-bff-app-api-proxy) explicitly if you use it.

### `mode`

```ts
mode: 'bff' // or 'direct'
```

- **`bff`** (default) — a Nitro proxy holds tokens server-side; the browser never sees one.
- **`direct`** — the client calls lukk directly; the access token lives in memory.

This is the single switch that changes the transport. Your component code does not change. Read [Transport Modes](/transport-modes) before choosing, and pair it with lukk's [output mode](#output-mode) on the server (`direct` ↔ cookie mode, `bff` ↔ body mode).

### `ssrHydrate`

```ts
ssrHydrate: true // default; BFF only
```

In BFF mode the server reads the sealed session and seeds `useLukkAuth().user` / `loggedIn` **during server rendering**, so authenticated pages render logged-in on the first paint — no logged-out→logged-in flash and no `<ClientOnly>`. Only the app `user` resource enters the SSR payload (never a token), and a hydrated render is marked `Cache-Control: no-store`. See [Transport Modes](/transport-modes) for the full rationale.

Set `false` to keep the client-only restore. No effect in `direct` mode (there's no server-side session to read).

> [!NOTE]
> Enabling this (the default) means SSR `user` is now populated in BFF mode where it was previously `null` until client hydration. Review any page that assumed the server always renders anonymous.

### `user.endpoint`

```ts
user: { endpoint: '/api/me' }
```

A route on **your** backend that returns the authenticated user, used to populate `useLukkAuth().user` (unset → `user` stays `null`). It is **mode-dependent**:

- **`direct`** — a path or absolute URL; the access token is attached as a `Bearer` header.
- **`bff`** — the browser has no token, so this **must be a same-origin path authenticated server-side**: a path under the [`api`](#api-bff-app-api-proxy) proxy (e.g. `/api/me`), or your own route using `getLukkAccessToken(event)`. No header is attached client-side.

Response shaping (`user.key`), typing (`LukkUser`), and the verified state are covered on [The User](/user).

### `api` (BFF app-API proxy)

```ts
api: { path: '/api', target: 'https://api.example.com', forceJson: true }
```

BFF-only and opt-in. Forwards `${path}/**` to the **fixed** `target` (your Laravel API), injecting the access token server-side — so the browser authenticates to your own API without ever holding a token. `target` is never derived from the request (SSRF-safe); non-GET requests with a foreign `Origin` are rejected (CSRF); the inbound `Cookie`/`Authorization` + spoofable `X-Forwarded-*` are stripped; upstream `Set-Cookie` is stripped; and `/api/_lukk/**` is never proxied.

- **Step-up tokens are injected server-side.** A route behind lukk's `lukk.confirm` middleware works through this proxy once the user has [confirmed](/confirmation): the token comes from the sealed session, and one sent by the browser is discarded. Rename it with `confirmationHeader` and both proxies follow — the value must be a valid HTTP header name or the build fails.
- **`target`** is validated at build time exactly like [`baseURL`](#baseurl) — it must be an absolute `http(s)` URL when the proxy is registered. (In `direct` mode `target` isn't proxied but still becomes the app-API base for [`useLukkFetch()`](/use-lukk-fetch), so it's validated there too, where a same-origin `/api` is legitimate.)
- **`forceJson`** (default `true`) sets `Accept: application/json` on forwarded requests so a JSON API renders clean `401`/`422` JSON for unauthenticated/validation errors — instead of Laravel's default guest-redirect, which 500s behind a proxy. Set `false` to forward the browser's `Accept` instead — only if a route under `path` legitimately serves a non-JSON response.
- **`forwardSetCookie`** (default `[]`) is an allow-list of cookie **names** to pass through from the app API to the browser; everything else is stripped. No lukk session cookie is ever forwardable — not this app's, nor a co-hosted app's — whatever the list says. For a hybrid app whose Laravel API sets its own cookie (a locale, a theme) — see [Transport Modes](/transport-modes).

**Request headers pass through.** Headers the proxy does not explicitly strip or overwrite reach your API unchanged — this is intentional and covered by tests, so you can depend on it. It's what lets an app carry per-visitor data across the proxy hop that the hop would otherwise destroy: a Nitro middleware can copy Cloudflare's `CF-IPCountry` / `CF-IPCity` onto your own `X-Visitor-*` headers (a prefix Cloudflare won't re-stamp) and read them on the Laravel side, since the proxy's own connection is re-stamped with the *server's* location. What the proxy replaces: `Cookie`, `Authorization`, the step-up confirmation header, `X-Forwarded-For`, the spoofable forwarding set (`X-Real-IP`, `CF-Connecting-IP`, `Forwarded`, …) — all credentials or client-identity claims a browser must not assert — and `Accept` while `api.forceJson` is on. A handful of hop-by-hop headers (`connection`, `transfer-encoding`, `accept-encoding`, `upgrade`, `expect`, `host`) are dropped by the proxy layer itself and don't transit either.

> [!TIP]
> Call the proxied API with [`useLukkFetch()`](/use-lukk-fetch) — a plain `$fetch` forwards no cookie during SSR and silently `401`s. It also rejects with a typed `LukkError` (`{ message, status, errors }`).

### `session.password`

The secret that seals the BFF token cookie (≥ 32 characters). **Set it via the environment**, not in `nuxt.config.ts`:

```dotenv
NUXT_LUKK_SESSION_PASSWORD=a-long-random-string-of-at-least-32-chars
```

Only used in `bff` mode. Treat it like Laravel's `APP_KEY`: secret, and rotating it logs everyone out.

### `session.name`

Namespaces the BFF sealed-session cookie so **multiple lukk apps can share a host** without clobbering each other's session. Cookies are scoped by host, **not port**, so two apps on `localhost:3000` + `:3001` (or two apps under one domain via path routing) otherwise read and overwrite the same cookie — logging into one silently logs the other out. Set a distinct slug (`[A-Za-z0-9._-]`) per app:

```ts
lukk: { session: { name: 'admin' } }
```

| `session.name` | Secure (prod / `--https`) | Dev over http |
|---|---|---|
| unset | `__Host-lukk-session` | `lukk-session` |
| `'admin'` | `__Host-lukk-admin-session` | `lukk-admin-session` |

Unset keeps the default names, so adding it to one app doesn't change the other. Only used in `bff` mode.

> [!WARNING]
> `session.name` is **de-confliction, not a trust boundary.** Apps that share an origin — the same host with path routing, or `localhost` across ports — share one cookie jar, and the namespace only keeps their cookies from overwriting one another. The real isolation is the per-app [`session.password`](#session-password) (the seal): a co-hosted app can't decrypt or forge another app's session without its password. For apps in **distinct trust domains**, put them on **separate subdomains** — where the `__Host-` prefix plus the proxy's `Origin` check give real isolation — and give each a distinct, strong `session.password`.

### `clientIpHeader`

**The problem it solves.** In BFF mode every upstream call is a fresh connection from your Nitro server, so the address your API sees is the *proxy*, not the visitor. Anything keying on `$request->ip()` therefore treats your entire user base as one identity — a `throttle:5,1` on a public form becomes **5 requests per minute globally**, and one user can lock out everyone else. lukk's own auth throttles (`login`, `forgot-password`, `two-factor-challenge`, and `refresh` at 30/60s) collapse the same way.

Blanking the browser-settable forwarding headers is the right default — otherwise any client could claim any IP and defeat your rate limiting. This option is how you say *"this hop is trusted"* when it genuinely is:

```ts
// nuxt.config
lukk: { clientIpHeader: 'cf-connecting-ip' }
```

Both proxies and the server-side token refresh then forward that address upstream as `X-Forwarded-For`. Unset, nothing changes.

#### It must be a header your edge *sets*

Name a header your edge **overwrites** — `cf-connecting-ip` behind Cloudflare, or `x-real-ip` if your own nginx sets it. A header your edge merely *appends* to (the usual `X-Forwarded-For` chain) leaves the leftmost entry client-controlled, and trusting it would let a visitor forge their address — worse than the shared bucket you started with. The module warns at build if you name one, and a list-valued header is rejected at runtime.

> [!WARNING]
> **Your origin must not be reachable except through that edge.** There is no socket-peer check here (unlike Laravel's `TrustProxies`), so if someone can reach Nitro directly — a leaked origin IP, no firewall on your CDN's ranges — they can simply set the header themselves. Lock the origin down before enabling this.

#### Configure Laravel to trust *only* this header — and only your BFF

`$request->ip()` ignores `X-Forwarded-For` until `TrustProxies` trusts the hop. Trust the BFF's **egress address**, not "whoever connects":

```php
// bootstrap/app.php
use Illuminate\Http\Request;

->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(at: '10.0.0.5', headers: Request::HEADER_X_FORWARDED_FOR);
})
```

> [!CAUTION]
> **`at: '*'` does not mean "trust every address" — it means *trust whoever connected*.** If your Laravel origin is reachable from anywhere (the default on most hosts), an attacker connecting directly *is* the trusted peer, so their own `X-Forwarded-For` is believed. They then mint a fresh throttle bucket per request — defeating every per-IP limit, including the per-IP cap that is the only defence against password spraying — or pick a victim's address and burn *their* login budget. Use `'*'` only when the origin is network-isolated to the BFF.

> [!CAUTION]
> **Pass `headers:` — Laravel's default mask is the wrong one here.** It also trusts `X-Forwarded-Host`, which the app-API proxy blanks for safety. Trusting a blanked host makes `$request->getHost()` return **empty**, so `url()`, `route()` and signed URLs on routes behind that proxy render as `http:///…`. Scoping to `HEADER_X_FORWARDED_FOR` avoids it, and also stops a spoofed host reaching your app.

If a CDN or load balancer sits between your BFF and Laravel, list both hops — otherwise `$request->ip()` resolves to the BFF again and the option silently does nothing.

#### Restore your rate limits afterwards

If you previously raised lukk's limits to stop a BFF deployment throttling itself, **lower them back to the per-user defaults** once this is on. Inflated limits that were safe against one shared bucket become a per-attacker-IP budget — 5000 login attempts/minute/IP is no throttle at all.

Once buckets really are per-visitor, lukk keys IPv6 callers on their `/64` rather than the full address (a subscriber typically holds a whole `/64`, so keying on the address would let one visitor mint unlimited buckets). Tune it with [`rate_limits.ipv6_prefix`](#rate-limits) — raise it toward `128` if your users share a `/64`, as an office or campus LAN does. Note that per-IP limits alone no longer cap password spraying or signup floods across rotating addresses; keep the per-account backstops (`account_max_attempts`, the per-user 2FA limit) in place.

> [!NOTE]
> On non-Node Nitro presets (Cloudflare, Deno, Bun, edge runtimes) there is no socket address to fall back to, so `clientIpHeader` is the **only** way your upstream ever learns the caller.
>
> Enabling this means your auth server receives — and likely logs — visitor IP addresses, which are personal data under GDPR. lukk itself neither stores nor logs them (they become a short-lived cache key with a `decay_seconds` TTL); your own application logging is where any retention obligation lands.

### `confirmationHeader`

```ts
confirmationHeader: 'X-Lukk-Confirmation'
```

The HTTP header that carries a [step-up confirmation token](/confirmation). Change it only if you've changed `confirm.header` on the lukk side — the two must match.

### `storage`

```ts
storage: 'cookie'
```

The BFF token-storage backend. The default `cookie` is a **stateless sealed cookie** — no server-side store, no Redis, serverless-friendly. You can point it at a [Nitro `useStorage`](https://nitro.build/guide/storage) mount name to keep tokens in a server-side store instead. Ignored in `direct` mode.

### Overriding with environment variables

Because the options become Nuxt [runtime config](https://nuxt.com/docs/guide/going-further/runtime-config), they can be overridden at runtime with `NUXT_`-prefixed environment variables — handy for per-environment deploys:

| Variable | Overrides |
|---|---|
| `NUXT_LUKK_SESSION_PASSWORD` | `session.password` (server-only) |
| `NUXT_LUKK_BASE_URL` | the server-side `baseURL` (BFF) |
| `NUXT_PUBLIC_LUKK_BASE_URL` | the public `baseURL` (direct) |

Next: **[Authentication](/authentication)**.
