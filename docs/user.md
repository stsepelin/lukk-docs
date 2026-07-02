# The User

lukk issues the token; **your app owns the user resource.** The server never ships a `/user` route — you expose your own `/api/me`-style endpoint and decide its shape — and the client fetches it to populate `useLukkAuth().user`. This page covers both sides of that contract.

## Server (Laravel)

### Your app owns the user

lukk doesn't ship a `/user` route (Sanctum convention). Point a route on **your** backend at the authenticated user — the [`/me` route from Installation](/installation#wire-the-guard) is exactly what the [client](#client-nuxt) fetches to populate `useLukkAuth().user`, so its shape is yours to decide. A bare model already works:

```php
Route::get('/me', fn (Request $request) => $request->user())->middleware('auth:api');
```

An Eloquent model serializes `email_verified_at` (respecting `$hidden`/`$casts`), which the client reads to derive its `verified` state — so make sure your response **includes it** (or a boolean `email_verified`).

### `UserResource` (optional)

For a shaped, guaranteed-aligned response, extend the optional base resource `Lukk\Http\Resources\UserResource`. It emits the identifier and a derived `email_verified` boolean (the fields the client reads); override `fields()` to add your own:

```php
namespace App\Http\Resources;

use Illuminate\Http\Request;

class UserResource extends \Lukk\Http\Resources\UserResource
{
    protected function fields(Request $request): array
    {
        return [
            'name' => $this->name,
            'roles' => $this->roles,
        ];
    }
}
```

```php
Route::get('/me', fn (Request $request) => new UserResource($request->user()))->middleware('auth:api');
```

This emits `{ "data": { "id": …, "email_verified": …, "name": …, "roles": … } }`. A Laravel API Resource **wraps in `data` by default** — the client [auto-unwraps a clean `{ data }`](#response-shape-user-key), so `useLukkAuth().user` is the flat user either way; you can also `JsonResource::withoutWrapping()` if you prefer a bare object.

`UserResource` is a **convenience, not a contract** — lukk's actual user contract is still Laravel's `Authenticatable` + the opt-in `MustVerifyEmail`; you never have to use the resource.

> [!NOTE]
> Keep this resource **lean**. In a BFF/SSR deployment the user object is serialized into the page's SSR payload (HTML), so only expose fields the UI needs — the endpoint, not the client, is where you prevent over-exposure (OWASP API3:2023).

## Client (Nuxt)

### The current user

`useLukkAuth().user` is a reactive ref, populated from your [`user.endpoint`](/configuration#user-endpoint) config. lukk issues the token; your app owns the user, so lukk-js fetches it from your backend. In **direct** mode the access token is attached as a `Bearer`; in **bff** mode the browser has no token, so `user.endpoint` must be a same-origin path authenticated server-side (the [app-API proxy](/transport-modes) or your own route via `getLukkAccessToken(event)`):

```vue
<template>
  <p v-if="loggedIn">Signed in as {{ user.email }}</p>
  <LoginForm v-else />
</template>
```

Call `fetchUser()` to reload it (e.g. after a profile update). With no `user.endpoint` configured, `user` stays `null` and you can drive `loggedIn` yourself.

### Response shape (`user.key`)

```ts
user: { endpoint: '/api/me', key: 'data' } // default
```

lukk **auto-unwraps a Laravel API-Resource wrapper**: a clean `{ "data": {...} }` (with no `meta`/`links`/`errors` envelope) becomes the user object — so a `UserResource` "just works". A `{ "data": null }` response is treated as logged-out.

- `key: 'data'` (default) — unwrap the `data` wrapper.
- `key: 'user'` (or any string) — unwrap a different wrapper key.
- `key: false` — disable unwrapping; store the response verbatim.

Prefer keeping the resource **flat and lean** (it ships in the SSR HTML): `JsonResource::withoutWrapping()` / `$wrap = null`, or extend `Lukk\Http\Resources\UserResource`. If you're `loggedIn` but `user` fields are `undefined`, lukk logs a dev warning pointing here.

### Typing the user (`LukkUser`)

`useLukkAuth().user` is typed `LukkUser | null`. lukk pre-declares only what it reads (`email_verified_at` / `email_verified`); augment the interface with your own fields:

```ts
declare module 'lukk-core' {
  interface LukkUser {
    name: string
    roles: string[]
  }
}
```

### Verified state

The client derives `verified` from the user object — reading `email_verified_at` (or a boolean `email_verified`) off the fetched resource. That's why your endpoint must include it. The verified state drives the [`lukk-verified` middleware](/authentication#route-middleware) and the [email-verification flow](/email-verification).

Next: **[Two-Factor Authentication](/two-factor-authentication)**.
