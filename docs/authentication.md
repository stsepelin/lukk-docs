# Authentication

Logging in, refreshing, and logging out — the core session lifecycle, on both halves. The server exposes the `/auth/*` endpoints and mints a `TokenPair`; the client drives them through one composable, `useLukkAuth`. For the authenticated user object itself — the user endpoint, `useLukkAuth().user`, and `UserResource` — see [The User](/user).

## Server (Laravel)

### Endpoints

When `lukk.routes` is `true` (the default), the package registers these routes under the `lukk.path` prefix (default `auth`):

| Method | Path | Middleware | Purpose |
|---|---|---|---|
| `POST` | `/auth/login` | login throttle | Exchange email + password for a token pair. |
| `POST` | `/auth/refresh` | `throttle:lukk-refresh` | Exchange a refresh token for a rotated pair. |
| `POST` | `/auth/logout` | `auth:api` (lukk ≤ 0.6); none from 0.7.0 — see [Logging out](#logging-out) | Revoke the current session. |
| `DELETE` | `/auth/sessions` | `auth:api` | Revoke every session for the user. |
| `DELETE` | `/auth/sessions/others` | `auth:api` | Revoke every session **except** the current one. |

> [!NOTE]
> Login is limited twice: a per-IP route throttle (`throttle:lukk-login`, 30 attempts a minute by default) and the per-account failure limiter. Both are described in [Configuration → Rate Limits](/configuration#rate-limits), along with every other throttle — refresh, two-factor, passkeys.

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

The grace window (`grace_seconds`, default 30s) exists so concurrent refreshes don't fight. If the same token is presented twice within the window — multiple tabs, or SSR plus hydration — the second call gets a full token pair under the same session (a sibling refresh token, which the client must store like any other), rather than being treated as theft.

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

- **`POST /auth/logout`** revokes the current session and denylists its family, killing any access token issued for it within one request.
- **`DELETE /auth/sessions`** revokes every session belonging to the user — useful for a "log out everywhere" button. Requires a valid access token; switch it off with [`features.logout_all`](/configuration#feature-toggles).
- **`DELETE /auth/sessions/others`** revokes every session except the one making the request — useful after a password change. Requires a valid access token, and answers a bare `204` that leaves the caller's own refresh cookie in place.

Up to lukk 0.6, `POST /auth/logout` also required a valid access token — so a client whose access token had expired (an idle tab) got a `401`, nothing was revoked, and in cookie mode the refresh cookie stayed valid for its whole lifetime.

**From lukk 0.7.0** logout accepts **either** credential:

- a **valid access token** revokes its session exactly as before (and still authenticates the request as its user);
- the **refresh token** the client holds — the `__Host-refresh` cookie in cookie mode, or `refresh_token` in a JSON body — revokes the session it belongs to on that guard.

An expired access token alone is **not** enough, whatever its signature. The answer is always `204`, so nothing reveals whether a token existed. The refresh cookie is only used — and only cleared — on a request a cross-site form can't make: `Content-Type: application/json` or `Sec-Fetch-Site: same-origin`. A cookie-mode client therefore sends an empty JSON body (lukk-js does). The refresh-token lookup has its own throttle; the logout itself has none, and a logout whose access token is valid doesn't count against it. When the lookup *is* throttled and nothing else ended the session, logout answers **`429`** with `Retry-After` and leaves the refresh cookie in place — retry it, because the session is still live.

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

**Await it before navigating away.** When the access token has expired, `logout()` renews it and retries — one more round trip. A full page load that cancels that retry leaves the session unrevoked on lukk (in direct mode; the BFF renews on the server). `logout()` can also reject — a session that was already gone, a network failure, a `429` from lukk 0.7.0's logout throttle — and it clears local state either way. A `401` means there was no session left to end; anything else means it may still be live on lukk (in direct mode the refresh cookie survives, and the next page load restores it), so offer a retry rather than sending the user on:

```ts
try {
  await logout()
}
catch (error) {
  if ((error as { status?: number }).status !== 401) return showLogoutRetry()
}
await navigateTo('/login', { external: true })
```

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
        Lukk-->>App: 401 or 403
        App->>App: stay logged out
    else couldn't tell
        Lukk-->>App: 429, 5xx or unreachable
        App->>App: restoreFailed = true
    end
```

You don't normally call `initSession()` yourself — the plugin does. It's exposed for tests, custom boot flows, and [retrying a restore that couldn't reach the server](#when-the-restore-can-t-reach-an-answer).

### Waiting for the session (`ready`)

`loggedIn` is `false` in two different situations: the visitor is **anonymous**, or the session **hasn't been resolved yet**. A redirect, a fetch of account data, or a deep-link restore that runs in the second situation makes the wrong decision — and there's no later event to retry on.

`ready` tells them apart. It becomes `true` once the restore has **finished**, and `restoreFailed` says whether it actually reached an answer:

| `ready` | `loggedIn` | `restoreFailed` | Meaning |
|---|---|---|---|
| `false` | `false` | `false` | Not resolved yet — don't decide anything |
| `true` | `true` | `false` | Signed in |
| `true` | `false` | `false` | Signed out |
| `true` | `false` | `true` | Couldn't tell — see [below](#when-the-restore-can-t-reach-an-answer) |

`loggedIn` means "a user was loaded", so an app with no [`user.endpoint`](/user) reads as signed out even with a valid session.

**Gate decisions on `ready`.** Anything that would be wrong for a signed-in visitor — redirecting to `/login`, skipping a data fetch, dropping a `?id=` from the URL — should wait for it.

#### Where it's `false`

On the **client**, `ready` is already `true` by the time route middleware, component `setup()`, and `onMounted` run: Nuxt awaits the restore plugin before the initial navigation and before mounting the app. When the server [hydrated the user](/transport-modes#ssr-hydration), it's `true` from the very first line of code.

It is `false`:

- **During any server render that didn't hydrate a user.** That includes an anonymous visitor, [direct mode](/transport-modes#direct-mode) (the server never sees the refresh cookie), `ssrHydrate: false`, prerendered routes, a session the server couldn't refresh, and a user endpoint that failed on the server. The server can't tell these apart, so it doesn't claim to know — the client decides after its restore.
- **In a plugin that runs before lukk's `lukk:session-restore`** — see [Waiting from a plugin or a store](#waiting-from-a-plugin-or-a-store).

> [!WARNING]
> **Reading `ready` in a template causes a hydration mismatch** on a server-rendered page the server didn't hydrate a user for — including every anonymous visit. The server renders `false`, and the client sets `true` before mounting. `restoreFailed` does the same whenever the client restore fails. Use them in logic (middleware, handlers, `onMounted`), or put the markup that depends on them inside `<ClientOnly>`. `loggedIn` has always behaved the same way for a session restored on the client.

#### Loading account data

A `useAsyncData` handler that skips when `!loggedIn` runs on the server too. When the server couldn't resolve the session it returns nothing, that empty result is written into the payload, and the page doesn't fetch again when it hydrates. Let the server fetch only when it actually resolved the session:

```ts
const api = useLukkFetch()
const { ready, loggedIn } = useLukkAuth()

const { data: orders } = await useAsyncData('orders',
  () => loggedIn.value ? api('/api/orders') : Promise.resolve([]),
  { server: ready.value, watch: [loggedIn] }, // refetch on login / logout
)
```

When the server hydrated the user, it fetches as usual and the page renders with the data. Otherwise it skips, and the client fetches once the restore has finished — so you don't give up server rendering where it works.

#### Restoring a deep link

In `onMounted` the restore has already finished. `loggedIn` is a real answer unless `restoreFailed` says the restore couldn't reach the server — send that visitor to `/login` and a signed-in user is asked to log in again:

```vue
<script setup lang="ts">
interface Order { id: string, total: number }

const route = useRoute()
const api = useLukkFetch()
const { loggedIn, restoreFailed } = useLukkAuth()
const order = ref<Order | null>(null)

onMounted(async () => {
  if (restoreFailed.value) return // show a retry instead — see below
  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: route.fullPath } })
  }

  // A query value is attacker-controlled. Validate it before it becomes part of a URL that is sent
  // with your credentials — `?id=../me/export` would otherwise reach a different endpoint.
  const id = route.query.id
  if (typeof id === 'string' && /^[\w-]+$/.test(id)) {
    order.value = await api<Order>(`/api/orders/${encodeURIComponent(id)}`)
  }
})
</script>
```

> [!WARNING]
> **Validate the `redirect` parameter where you read it.** `route.fullPath` is always a local path, but your login page receives whatever is in the URL. A pattern check on the raw string isn't enough: the URL parser strips tabs and newlines and resolves dot segments, so `/\t/evil.com` and `/.//evil.com` pass a "starts with `/` but not `//`" test and still lead off-site. Parse it the way the browser will, then check the result:
>
> ```ts
> function safeRedirect(raw: unknown, fallback = '/'): string {
>   if (typeof raw !== 'string' || !raw.startsWith('/')) return fallback
>
>   let url: URL
>   try { url = new URL(raw, 'http://local.invalid') }
>   catch { return fallback }
>
>   // A different origin means the string named another host.
>   if (url.origin !== 'http://local.invalid') return fallback
>
>   // Rebuild from the parsed parts, and refuse a path that would read as protocol-relative.
>   const path = url.pathname + url.search + url.hash
>   return /^\/[/\\]/.test(path) ? fallback : path
> }
>
> await navigateTo(safeRedirect(route.query.redirect))
> ```

#### Waiting from a plugin or a store

Middleware, `setup()` and `onMounted` don't need to wait — they already run after the restore. `whenReady()` is for code that can run earlier or from anywhere: a store, or a composable a plugin calls.

```ts
const defaultPreferences = { theme: 'system' }

export async function loadPreferences() {
  // Call composables before the first `await` — Nuxt's instance isn't guaranteed after it.
  const api = useLukkFetch()
  const { whenReady, loggedIn } = useLukkAuth()

  await whenReady()
  return loggedIn.value ? api('/api/preferences') : defaultPreferences
}
```

Plugins run one after another. A plugin that **awaits** `whenReady()` in its setup and runs *before* `lukk:session-restore` — `enforce: 'pre'`, or one added by a module listed after `lukk-nuxt` — waits on a plugin that can't start until it finishes, and the app never boots. Depending on `lukk:client` doesn't fix that. Depend on the restore plugin by name, **in a `.client.ts` file**: the restore only runs in the browser, so a universal plugin naming it is reported — logged as an error during the build on Nuxt 3 and earlier 4.x releases (the build still succeeds), and only a development warning on recent Nuxt 4.

In development lukk-nuxt warns when `whenReady()` is called before the restore has started. The same call is harmless when it isn't awaited in a plugin's setup, so treat the warning as "check this", not as a failure.

```ts
// plugins/preferences.client.ts
export default defineNuxtPlugin({
  name: 'preferences',
  dependsOn: ['lukk:session-restore'],
  async setup() {
    await loadPreferences()
  },
})
```

> [!WARNING]
> **`whenReady()` resolves immediately on the server**, even when `ready` is `false`. The client restore never runs there, so a render the server didn't hydrate would wait forever. Read `ready` afterwards in code that also runs on the server: `false` means "not known here", not "anonymous".

#### In route middleware

Middleware runs on the server **and again on the client** during hydration. When the server couldn't resolve the session, defer — the client run sees it resolved:

```ts
// middleware/account.ts
export default defineNuxtRouteMiddleware((to) => {
  const { ready, loggedIn, restoreFailed } = useLukkAuth()

  if (to.path === '/login') return
  if (!ready.value || restoreFailed.value) return // unknown — don't send a signed-in user to /login
  if (!loggedIn.value) return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
})
```

Two consequences of deferring, both deliberate:

- **The server renders the protected page for a visitor it couldn't identify**, and the client then redirects them if they turn out to be signed out. Route middleware isn't access control — your API is. Never put protected data in the page from anything but an authenticated API response.
- **When `restoreFailed` is `true`, the visitor stays on the page with no user.** Show the retry state there rather than an empty page.

> [!NOTE]
> The built-in [`lukk-auth`](#route-middleware) middleware does not check `ready` or `restoreFailed` yet. It redirects whenever `loggedIn` is `false`, including during a server render that couldn't resolve the session. Write your own, as above, where that matters.

#### When the restore can't reach an answer

Only a `401` or `403` means "no session" — or, in BFF mode, a `409` answered twice in a row, which says the session this browser holds was replaced and the retry couldn't pick up a newer one. Any other failure leaves the visitor signed out **as far as the UI can tell**, though they may well have a valid session: a rate-limited refresh (`429`), a server error (`5xx`), a server that couldn't be reached, or a user endpoint that failed right after a successful refresh. `restoreFailed` is `true` in those cases, so you can offer a retry instead of a login form:

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
  <ClientOnly>
    <AccountMenu v-if="loggedIn" />
    <p v-else-if="restoreFailed">
      We couldn't reach the server.
      <button :disabled="retrying" @click="retry">Try again</button>
    </p>
    <LoginButton v-else />
  </ClientOnly>
</template>
```

`initSession()` is the retry: it uses the same single refresh as the automatic restore, so it can't race a request's own refresh. `restoreFailed` is cleared by any definitive answer — a user loaded, a `401`/`403`, a sign-in, or `logout()`. Unlike `ready`, it doesn't survive `clearNuxtState()`: it reads `false` afterwards until the next restore.

A sign-in or `logout()` that happens while a restore is still in flight wins over it. It waits for a refresh already on its way, so that refresh's cookie can't land on top of the new session, and a refresh that starts while a sign-in or logout is on the wire waits for it. Both waits are capped at 10 seconds so a hung request can't lock anyone out. Anything an older restore, refresh or `fetchUser()` returns afterwards is discarded, so a logged-out user isn't signed back in and a late result can't put the previous account on screen. A sign-in that answers after `logout()` ends the session it was given instead of signing in.

In direct mode that cap is the limit: a refresh slower than 10 seconds, or a sign-in in another tab, can still leave the shared refresh cookie belonging to a different account. The next refresh then notices — its token names a different subject than the user on screen — and reloads the user. The request that triggered that refresh already runs as the other account, before the reload finishes.

In BFF mode the proxy also guards it on the server, which covers what the tab can't see — an app-API call renewing an expired token, a page render, another tab's restore. A sign-in or logout records the sealed session it replaced, and a refresh still out for that session is never written back: each path checks again just before its response goes out. A refresh that was already sent may still rotate it upstream; the proxy then logs those new tokens out in the background, so a browser still holding the old cookie can't later replay a consumed token into a false theft report. Another tab that was restoring asks once more and picks up the newer session; a page render for the replaced session renders signed out and lets the client restore. And a logout from the replaced session doesn't clear the cookie: the browser holds the newer one.

In both modes, a tab that signs in or logs out tells the app's other open tabs (a `BroadcastChannel`, where the browser has one). They drop whatever they had in flight and re-check — a BFF tab reloads its user, a direct tab renews from the shared cookie first — so they stop showing an account the browser no longer holds. In direct mode, several open tabs renew from the same cookie at the same moment, which lukk's grace window absorbs: keep `grace_seconds` above `0`, or every sign-in with more than two tabs open revokes the session it just created.

The limits:

- The record is kept per server process for ten minutes. Behind a load balancer without sticky sessions, a request another instance serves isn't covered, and on serverless or edge runtimes a process is an instance or isolate — there the guard is best-effort.
- A cookie can still land in the moment between a response's headers leaving the server and the browser storing them.
- A session sealed by lukk-nuxt before 0.12.0 has no id of its own. Refreshes cover it, but a page load that needs no refresh can still render it as the account it replaced until that tab reloads.
- If a sign-in's response never reaches the browser, the session it replaced reads as signed out for those ten minutes — yet it is still live on the server until it's logged out or expires, and requests with its cookie keep working until its access token expires (nothing refreshes a replaced session).
- With Nuxt 4's opt-in `experimental.ssrStreaming`, the last check runs right after the user loads; a session that ends between then and the first streamed chunk isn't caught.
- A sign-in waits for a logout still running in the same tab, but not for one in another tab. In BFF mode the proxy keeps that other tab's late logout from clearing the new cookie; in direct mode lukk's logout response clears the shared refresh cookie, so the new session is signed out in the browser — and stays alive on lukk, with nothing pointing at it, until it expires.

A misconfigured endpoint (a `404`, say) also counts as "couldn't tell", and retrying won't fix that. If `restoreFailed` shows up in development, check your `baseURL` and `user.endpoint` first.

> [!NOTE]
> **Behind a BFF, set [`clientIpHeader`](/configuration#clientipheader) — and configure Laravel's `TrustProxies` for it.** Without both, every visitor's refresh reaches lukk from the BFF's own address and shares one rate-limit bucket: 30 per minute by default, for the whole app. Ordinary traffic can exhaust that — a signed-in visitor refreshes whenever their access token has expired, so a few dozen of them arriving in the same minute is enough — and the rest of that minute puts every restoring visitor into the "couldn't reach the server" state. The refresh token isn't consumed by a throttled attempt, so nobody is signed out, but nobody can be restored either until the limit resets. It needn't be accidental, either: one visitor with an account can use up the shared bucket on purpose.

#### What `ready` deliberately doesn't do

- **An anonymous server render is never marked `ready`.** That render isn't `no-store`, so a shared cache or CDN may serve it to anyone — including a signed-in visitor whose cookie the edge ignored. A baked-in `ready: true` would stop that visitor's client from restoring their session. The cost: a signed-out call-to-action gated on `ready` appears only after the client restore. If that matters for first paint or SEO, render it without waiting and keep only the *decisions* behind `ready`.
- **It stays `true` after `logout()`.** Signed out is still a resolved answer.

> [!NOTE]
> **A caching route rule turns hydration off on that route.** Nitro's own route cache (`swr`, `cache`) renders without the visitor's cookies, so the server never sees a session: everyone gets the anonymous render with `ready: false`, and each client restores its own. No user's data enters the cache — but you lose server-rendered account data there. Don't add `cookie` to that rule's `varies` to get it back. Each session then gets its own cached copy, a hit replays a session cookie the server has since rotated, and the cached response goes out with the rule's `Cache-Control` instead of `no-store` and without `Vary: Cookie` — so a CDN or browser further down can store one user's page.
>
> A cache Nitro doesn't own is different — a CDN, or a hosting platform's `isr`. lukk-nuxt marks a hydrated render `Cache-Control: no-store`; one that ignores it, or that renders with cookies, can store one user's page and hand it to the next visitor. Check how yours treats both.

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
| `lukk-auth` | Redirects to `/login` when **not** authenticated — including during a server render that couldn't resolve the session ([see the note](#in-route-middleware)). |
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
