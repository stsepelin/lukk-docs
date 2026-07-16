# Local Development

lukk's session cookies are hardened for production: the BFF **sealed session** and the direct-mode **refresh token** both ride a `Secure`, `__Host-`-prefixed cookie. That's exactly what you want in production — but it has one consequence in local dev: **a browser will not persist a `Secure` cookie over plain `http`, even on `localhost`.** So without handling it, you'd log in over `http://localhost:3000` and a page reload would appear logged-out, with no error. There's nothing to debug — it's the cookie being dropped.

How you relax it depends on which [transport mode](/transport-modes) you run.

## BFF mode — automatic (client)

`lukk-nuxt` relaxes the sealed session cookie **for you**, decided once at build time:

| How you run it | Session cookie |
| --- | --- |
| `nuxi dev` (http) | `lukk-session`, **not** `Secure` — persists over `http://localhost` |
| `nuxi dev --https` | `__Host-lukk-session` + `Secure` — mirrors production |
| `nuxi build` / `nuxi preview` (production) | `__Host-lukk-session` + `Secure`, always |

You don't configure anything. The decision is made at build from `nuxt.options.dev` and your dev-server https setting — **never from the request at runtime** (so there's no `x-forwarded-proto` to spoof), and the relaxed cookie is never part of a production build.

- To **exercise the exact production cookie** locally, use `nuxi dev --https` (Nuxt generates a dev cert) or `nuxi preview` (a real production build).
- For an unusual setup — e.g. `nuxi dev` (http) sitting behind your own TLS-terminating proxy — force it explicitly:

```ts
// nuxt.config.ts
lukk: { session: { cookieSecure: true } } // or false; default = secure in prod + dev-https
```

> [!WARNING]
> Never set `cookieSecure: false` in a production build.

> [!TIP]
> Running **two lukk apps on `localhost`** (e.g. `:3000` and `:3001`)? Cookies are scoped by host, not port, so they share one cookie jar and clobber each other's session. Give each a distinct [`session.name`](/configuration#session-name) to namespace its cookie.

## Direct mode — one env flag on the lukk API (server)

In direct-cookie mode the refresh token lives in a `__Host-refresh` cookie set by the **lukk PHP API**, which can't know your front-end is a dev build. So for local dev over http, relax it on the lukk side:

```dotenv
# lukk (.env) — LOCAL DEV ONLY. Never in production.
LUKK_COOKIE_SECURE=false
```

`cookie.secure` (env `LUKK_COOKIE_SECURE`, default `true`) controls the refresh cookie's `Secure` attribute. When you set it `false`, lukk drops `Secure` **and** the `__Host-` prefix from the cookie name (the prefix requires `Secure`, so the browser would otherwise reject it) — the set, clear, and read sides all stay in sync. Leave it `true` (the default) everywhere else. See the [configuration reference](/configuration#cookie).

## Why not just always relax it?

Because the `Secure` cookie is the actual protection — the refresh/session token must never travel over plain http where it can be intercepted. Both switches above are **development-only and default to secure**; the BFF one additionally can't reach a production bundle at all. The right fix for a real deployment is HTTPS, not a relaxed cookie — see [Deployment](/deployment).

Next: **[Security](/security)**.
