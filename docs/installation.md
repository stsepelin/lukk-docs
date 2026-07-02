# Installation

lukk has a server half (Laravel) and a client half (Nuxt or another TypeScript app). Set up the server first — it's the source of truth — then point a client at it.

## Server (Laravel)

### Install the package

```bash
composer require lukk/lukk
```

Publish the config and the core migration, then run it:

```bash
php artisan vendor:publish --tag=lukk-config       # config/lukk.php
php artisan vendor:publish --tag=lukk-migrations   # refresh_tokens migration
php artisan migrate
```

> [!NOTE]
> lukk's migrations are **publish-only** — nothing runs until you publish it, the same convention as Sanctum and Passport. Each optional feature ([two-factor](/two-factor-authentication), [passkeys](/passkeys)) is its own publish group, so you only add its schema when you enable the feature.

### Generate the signing secret

Access tokens are signed with a 256-bit secret. Generate one into `.env`:

```bash
php artisan lukk:secret
```

It behaves like `key:generate`: no flag writes `LUKK_SECRET` (prompting before overwrite), `--force` overwrites silently, `--show` prints it instead.

> [!WARNING]
> Treat `LUKK_SECRET` like `APP_KEY` — never commit it. Rotating it invalidates every access token signed with the old value (refresh tokens are opaque and unaffected, so clients recover on their next refresh).

### Configure issuer & audience

Stamped into every token and validated on every request:

```dotenv
LUKK_ISSUER=https://api.example.com
LUKK_AUDIENCE=https://api.example.com
```

Every other setting has a sensible default — see [Configuration](/configuration).

### Wire the guard

lukk registers a `lukk-jwt` auth driver. Map a guard to it in `config/auth.php`:

```php
'guards' => [
    'api' => [
        'driver' => 'lukk-jwt',
        'provider' => 'users',
    ],
],
```

Protect routes with `auth:api` as usual:

```php
Route::middleware('auth:api')->get('/me', fn (Request $request) => $request->user());
```

> [!IMPORTANT]
> lukk's own `/auth/*` routes always render JSON `401`/`422`. **Your own `auth:api` routes are not covered automatically:** an unauthenticated request without `Accept: application/json` takes Laravel's guest redirect and — with no `login` route — 500s inside the middleware. Attach lukk's `lukk.force-json` middleware to fix it surgically:
>
> ```php
> Route::middleware(['lukk.force-json', 'auth:api'])->get('/me', fn (Request $r) => $r->user());
> ```
>
> (Or send `Accept: application/json` from the client — the lukk-nuxt BFF proxy does this for you.)

### Prepare the User model (optional)

The `HasRefreshTokens` trait adds session helpers:

```php
use Lukk\Concerns\HasRefreshTokens;

class User extends Authenticatable
{
    use HasRefreshTokens;
}
```

| Method | Description |
|---|---|
| `$user->refreshTokens()` | The `HasMany` relationship to the user's refresh tokens. |
| `$user->startSession()` | Starts a session, returns a `TokenPair` (access + refresh). |
| `$user->revokeAllSessions()` | Revokes every session for the user. |

The server is now ready to authenticate.

## Client (Nuxt)

> Not on Nuxt? Use the framework-agnostic client — see [Using lukk-core](/lukk-core).

### Install the module

```bash
npm i lukk-nuxt      # or: pnpm add lukk-nuxt · yarn add lukk-nuxt
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['lukk-nuxt'],
  lukk: {
    baseURL: 'https://api.example.com/auth', // your lukk auth routes (incl. the prefix)
    mode: 'bff',                             // 'bff' (default) or 'direct'
    user: { endpoint: '/api/me' },           // your app's authenticated user route
  },
})
```

> [!NOTE]
> In `bff` mode `baseURL` is used **only on the server** — never exposed to the browser, which talks to the same-origin proxy at `/api/_lukk`. In `direct` mode it's public, since the browser calls lukk itself.

### The user endpoint

lukk issues the token; **your app owns the user resource.** Point `user.endpoint` at a route on your own backend that returns the authenticated user — lukk-js calls it (with the access token attached) to populate `useLukkAuth().user`. Leave it unset and `user` stays `null`. See [The User](/user).

### BFF mode: the session secret

In `bff` mode the proxy seals the tokens into an encrypted server-side cookie, which needs a secret of **at least 32 characters** (never commit it):

```dotenv
NUXT_LUKK_SESSION_PASSWORD=a-long-random-string-of-at-least-32-chars
```

Generate one with `openssl rand -base64 32`. It's the BFF equivalent of `APP_KEY`: it's the confidentiality boundary for the sealed tokens, it must be **identical across every server instance**, and rotating it logs everyone out. `direct` mode has no server-side session, so it needs no secret.

### What the module registers

- the composables (`useLukkAuth`, `useLukkTwoFactor`, `useLukkConfirmation`, `useLukkPasskeys`, `useLukkEmailVerification`), auto-imported;
- the route middleware `lukk-auth`, `lukk-guest`, `lukk-verified`, `lukk-confirmed`;
- a client plugin that restores an existing session on load;
- in `bff` mode, the Nitro proxy at `/api/_lukk/**`.

Next: **[Authentication](/authentication)** — logging in from the client against your lukk server.
