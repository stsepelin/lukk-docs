# useLukkFetch

The [BFF proxy](/transport-modes#bff-mode) authenticates the *transport*; you still need a *client* that sends the session correctly in every context. A plain `$fetch('/api/...')` works in the browser but **forwards no cookie during SSR** — so the same call, server-rendered, returns a silent `401`. `useLukkFetch()` gets this right in the browser and during a page's server render.

It is a composable: call it in a component, a page, a plugin or `useAsyncData` — not in a Nitro **server route** (`server/api/*`), which has no Nuxt app to read the session through. There, read the token with [`getLukkAccessToken(event)`](/transport-modes#authenticating-your-own-api-in-bff) and call your API with it.

```ts
const api = useLukkFetch()

const { data } = await useAsyncData('me', () => api('/me')) // SSR-authenticated
const user = await api<User>('/me') // typed via generics
```

## What it does

`useLukkFetch()` returns a typed [`ofetch`](https://github.com/unjs/ofetch) instance that:

- during SSR in BFF mode, forwards the visitor's cookies only to **this app** — the relative app-API proxy mount, as an in-process request — and never to an absolute API base. That in-process hop carries the page request's headers, but the proxy rebuilds what goes upstream: your API never receives the browser's `authorization`, `cookie` or `x-forwarded-*` — it gets the bearer the proxy injects and the client IP it stamps;
- during a BFF render, marks those requests as the render's own (`x-lukk-ssr`), so the app-API proxy never rotates the session for them — see [A render renews the session once](/transport-modes#a-render-renews-the-session-once). The marker never reaches your API, nor any other host;
- sends `Accept: application/json` unless you set an `Accept` of your own;
- uses `redirect: 'manual'` and never follows a `3xx` itself. During SSR an unfollowed `3xx` whose `Location` is on the API's own origin becomes an external navigation there; a cross-origin `Location` is ignored. In the browser a redirect is opaque — the call resolves without following it. Through the BFF [app-API proxy](/transport-modes#authenticating-your-own-api-in-bff) a `3xx` from your API never arrives as one: the proxy answers `502` instead;
- rejects an HTTP error with a typed [`LukkError`](/lukk-core#errors) (`{ status, message, errors?, reason?, retryAfter? }`), so a `422` bag is ready to bind to a form, and a `429` or `503` carries a numeric `Retry-After` as `retryAfter` (lukk-nuxt 0.12.0). A network failure or an abort is not an HTTP error: it rejects with ofetch's own `FetchError` (the cause on `.cause`).

In **direct** mode it also attaches the in-memory bearer and single-flights a `401` refresh-and-retry (sharing `$lukk`'s one refresh, so the rotating token is never replayed). Only a `401` from a target it sent credentials to is renewed for: one from another origin says nothing about this session and rejects as it came. And a request is not replayed as another account: when the renewal comes back for a different user (another tab signed in, and the refresh cookie is shared), it rejects with a `401` whose `reason` is [`SESSION_CHANGED`](/lukk-core#errors) instead of being retried — the new session is kept and the user reloaded, and repeating the action as that account is your call. It attaches the held **step-up token** too, in the [`confirmationHeader`](/configuration#confirmationheader) (lukk-nuxt 0.12.0), so `withConfirmation()` can reach a `lukk.confirm`-gated route of your own API — like the bearer, only to the API's own origin, never to another. In BFF mode the proxy injects both from the sealed session.

**Its base.** In BFF mode the base is the [app-API proxy](/configuration#api-bff-app-api-proxy)'s `api.path`, resolved under your [`app.baseURL`](https://nuxt.com/docs/api/nuxt-config#baseurl) — the proxy is a server route of this app. In direct mode it is [`api.target`](/configuration#api-bff-app-api-proxy) as written (or `baseURL`'s origin when unset): a relative `/api` there is an API served beside the app on the same origin, not a route under its base, so from lukk-nuxt 0.12.0 it is no longer prefixed with `app.baseURL` — which sent every call where nothing answered.

The instance is a real `$Fetch` on the server too: `.raw`, `.create` and `.native` work during SSR, and so does a `Request` argument, with the same credential rules as a plain call (lukk-nuxt 0.12.0; earlier they were undefined during SSR).

> [!WARNING]
> **Direct-mode SSR no longer sends the visitor's cookies to your API** (lukk-nuxt 0.12.0). Up to 0.11, a server render forwarded every cookie the browser sent your app — analytics, CSRF, a co-hosted app's session — to the API base, which in direct mode is usually another host. The API's own cookies never reach your app's server in direct mode, so that sent the API everything except what it owns. If your direct-mode SSR relied on cookies reaching the API, make that call from the browser or from a server route.

> [!WARNING]
> In any server/SSR context, use `useLukkFetch()` (or Nuxt's `useFetch`) for authenticated calls — a bare `$fetch` sends no cookie server-side and 401s.

> [!NOTE]
> **Credentials never leak cross-origin.** The session cookie, bearer and step-up token are attached only to a target **on the API's origin**; anything else gets none of them. The instance is built with `credentials: 'same-origin'` and *upgrades* to `include` per request, in its `onRequest` hook, once the target is known to be ours — deliberately that way round rather than defaulting to `include` and downgrading, because of the caveat below. The rules:
>
> - **A relative path** joins onto the API base, so it is ours.
> - **An absolute URL** is ours only on the API's own origin — or, in the browser, on this app's origin when the API base is the relative BFF mount. On the server an absolute URL is never "this app": the request's `Host` and `X-Forwarded-*` are client-controlled there, so use a path.
> - **A per-call `baseURL`** is judged too, not just the path: ofetch applies it **after** the hook runs, so `api('/me', { baseURL: 'https://collector.example' })` would otherwise look like a same-origin `/me` at the moment the decision is made, and leave with your bearer. An absolute one is accepted on the same terms as an absolute URL; a *relative* one resolves against the document, so it is accepted only where the API base is relative too. A `baseURL` that is not a string at all (a boxed `String`, an object) gets no credentials.
> - **An explicitly empty `baseURL`** (`api('/me', { baseURL: '' })`) tells ofetch not to join, so a relative path goes to the **page's** origin. It carries credentials only when that is the API too: the API base is relative (the BFF mount, which is this app), or — in the browser only, since on the server the page's origin is whatever the request's `Host` claims — the page is on the API's absolute origin (lukk-nuxt 0.12.0).

> [!WARNING]
> **A per-call `onRequest` replaces lukk's, it doesn't run alongside it.** ofetch merges per-call options by spreading, so passing your own hook to a single call drops lukk's — the one that sets `Accept`, attaches the bearer or SSR cookie, and performs the same-origin upgrade above. That call keeps the fail-closed `credentials: 'same-origin'` default. In direct mode it goes out without the bearer and step-up token, and a cross-origin target gets no cookies either — the safe direction to fail, but rarely what you meant. In BFF mode a call to this app's own origin is unaffected: the browser still sends the session cookie there under `same-origin`, and the proxy injects the bearer. If you need a per-call hook, call the hook you want from a wrapper around the instance rather than passing `onRequest` through, or create a second instance for that call.

## Organizing a typed API

`useLukkFetch()` is a typed `ofetch` instance, so group your endpoints however you like — e.g. thin resource modules. lukk owns the auth transport and the Laravel error shape; your endpoints and their types stay yours:

```ts
// app/api/users.ts
export const usersApi = () => {
  const api = useLukkFetch()
  return {
    me: () => api<User>('/me'),
    update: (dto: UpdateUser) => api<User>('/me', { method: 'PATCH', body: dto }),
  }
}
```

> [!NOTE]
> **Clean JSON errors out of the box.** The [app proxy](/transport-modes#authenticating-your-own-api-in-bff) sets `Accept: application/json` on forwarded requests (`api.forceJson`, default `true`), so Laravel's `expectsJson()` is true and unauthenticated / validation failures render as `401`/`422` **JSON** — no `bootstrap/app.php` change needed. (Without it, Laravel's default `redirectGuestsTo(fn () => route('login'))` makes `Authenticate` eagerly resolve `route('login')` *inside the middleware* → a confusing 500; note that `shouldRenderJsonWhen` alone does **not** fix this — it runs after the middleware already threw.) Opt out with `api: { forceJson: false }` only if a route under `path` legitimately serves non-JSON — then you must handle it Laravel-side (`redirectGuestsTo(fn () => null)`, or stamp `Accept` yourself). With `forceJson: false`, an `Accept` you pass to `useLukkFetch()` reaches the route; it no longer overwrites one you set.
>
> The BFF proxy itself is mounted at the exported `LUKK_BFF_PREFIX` (`/api/_lukk`, under your `app.baseURL`); keep your routes clear of it. The app-API proxy also refuses (`404`) any request whose upstream URL falls under lukk's own routes — even after further percent-decoding, and [behind a PHP front controller](/transport-modes#authenticating-your-own-api-in-bff) (`/api/index.php/auth/login`) — call those through the composables. And it refuses (`403`) a cross-site or same-site `GET` that isn't a top-level navigation, as the auth proxy does: an `<img>` or a frame pointing at your API from a sibling subdomain is not answered as the visitor, while a link to a download still works. See [`api`](/configuration#api-bff-app-api-proxy).

> [!NOTE]
> **Uploads & downloads.** The proxy streams both request and response bodies and forwards `Content-Type`/`Content-Disposition`, so `multipart/form-data` uploads and file downloads work. `forceJson` only sets the request **`Accept`** (the *response* format) — independent of the upload body — so validation errors and protected downloads still render clean JSON. Most download endpoints ignore `Accept` and return the file regardless; if a route under `path` content-negotiates a non-JSON success on `Accept` (rare), set `forceJson: false` for the mount. (All proxied responses are `Cache-Control: private, no-store` with `Vary: Cookie` and `X-Content-Type-Options: nosniff`, and `Content-Length` is dropped — chunked transfer, so a progress bar won't show the total. A response that is neither JSON nor a PDF also carries `Content-Security-Policy: sandbox` (lukk-nuxt 0.12.0): a file shown inline — HTML, SVG — renders with an opaque origin and no script, so it can't act as your app. A download saved to disk is unaffected.)

## Cookies & CSRF (who owns `Set-Cookie`)

> [!NOTE]
> The proxy owns cookies: it **strips every upstream `Set-Cookie`** your Laravel API returns and re-emits **only** lukk's sealed session cookie (rotated on refresh). So an app-API response's own cookie — a locale, a feature flag, Laravel's `XSRF-TOKEN` or web-session cookie — does **not** reach the browser through the proxy. This is by design: lukk is stateless (bearer JWT), and forwarding upstream cookies would risk leaking or colliding with the sealed session. If a browser cookie is genuinely needed, set it from a Nuxt plugin/server route rather than a proxied app-API response, or keep those cookie-driven routes off the `${path}` mount — **or** opt specific cookies in with `api.forwardSetCookie` (below). For the same reason CSRF is enforced by **origin** (a `SameSite=Strict` session + an `Origin` check), not a token — so Laravel's token-based CSRF (`419`) does not apply to lukk auth or the proxied API. In **direct** mode there is no proxy: the browser handles the app's `Set-Cookie` natively, subject to CORS and `SameSite`.

> [!NOTE]
> **Opting cookies in — `api.forwardSetCookie`.** For a hybrid app whose Laravel API legitimately sets a browser cookie, pass an **allow-list of cookie names** to let just those through the proxy:
>
> ```ts
> lukk: { mode: 'bff', api: { path: '/api', target: '…', forwardSetCookie: ['locale', 'theme'] } }
> ```
>
> Everything else is still stripped, and the sealed session cookie is **never** forwardable — even if you list its name, an upstream can't overwrite it. Default `[]` (strip everything).

For a reactive form bound to Laravel validation over this same transport, see [`useLukkForm`](/use-lukk-form).

Next: **[useLukkForm](/use-lukk-form)**.
