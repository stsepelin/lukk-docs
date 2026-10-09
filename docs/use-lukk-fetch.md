# useLukkFetch

The [BFF proxy](/transport-modes#bff-mode) authenticates the *transport*; you still need a *client* that sends the session correctly in every context. A plain `$fetch('/api/...')` works in the browser but **forwards no cookie during SSR** — so the same call, server-rendered, returns a silent `401`. `useLukkFetch()` gets this right in client, SSR, and server-route contexts.

```ts
const api = useLukkFetch()

const { data } = await useAsyncData('me', () => api('/me')) // SSR-authenticated
const user = await api<User>('/me') // typed via generics
```

## What it does

`useLukkFetch()` returns a typed [`ofetch`](https://github.com/unjs/ofetch) instance that:

- during SSR, forwards the visitor's cookies only to **this app** — the relative BFF mount, where the proxy strips everything but the sealed session — and never to an absolute API base; it never forwards `authorization` or `x-forwarded-*`;
- sends `Accept: application/json` unless you set an `Accept` of your own;
- uses `redirect: 'manual'` — an upstream `3xx` becomes an external navigation to its `Location` (trusted only as far as your own API is) rather than a silently-followed HTML response;
- rejects with a typed [`LukkError`](/lukk-core#errors) (`{ message, status, errors }`), so a `422` bag is ready to bind to a form.

In **direct** mode it also attaches the in-memory bearer and single-flights a `401` refresh-and-retry (sharing `$lukk`'s one refresh, so the rotating token is never replayed).

The instance is a real `$Fetch` on the server too: `.raw`, `.create` and `.native` work during SSR, and so does a `Request` argument, with the same credential rules as a plain call (lukk-nuxt 0.12.0; earlier they were undefined during SSR).

> [!WARNING]
> **Direct-mode SSR no longer sends the visitor's cookies to your API** (lukk-nuxt 0.12.0). Up to 0.11, a server render forwarded every cookie the browser sent your app — analytics, CSRF, a co-hosted app's session — to the API base, which in direct mode is usually another host. The API's own cookies never reach your app's server in direct mode, so that sent the API everything except what it owns. If your direct-mode SSR relied on cookies reaching the API, make that call from the browser or from a server route.

> [!WARNING]
> In any server/SSR context, use `useLukkFetch()` (or Nuxt's `useFetch`) for authenticated calls — a bare `$fetch` sends no cookie server-side and 401s.

> [!NOTE]
> **Credentials never leak cross-origin.** The session cookie and bearer are attached only to a **same-origin-as-baseURL** target; a cross-origin URL passed to `useLukkFetch` gets neither. The instance is built with `credentials: 'same-origin'` and *upgrades* to `include` per request, in its `onRequest` hook, once the target is known to be same-origin. A per-call `baseURL` is judged too, not just the path: ofetch applies it **after** the hook runs, so `api('/me', { baseURL: 'https://collector.example' })` would otherwise look like a same-origin `/me` at the moment the decision is made, and leave with your bearer. An absolute per-call base is accepted only on the API's own origin (or, in the browser, this app's, when the API base is the relative BFF mount — on the server an absolute URL is never "this app", because the request's `Host` and `X-Forwarded-*` are client-controlled there, so use a path); a *relative* one resolves against the document, so it is accepted only where the API base is relative too. Deliberately that way round rather than defaulting to `include` and downgrading, because of the caveat below. Also, browsers can't read a manual-redirect target — an upstream `3xx` is surfaced as a navigation on **SSR** but is opaque on the client (the call resolves without following it).

> [!WARNING]
> **A per-call `onRequest` replaces lukk's, it doesn't run alongside it.** ofetch merges per-call options by spreading, so passing your own hook to a single call drops lukk's — the one that sets `Accept`, attaches the bearer or SSR cookie, and performs the same-origin upgrade above. That call keeps the fail-closed `credentials: 'same-origin'` default and sends no lukk credential, which is the safe direction to fail but is rarely what you meant. If you need a per-call hook, call the hook you want from a wrapper around the instance rather than passing `onRequest` through, or create a second instance for that call.

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
> The BFF proxy itself is mounted at the exported `LUKK_BFF_PREFIX` (`/api/_lukk`, under your `app.baseURL`); keep your routes clear of it. The app-API proxy also refuses (`404`) any request whose upstream URL falls under lukk's own routes — call those through the composables. See [`api`](/configuration#api-bff-app-api-proxy).

> [!NOTE]
> **Uploads & downloads.** The proxy streams both request and response bodies and forwards `Content-Type`/`Content-Disposition`, so `multipart/form-data` uploads and file downloads work. `forceJson` only sets the request **`Accept`** (the *response* format) — independent of the upload body — so validation errors and protected downloads still render clean JSON. Most download endpoints ignore `Accept` and return the file regardless; if a route under `path` content-negotiates a non-JSON success on `Accept` (rare), set `forceJson: false` for the mount. (All proxied responses are `Cache-Control: private, no-store` with `Vary: Cookie`, and `Content-Length` is dropped — chunked transfer, so a progress bar won't show the total.)

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
