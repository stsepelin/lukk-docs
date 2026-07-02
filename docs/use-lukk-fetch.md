# useLukkFetch

The [BFF proxy](/transport-modes#bff) authenticates the *transport*; you still need a *client* that sends the session correctly in every context. A plain `$fetch('/api/...')` works in the browser but **forwards no cookie during SSR** — so the same call, server-rendered, returns a silent `401`. `useLukkFetch()` gets this right in client, SSR, and server-route contexts.

```ts
const api = useLukkFetch()

const { data } = await useAsyncData('me', () => api('/me')) // SSR-authenticated
const user = await api<User>('/me') // typed via generics
```

## What it does

`useLukkFetch()` returns a typed [`ofetch`](https://github.com/unjs/ofetch) instance that:

- forwards **only** the sealed session cookie on SSR (never `authorization` or `x-forwarded-*`);
- always sends `Accept: application/json`;
- uses `redirect: 'manual'` — an upstream `3xx` becomes an external navigation to its `Location` (trusted only as far as your own API is) rather than a silently-followed HTML response;
- rejects with a typed [`LukkError`](/lukk-core#errors) (`{ message, status, errors }`), so a `422` bag is ready to bind to a form.

In **direct** mode it also attaches the in-memory bearer and single-flights a `401` refresh-and-retry (sharing `$lukk`'s one refresh, so the rotating token is never replayed).

> [!WARNING]
> In any server/SSR context, use `useLukkFetch()` (or Nuxt's `useFetch`) for authenticated calls — a bare `$fetch` sends no cookie server-side and 401s.

> [!NOTE]
> **Credentials never leak cross-origin.** The session cookie and bearer are attached only to a **same-origin-as-baseURL** target; a cross-origin URL passed to `useLukkFetch` gets no credentials (and `credentials: 'same-origin'`). Also, browsers can't read a manual-redirect target — an upstream `3xx` is surfaced as a navigation on **SSR** but is opaque on the client (the call resolves without following it).

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
> **Clean JSON errors out of the box.** The [app proxy](/transport-modes#authenticating-your-own-api-in-bff) sets `Accept: application/json` on forwarded requests (`api.forceJson`, default `true`), so Laravel's `expectsJson()` is true and unauthenticated / validation failures render as `401`/`422` **JSON** — no `bootstrap/app.php` change needed. (Without it, Laravel's default `redirectGuestsTo(fn () => route('login'))` makes `Authenticate` eagerly resolve `route('login')` *inside the middleware* → a confusing 500; note that `shouldRenderJsonWhen` alone does **not** fix this — it runs after the middleware already threw.) Opt out with `api: { forceJson: false }` only if a route under `path` legitimately serves non-JSON — then you must handle it Laravel-side (`redirectGuestsTo(fn () => null)`, or stamp `Accept` yourself).
>
> The BFF proxy itself is mounted at the exported `LUKK_BFF_PREFIX` (`/api/_lukk`); keep your routes clear of it.

> [!NOTE]
> **Uploads & downloads.** The proxy streams both request and response bodies and forwards `Content-Type`/`Content-Disposition`, so `multipart/form-data` uploads and file downloads work. `forceJson` only sets the request **`Accept`** (the *response* format) — independent of the upload body — so validation errors and protected downloads still render clean JSON. Most download endpoints ignore `Accept` and return the file regardless; if a route under `path` content-negotiates a non-JSON success on `Accept` (rare), set `forceJson: false` for the mount. (All proxied responses are `Cache-Control: no-store`, and `Content-Length` is dropped — chunked transfer, so a progress bar won't show the total.)

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
