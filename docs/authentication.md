# Authentication

Logging in, refreshing, and logging out — the core session lifecycle, on both halves. The server exposes the `/auth/*` endpoints and mints a `TokenPair`; the client drives them through one composable, `useLukkAuth`. For the authenticated user object itself — the user endpoint, `useLukkAuth().user`, and `UserResource` — see [The User](/user).

## Server (Laravel)

### Endpoints

When `lukk.routes` is `true` (the default), the package registers these routes under the `lukk.path` prefix (default `auth`):

| Method | Path | Middleware | Purpose |
|---|---|---|---|
| `POST` | `/auth/login` | login throttle | Exchange email + password for a token pair. |
| `POST` | `/auth/refresh` | `throttle:lukk-refresh` | Exchange a refresh token for a rotated pair. |
| `POST` | `/auth/logout` | `auth:api` | Revoke the current session. |
| `DELETE` | `/auth/sessions` | `auth:api` | Revoke every session for the user. |
| `DELETE` | `/auth/sessions/others` | `auth:api` | Revoke every session **except** the current one. |

> [!NOTE]
> The login throttle is the per-account failure limiter described in [Configuration → Rate Limits](/configuration#rate-limits), not a route `throttle` middleware. All throttles — login, refresh, two-factor, passkeys — are tunable there.

### Logging in

Post credentials to `/auth/login`:

```http
POST /auth/login
Content-Type: application/json

{ "email": "taylor@example.com", "password": "secret" }
```

On success you receive a token pair (the exact shape depends on the [output mode](#output-modes)):

```json
{
    "access_token": "eyJ0eXAiOiJhdCtqd3Qi...",
    "refresh_token": "9f8c1d...",
    "token_type": "Bearer",
    "expires_in": 900
}
```

Wrong credentials return `422`. Lukk's login is **constant-time**: an unknown email runs the same hashing work as a wrong password, so neither timing nor response shape reveals which accounts exist.

Repeated failures are throttled per account and per IP ([rate limits](/configuration#rate-limits)), returning `429`. Those bound a rate; if you also need the NIST SP 800-63B §5.2.2 cap on *consecutive* failures, enable the opt-in [account lockout](/account-lockout), which answers `423` instead.

> [!NOTE]
> If the user has confirmed [two-factor authentication](/two-factor-authentication) or you require [passkeys](/passkeys), login returns a challenge instead of tokens. See those pages for the second step.

### Refreshing tokens

When the access token nears expiry, exchange the refresh token for a fresh pair:

```http
POST /auth/refresh
Content-Type: application/json

{ "refresh_token": "9f8c1d..." }
```

Each refresh **rotates** the token: the response contains a brand-new refresh token, and the old one is consumed. Replaying a consumed token after the grace window revokes the entire session — see [Tokens & Rotation → Reuse detection](/tokens-and-rotation).

The grace window (`grace_seconds`, default 30s) exists so concurrent refreshes don't fight. If the same token is presented twice within the window — multiple tabs, or SSR plus hydration — the second call gets a fresh **access** token under the same session, rather than being treated as theft.

> [!NOTE]
> In [cookie mode](#output-modes), the refresh token is read from the `__Host-refresh` cookie automatically, so the request body can be empty.

The full token lifecycle — a short-lived access token used until it nears expiry, then rotated via the long-lived refresh token:

```mermaid
sequenceDiagram
    participant App as App (client)
    participant API as lukk API

    App->>API: POST /auth/login { email, password }
    API-->>App: 200 { access_token (~15m), refresh_token (~30d) }
    App->>API: GET /protected · Authorization: Bearer access
    API-->>App: 200 (guard verifies sig/claims + denylist)
    Note over App: access token nears expiry
    App->>API: POST /auth/refresh { refresh_token }
    API-->>App: 200 { new access_token, new refresh_token } — rotated
    Note over API: old refresh token consumed<br/>post-grace replay → whole family revoked
```

### Logging out

All logout routes require a valid access token (`auth:api`):

- **`POST /auth/logout`** revokes the current session and denylists its family, killing any access token issued for it within one request.
- **`DELETE /auth/sessions`** revokes every session belonging to the user — useful for a "log out everywhere" button.
- **`DELETE /auth/sessions/others`** revokes every session except the one making the request — useful after a password change.

### Output modes

The `lukk.cookie_mode` option controls where tokens are delivered. From a browser SPA or Nuxt app, the [lukk-js client](#client-nuxt) drives these endpoints for you; its two [transport modes](/transport-modes) pair with the output modes below.

**BFF mode (`cookie_mode => false`, default).** Both tokens are returned in the JSON body. This suits a server-side client — such as a Nuxt BFF — that seals the tokens server-side so the browser never sees them.

```json
{
    "access_token": "...",
    "refresh_token": "...",
    "token_type": "Bearer",
    "expires_in": 900
}
```

**Direct browser mode (`cookie_mode => true`).** The refresh token is set in a hardened `__Host-refresh` cookie (HttpOnly, Secure, `Path=/`, no `Domain`), and only the access token is in the body. This suits a browser client talking to the API directly, with no BFF in front of it.

```json
{
    "access_token": "...",
    "token_type": "Bearer",
    "expires_in": 900
}
```

See [Configuration → Output Mode](/configuration#output-mode) for the config keys.

### Protecting routes

Once the [guard is wired](/installation#wire-the-guard), protect routes with `auth:api` and resolve the user normally:

```php
Route::middleware('auth:api')->group(function () {
    Route::get('/me', fn (Request $request) => $request->user());
    Route::get('/projects', [ProjectController::class, 'index']);
});
```

On every request the guard verifies the JWT (pinning the algorithm and asserting `iss`/`aud`/`exp`/`nbf`), then checks the denylist by both `jti` and `fid`. A token that is expired, tampered, denylisted, or whose user has been deleted is rejected with `401`.

### Starting sessions manually

You don't have to use the built-in login endpoint. To issue tokens yourself — after a custom registration flow, an impersonation feature, or a social login — call `startSession()` on a user (provided by the [`HasRefreshTokens` trait](/installation#prepare-the-user-model-optional)):

```php
$pair = $user->startSession();

$pair->accessToken;   // the signed JWT
$pair->refreshToken;  // the opaque refresh token (shown once)
```

The returned `TokenPair` is a value object; the plaintext refresh token is available only here and is never retrievable again.

> [!NOTE]
> For sign-up specifically, prefer the first-party [registration endpoint](/registration) — it starts the session for you (and handles 2FA / email verification) instead of hand-rolling `startSession()`. On the client, a custom form that hits your own route can bind Laravel validation with the [lukk-js form helper](/use-lukk-form).

## Client (Nuxt)

### `useLukkAuth`

Everything you need for the common case is on one composable, auto-imported in every component, page, and plugin:

```ts
const {
  user,                // Ref<User | null> — the authenticated user (see /user)
  loggedIn,            // ComputedRef<boolean>
  ready,               // ComputedRef<boolean> — has the session been resolved? (see below)
  whenReady,           // () => Promise<void> — resolves once `ready` is true
  restoreFailed,       // ComputedRef<boolean> — the restore couldn't reach an answer (see below)
  login,               // (credentials) => Promise<LoginResult>
  logout,              // () => Promise<void>
  fetchUser,           // () => Promise<void> — reload the user
  initSession,         // () => Promise<void> — silent restore (runs automatically)
  revokeOtherSessions, // () => Promise<void>
  // two-factor — see /two-factor-authentication:
  pendingTwoFactor,    // ComputedRef<boolean>
  verifyTwoFactor,     // (code) => Promise<void>
  verifyRecoveryCode,  // (recoveryCode) => Promise<void>
} = useLukkAuth()
```

The API is identical in [both transport modes](/transport-modes) — only what happens under the hood differs. Each verb maps to a lukk route; see [the endpoints](#endpoints) above for the server contract. For `user` and `fetchUser`, see [The User](/user).

### Logging in

Call `login` with the user's credentials:

```vue
<script setup lang="ts">
const { login } = useLukkAuth()

const email = ref('')
const password = ref('')
const error = ref('')

async function onSubmit() {
  error.value = ''
  try {
    await login({ email: email.value, password: password.value })
    await navigateTo('/dashboard')
  }
  catch (e) {
    error.value = (e as { message?: string }).message ?? 'Login failed'
  }
}
</script>
```

On success, the token is persisted and the [user is loaded](/user) — `loggedIn` flips to `true`. A failed login throws a typed [`LukkError`](/lukk-core#errors) (`{ status, message, errors? }`).

**Custom login fields.** `email` and `password` are required, but you may pass **extra fields** — a `remember` flag, a captcha token, a tenant — and they reach Laravel as-is (no cast needed; the input type is `LoginInput = LoginCredentials & Record<string, unknown>`):

```ts
await login({ email: email.value, password: password.value, remember: true, captcha: token.value })
```

lukk ignores unknown fields on the default login path; to actually *act* on them (or accept a different credential field such as `username`), take over login on the **server** with [`Lukk::authenticateUsing`](/customization) — the closure receives the full request. `twoFactorChallenge` accepts extra fields the same way.

> [!NOTE]
> If the user has two-factor authentication enabled, `login` does **not** log them in — it surfaces a challenge (`pendingTwoFactor` becomes `true`) for you to complete. See [Two-Factor Authentication](/two-factor-authentication).

### Logging out

```ts
const { logout } = useLukkAuth()
await logout()
```

This revokes the session on lukk and clears the local state (access token, user, any pending challenge or confirmation) — even if the network call fails, the client is left logged out.

### Session restore

A returning user with a valid refresh token should arrive already logged in. The module registers a client plugin that calls `initSession()` on load, which silently attempts a refresh and, if it succeeds, loads the user:

```mermaid
sequenceDiagram
    participant App as App (on load)
    participant Lukk as lukk (via mode)
    App->>Lukk: refresh (uses the stored refresh token / cookie)
    alt valid session
        Lukk-->>App: new token pair
        App->>App: fetch user → loggedIn = true
    else no session
        Lukk-->>App: 401
        App->>App: stay logged out
    end
```

You don't normally call `initSession()` yourself — the plugin does. It's exposed for tests and custom boot flows.

### Waiting for the session (`ready`)

`loggedIn` is `false` in two different situations: the visitor is **anonymous**, or the session **hasn't been resolved yet**. A redirect, a fetch of account data, or a deep-link restore that runs in the second situation makes the wrong decision — and there's no later event to retry on.

`ready` tells them apart. It becomes `true` once the restore has **finished**, and `restoreFailed` says whether it actually reached an answer:

| `ready` | `loggedIn` | `restoreFailed` | Meaning |
|---|---|---|---|
| `false` | `false` | `false` | Not resolved yet — don't decide anything |
| `true` | `true` | `false` | Signed in |
| `true` | `false` | `false` | Signed out |
| `true` | `false` | `true` | Couldn't tell — the server was throttled, erroring, or unreachable |

**Gate decisions on `ready`; render on `loggedIn`.** Anything that would be wrong for a signed-in visitor — redirecting to `/login`, skipping a data fetch, dropping a `?id=` from the URL — should wait for `ready`. Pure rendering can use `loggedIn` directly.

#### Where it's `false`

On the **client**, it is already `true` by the time route middleware, component `setup()`, and `onMounted` run: Nuxt awaits the restore plugin before the initial navigation and before mounting the app. When the server [hydrated the user](/transport-modes#ssr-hydration), it's `true` from the very first line of code, so that path stays synchronous.

It is `false` in two places:

- **During a server render that didn't hydrate a user.** That covers [direct mode](/transport-modes#direct-mode) (the server never sees the refresh cookie), `ssrHydrate: false`, prerendered routes, and a session the server couldn't rotate. The server can't tell any of these from an anonymous visitor, so it doesn't claim to know — the client decides after its restore. This is the case that bites: a `useAsyncData` that skips when `!loggedIn` runs on the server, bakes an empty result into the payload, and does **not** re-run when the page hydrates.
- **In any plugin that runs before, or in parallel with, lukk's `lukk:session-restore`.**

#### Restoring a deep link

Resolve the link on the client, once the session is known:

```vue
<script setup lang="ts">
const route = useRoute()
const api = useLukkFetch()
const { loggedIn, whenReady } = useLukkAuth()
const order = ref<Order | null>(null)

onMounted(async () => {
  await whenReady()

  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: route.fullPath } })
  }

  if (route.query.id) {
    order.value = await api(`/api/orders/${route.query.id}`)
  }
})
</script>
```

For data loaded through `useAsyncData`, the fix is `server: false`. On the server the handler would see an unresolved session, return nothing, and bake that into the payload — and the client doesn't re-run a handler whose result came from the server. On the client the session is already resolved, so the handler sees the real answer:

```ts
const api = useLukkFetch()
const { loggedIn } = useLukkAuth()

const { data: orders } = await useAsyncData('orders',
  () => loggedIn.value ? api('/api/orders') : Promise.resolve([]),
  { server: false, watch: [loggedIn] }, // refetch on login / logout
)
```

#### In route middleware

Middleware runs on the server **and again on the client** during hydration. When the server can't resolve the session, defer instead of redirecting — the client run sees it resolved:

```ts
// middleware/account.ts
export default defineNuxtRouteMiddleware((to) => {
  const { ready, loggedIn } = useLukkAuth()

  if (!ready.value) return // the server couldn't tell — let the client decide

  if (!loggedIn.value) return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
})
```

> [!WARNING]
> **`whenReady()` resolves immediately on the server**, even when `ready` is `false`. Every plugin has already run by then, and nothing later in the request can resolve the session — waiting would hang the render until the socket timed out. So on the server, `await whenReady()` is not a guarantee: read `ready` afterwards. Use `whenReady()` in client code (`onMounted`, watchers, event handlers) and `ready` in anything that also runs on the server.

#### When the restore can't reach an answer

Only a `401` or `403` means "no session". A refresh that was rate-limited (`429`), hit a server error (`5xx`), or never reached the server at all leaves the visitor signed out **as far as the UI can tell**, but they may well have a valid session. The same applies when the refresh works and your user endpoint then fails. `restoreFailed` is `true` in exactly those cases, so you can offer a retry instead of a login form:

```vue
<script setup lang="ts">
const { loggedIn, restoreFailed, initSession } = useLukkAuth()
const retrying = ref(false)

async function retry() {
  retrying.value = true
  try { await initSession() }
  finally { retrying.value = false }
}
</script>

<template>
  <AccountMenu v-if="loggedIn" />
  <p v-else-if="restoreFailed">
    We couldn't reach the server.
    <button :disabled="retrying" @click="retry">Try again</button>
  </p>
  <LoginButton v-else />
</template>
```

`initSession()` is the retry: it runs the same single-flight refresh as the automatic restore (so it can't race a request's own refresh), and it updates `restoreFailed` either way. The flag is hidden while someone is signed in and cleared by `logout()`, since both are definitive answers.

In middleware that sends signed-out visitors to `/login`, check `restoreFailed` too. Otherwise a brief server outage sends every signed-in visitor to the login page, even though their session is intact:

```ts
export default defineNuxtRouteMiddleware(() => {
  const { ready, loggedIn, restoreFailed } = useLukkAuth()

  if (!ready.value || restoreFailed.value) return // unknown — don't send a signed-in user to /login
  if (!loggedIn.value) return navigateTo('/login')
})
```

> [!NOTE]
> The built-in [`lukk-auth`](#route-middleware) middleware does not check `ready` or `restoreFailed` yet. It redirects whenever `loggedIn` is `false`, including during a server render that couldn't resolve the session. Write your own, as above, where that matters.

A few things `ready` deliberately does not do:

- **An anonymous server render is never marked `ready`.** That render isn't `no-store`, so a shared cache or CDN may serve it to anyone — including a signed-in visitor whose cookie the edge ignored. A baked-in `ready: true` would stop that visitor's client from restoring their session. The cost: a signed-out call-to-action gated on `ready` renders as a placeholder on the server and appears after the client restore. If that CTA matters for first paint or SEO, render it on `loggedIn` and keep only the *decisions* behind `ready`.
- **It stays `true` after `logout()`.** Signed out is still a resolved answer.

### Revoking sessions

`revokeOtherSessions()` ends every session **except** the current one — useful after a password change ("log out my other devices"):

```ts
const { revokeOtherSessions } = useLukkAuth()
await revokeOtherSessions()
```

To end *every* session including the current one, just [log out](#logging-out-1).

### Route middleware

The module registers four route middlewares:

| Middleware | Effect |
|---|---|
| `lukk-auth` | Redirects to `/login` when **not** authenticated. |
| `lukk-guest` | Redirects to `/` when **already** authenticated (e.g. to keep logged-in users off the login page). |
| `lukk-verified` | Redirects a logged-in user with an **unverified email** to `/verify-email`. |
| `lukk-confirmed` | Redirects a logged-in user without a recent **step-up confirmation** to `/confirm-password`. |

```vue
<script setup lang="ts">
// pages/dashboard.vue
definePageMeta({ middleware: 'lukk-auth' })
</script>
```

```vue
<script setup lang="ts">
// pages/login.vue
definePageMeta({ middleware: 'lukk-guest' })
</script>
```

`lukk-verified` and `lukk-confirmed` act only on an **authenticated** user, so stack them after `lukk-auth`. They're the client-side redirect; the server's [`lukk.verified`](/email-verification) (409) and [`lukk.confirm`](/confirmation) (423) are the real enforcement.

```vue
<script setup lang="ts">
// pages/settings/security.vue — must be logged in, verified, AND recently confirmed
definePageMeta({ middleware: ['lukk-auth', 'lukk-verified', 'lukk-confirmed'] })
</script>
```

Next: **[The User](/user)**.
