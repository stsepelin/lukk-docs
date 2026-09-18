# Transport Modes

The client speaks to lukk in one of two modes. They differ only in **where the tokens live and who talks to lukk** — your component code is identical either way, because both sit behind the same composables. On the server, each client mode pairs with a lukk [output mode](/configuration#output-mode): **`bff` ↔ body mode**, **`direct` ↔ cookie mode**.

```mermaid
flowchart TB
    subgraph bff [bff — tokens server-side]
        direction LR
        B1[Browser] -->|same-origin /api/_lukk| N[Nitro proxy<br/>sealed cookie] -->|Bearer| L1[lukk API]
    end
    subgraph direct [direct — tokens in the browser]
        direction LR
        B2[Browser] -->|Bearer + __Host- cookie| L2[lukk API]
    end
```

## BFF Mode

`mode: 'bff'` (the default). A Nitro server route (`/api/_lukk/**`) proxies every auth call to lukk. The tokens are captured on the server and stored in a **sealed, encrypted cookie** — the browser receives only that opaque session cookie and **never sees a JWT or a refresh token**.

```mermaid
sequenceDiagram
    participant Browser
    participant Proxy as Nitro proxy
    participant Lukk as lukk API
    Browser->>Proxy: POST /api/_lukk/login { email, password }
    Proxy->>Lukk: POST /auth/login
    Lukk-->>Proxy: { access_token, refresh_token }
    Note over Proxy: tokens captured + sealed<br/>into the session cookie
    Proxy-->>Browser: { ok: true } — no token in the body
```

The proxy also refreshes server-side: when a forwarded request comes back `401`, it uses the stored refresh token to mint a new pair, re-seals it, and retries — all without the browser noticing.

The proxy also **holds the step-up confirmation token server-side** (it strips it from confirm responses and injects the `X-Lukk-Confirmation` header itself), so neither of the two long-lived credentials nor the step-up proof reaches the browser.

One credential still does: the **two-factor login challenge token**. It is issued before any session exists, so there is no sealed session to put it in, and the browser has to hand it back to `/two-factor-challenge`. It is short-lived (`two_factor.challenge_ttl`, five minutes by default), single-use, account-throttled, and never written into the SSR payload — lukk-nuxt keeps it client-side only, because a `useState` written during a server render serialises into `__NUXT_DATA__`, and at that point in the flow there is no session cookie, so nothing marks that page `no-store`.

**Why choose it**

- The browser holds **no session token** (access, refresh, or confirmation), so XSS can't exfiltrate one. Two short-lived, non-credential cookies do reach it — the [logout note and the signed-out answer](/configuration#session-name) — and neither carries a value.
- Clean SSR: the server reads the sealed session and hydrates both the authenticated **data** and the auth **state** (`user` / `loggedIn`), so authenticated pages render logged-in on the first paint — no flash, no `<ClientOnly>` (see [SSR hydration](#ssr-hydration)).
- No CORS — the browser only talks to your own origin.

**The CSRF trade-off.** Moving tokens server-side trades XSS-exfiltration risk for CSRF risk: the proxy is authenticated by the ambient session cookie. lukk-nuxt closes this — the session cookie is `__Host-lukk-session` (`SameSite=Strict; Secure; HttpOnly; Path=/`, no `Domain`), **and** the proxy rejects any state-changing request whose `Origin` doesn't match your app (a `403`). You don't need to add your own CSRF layer for `/api/_lukk/**`.

**What it needs**

- A runtime server (Node, an edge runtime, a serverless function) — so it does **not** work for a fully static (SSG) deploy.
- A session secret, [`NUXT_LUKK_SESSION_PASSWORD`](/configuration#session-password).
- lukk in body mode (`LUKK_COOKIE_MODE=false`, its default), so the proxy receives the refresh token to seal.

> [!NOTE]
> **Throttling & `grace_seconds`.** Every user's auth traffic egresses from the BFF server's IP, so lukk's *per-IP* refresh/login [throttles](/configuration#rate-limits) collapse onto one address — including the [logout refresh-token lookup](/configuration#throttles-without-a-key-of-their-own), which the proxy's own background revokes of replaced sessions also count against. (The claim route keys on the authenticated user, so it isn't affected.) Set [`clientIpHeader`](/configuration#clientipheader) so the real client is forwarded, rather than raising the limits — an inflated limit becomes a per-attacker budget once forwarding works. Keep lukk's `grace_seconds > 0` (its default 30s): the proxy single-flights refresh, but a zero grace window turns any concurrent refresh into a full-family [revocation](/tokens-and-rotation#reuse-detection).

> [!WARNING]
> **Keep the sealed session under ~4 KB (a claims budget).** The `__Host-lukk-session` cookie holds the access JWT *plus* the refresh and confirmation tokens and a session id (about 45 bytes), iron-sealed (which inflates the payload ~1.34× on top of a fixed envelope). Per [RFC 6265bis §5.6](https://httpwg.org/specs/rfc6265bis.html#section-5.6) a browser **silently drops** any cookie whose `name`+`value` exceeds **4096 octets** — so if a bloated access token pushes the seal over the line, login appears to succeed but the cookie never persists and every following request is anonymous. This only bites when your backend embeds a large claim set via [`Lukk::tokenClaimsUsing`](/customization) (many roles/permissions/tenant data). Keep custom claims lean — put bulky authorization data behind an API lookup keyed by `sub`, not in the token. lukk-nuxt emits a one-line `console.warn` as the sealed session nears the limit so you catch it in development.

### SSR hydration

In BFF mode the server holds the session, so lukk-nuxt hydrates `useLukkAuth().user` / `loggedIn` **during server rendering** — an authenticated page renders logged-in on the first paint, with no logged-out→logged-in flash and no consumer `<ClientOnly>`. It's **on by default**; disable it with `lukk: { ssrHydrate: false }` (reverting to client-only restore).

Per request, on the server, a `session.server` plugin reads the sealed session (read-only unless it has to refresh — it never mints a cookie for an anonymous visitor), and if the access token is still valid it fetches your `user.endpoint` in-process (the same request-aware path [`useLukkFetch`](/use-lukk-fetch) uses) and seeds the user into the SSR payload. The client then hydrates with `user` already present and skips the redundant restore.

Security properties:

- **No token in the payload.** Only your app `user` resource is serialized into the HTML; the access/refresh token never leaves the server (the BFF invariant holds). Expose only fields you're comfortable shipping in the page from your `user.endpoint`.
- **`no-store` on per-user renders.** Any render for a request carrying a real session is marked `Cache-Control: no-store` — including one that ends up not hydrating (a replaced session), since components can still render that account's data — so a shared cache/CDN can't serve one user's render to another (the sealed cookie header alone does **not** prevent caching — RFC 6265bis §5.6).
- **Fails safe.** An anonymous, tampered, or expired-seal request hydrates as logged-out with no side effects (no minted cookie, no 500). An access token that's *expired at render time* is refreshed once and the session re-sealed in place — onto both the page response and the in-process request, so the same render never replays the rotated refresh token. A session that can't be refreshed, or a user endpoint that fails on the server, defers to the client restore; such a render leaves [`ready`](/authentication#waiting-for-the-session-ready) `false` so your code doesn't mistake it for an anonymous visitor.
- **`direct` mode is unaffected** — the access token lives in client memory only, so there's no server session to hydrate from; direct-mode pages stay client-hydrated.

> [!NOTE]
> **A route behind a `swr`/`isr`/`cache` rule renders signed out.** This is Nitro's behaviour, not lukk's: it hands the cached handler a request cloned with only the rule's `varies` headers, so with the default `varies` the render never sees the session cookie — the HTML is anonymous whatever the visitor brought, and a server-side call the page makes through the app-API proxy is unauthenticated. The client restores after hydration, so the visitor does end up signed in, but `ssrHydrate` buys you nothing on those routes. It is also why such a page has nothing per-visitor to replay to the next one — a property of Nitro's current behaviour rather than a promise lukk can make, which is why the browser suite pins it. Note the request is not untouched: lukk's logout middleware runs on it like any other, so a visitor finishing a logout still gets their `Set-Cookie` and a `Vary: Cookie`. To have a cached page show the user, add the cookie to the rule (`cache: { varies: ['cookie'] }`) — which puts it in the cache key too, so entries become per session rather than shared; weigh that against [what a cache further downstream does with them](/authentication#what-ready-deliberately-doesn-t-do).

> [!NOTE]
> **Additive, but a behavior change from ≤ 0.3.** SSR `useLukkAuth().user` used to be `null` on the server (populated only after client hydration); it is now populated during SSR in BFF mode. If a page special-cased "always anonymous on the server", review it (or set `ssrHydrate: false`).

### Authenticating your own API in BFF

The proxy above authenticates the lukk **`/auth`** routes. Your **own** API (and `user.endpoint`) gets no token automatically — the browser has none. Two supported ways (this pairs with lukk's [splitting auth from the API](/deployment#splitting-auth-and-api) topology when the two live on different services):

1. **The app-API proxy** (recommended) — forward `${path}/**` to a fixed Laravel `target`, injecting the bearer server-side:

   ```ts
   lukk: {
     mode: 'bff',
     api: { path: '/api', target: 'https://api.example.com' },
     user: { endpoint: '/api/me' }, // same-origin → authenticated by the proxy
   }
   ```

   `$fetch('/api/...')` from the browser is now authenticated, the token never leaving the server. SSRF-safe (fixed target), CSRF-checked, strips the inbound cookie/authorization **and any browser-spoofable `X-Forwarded-*` headers** (stamping a trusted client IP so Laravel's per-IP throttling/logging can't be poisoned), strips upstream `Set-Cookie`, marks responses non-cacheable, streams the body, and never proxies `/api/_lukk/**`.

   > [!NOTE]
   > **Transparent refresh.** If the sealed session's access token has already expired, the proxy refreshes it server-side *before* forwarding — sharing the same per-session single-flight as the `/api/_lukk/**` auth proxy, so a concurrent auth call and app-API call rotate the refresh token exactly once (never a reuse-detection family revoke). The rotated session is re-sealed into the cookie and carried through the streamed response. A genuinely revoked session still surfaces naturally: the refresh fails and Laravel sees the (stale) bearer, returning its own `401`. The request body is never buffered.

   > [!NOTE]
   > The trusted IP is the connection peer. If Nitro itself sits behind a load balancer / CDN, that's the LB's IP — set [`clientIpHeader`](/configuration#clientipheader) to the header your edge sets so the real client is forwarded. Do not point it at `X-Forwarded-For` itself unless your edge *overwrites* it; an appended chain leaves the leftmost entry client-controlled.

2. **Your own server route** — read the token with the auto-imported read-only helper `getLukkAccessToken(event)` (it never sets a cookie, so it's safe on unauthenticated requests):

   ```ts
   export default defineEventHandler(async (event) => {
     const token = await getLukkAccessToken(event)
     if (!token) throw createError({ statusCode: 401 })
     return $fetch('https://api.example.com/me', { headers: { Authorization: `Bearer ${token}` } })
   })
   ```

To call your app API from a page or `useAsyncData`, use the auth-aware [`useLukkFetch`](/use-lukk-fetch) — a plain `$fetch('/api/...')` forwards no cookie during SSR and 401s. For forms bound to Laravel validation, use [`useLukkForm`](/use-lukk-form).

## Direct Mode

`mode: 'direct'`. The client in the browser calls lukk directly — there is no proxy. The access token is kept **in memory** (never in `localStorage`), and the refresh token lives in lukk's hardened `__Host-refresh` cookie (HttpOnly, Secure, `SameSite=Strict`), which the browser sends automatically on refresh.

> [!NOTE]
> **What lukk-js does write to web storage.** No token, but not nothing. Two keys, both scoped to your [`app.baseURL`](/configuration#session-name) so co-hosted apps stay apart:
>
> | Key | Store | Holds |
> |---|---|---|
> | `lukk:logging-out:<app.baseURL>[#<session.name>]` | `sessionStorage` | A logout started but not known to have finished: the moment it was asked for, and the session's refresh-token family (`fid`) when one was known. One minute. |
> | `lukk:signed-in-at:<app.baseURL>[#<session.name>]` | `localStorage` | When a sign-in was last *sent*, in any tab. Only read to decide whether a logout note that names no session is still current. |
>
> Both exist so the page load after a logout can finish it — see [Logging out](/authentication#logging-out-1). **Clearing `localStorage` on logout**, a common idiom, deletes the second one, and a note with no family then has no way to tell that a later sign-in has already superseded it: the next page load can end the **newer** session. If you clear storage on logout, `await logout()` first and leave lukk's two keys alone.

**Why choose it**

- No runtime server required — it works for a **fully static site** served from a CDN.
- Simpler deploy: there's nothing server-side to run.

**What it needs**

- lukk in cookie mode (`LUKK_COOKIE_MODE=true`), so the refresh token is delivered as the `__Host-` cookie.
- **CORS configured on lukk** for your site's exact origin, with credentials. Because the client sends `credentials: 'include'`, lukk must echo your specific `Origin` and set `Access-Control-Allow-Credentials: true` — a wildcard `Access-Control-Allow-Origin: *` is rejected by the browser when credentials are included. Getting this wrong fails *silently* as a perpetual logged-out loop. (Cross-site cookie delivery also requires lukk's refresh cookie to be `SameSite=None; Secure` if your app and API are on different sites.)

Call your own API with [`useLukkFetch()`](/use-lukk-fetch) here too: it attaches the in-memory bearer and single-flights a `401` refresh-and-retry (sharing `$lukk`'s refresh). Because the token is client-only, a **direct**-mode `useLukkFetch` call during SSR has no bearer — fetch your API on the client, or use **BFF** mode when you need SSR-authenticated data.

> [!WARNING]
> **The access token is reachable by JavaScript in direct mode.** It lives in client memory (never `localStorage`), but any script on the page — including injected script under XSS — can read it and call the API as the user until it expires. Minimise your XSS surface and set a strict Content-Security-Policy. The token is **not** written during SSR, so it never lands in the hydration payload; keep it that way (don't trigger `login`/`fetchUser` server-side). If you need the browser to hold *no* token at all, use **BFF mode**.

> [!NOTE]
> The access token in memory is gone on a full page reload — that's fine. On load, [session restore](/authentication#session-restore) silently refreshes from the `__Host-` cookie and you're logged back in.

## Which Mode for Which App

| Your app | Recommended mode |
|---|---|
| SSR (Nuxt with a Node/edge server) | **`bff`** |
| SPA served by a Node server | **`bff`** |
| Static site / SSG (CDN, no server) | **`direct`** |
| Prototype hitting a local lukk | either |

When in doubt and you have a server, prefer **`bff`** — keeping tokens out of the browser is the stronger default.

## Switching Modes

Flip one config value — and update the lukk side to match the [output mode](/configuration#output-mode):

```ts
// nuxt.config.ts
lukk: { mode: 'direct' }
```

```dotenv
# lukk (.env) — cookie mode for direct, body mode for bff
LUKK_COOKIE_MODE=true
```

No component, composable, or page changes. That's the point.

> [!NOTE]
> Both modes ride `Secure`, `__Host-`-prefixed cookies that a browser won't persist over plain `http`. For running either mode on `http://localhost`, see [Local Development](/local-development).

Next: **[Configuration](/configuration)**.
