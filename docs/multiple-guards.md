# Multiple guards (admin + users)

Some apps serve two audiences that must never mix — a **users** API and an **admins** API. lukk lets each be its own guard with its **own cryptographic token identity**, so a token minted for one can never authenticate on the other. It's opt-in and strictly backward compatible: an app with no `lukk.guards` behaves exactly as a single-guard app.

## The problem it solves

Point two guards at the `lukk-jwt` driver naively and they'd share one secret + issuer + audience, differing only by which table the subject id is looked up in. An admin token (`sub=5`) would then verify fine on the users guard and resolve `User::find(5)` — **account takeover by subject-id collision**. lukk closes this by giving each guard a distinct, validated **audience** (the [RFC 8725 §3.9](https://www.rfc-editor.org/rfc/rfc8725.html#section-3.9) / [OWASP ASVS 5.0](https://github.com/OWASP/ASVS) §9.2.3–9.2.4 control), rejecting a foreign token **before** any user is resolved.

## Setup

A guard is declared in two places, joined by its name — the standard Laravel pattern (like Sanctum's config alongside `auth.php`):

**1. `config/auth.php`** — the guard's existence + driver + user table (Laravel-native; lukk reuses the `provider`):

```php
'guards' => [
    'api'   => ['driver' => 'lukk-jwt', 'provider' => 'users'],   // default (exists today)
    'admin' => ['driver' => 'lukk-jwt', 'provider' => 'admins'],  // new
],
'providers' => [
    'users'  => ['driver' => 'eloquent', 'model' => App\Models\User::class],
    'admins' => ['driver' => 'eloquent', 'model' => App\Models\Admin::class],
],
```

**2. `config/lukk.php` → `guards`** — the guard's token identity + route mount:

```php
'guards' => [
    'admin' => [
        'audience' => env('LUKK_ADMIN_AUDIENCE'),  // REQUIRED, distinct — this is the isolation
        'issuer'   => env('LUKK_ADMIN_ISSUER'),
        'secret'   => env('LUKK_ADMIN_SECRET'),     // optional: a separate signing key (hardening)
        'path'     => 'admin/auth',                  // route prefix
        'domain'   => 'admin.api.example.com',       // optional subdomain (see below)
    ],
],
```

Everything the guard doesn't declare is **inherited** from the top-level config (ttls, features, cookie, …). The **top-level config is the default guard** (`config('lukk.guard')`, `api`), unchanged.

Generate a per-guard secret:

```bash
php artisan lukk:secret --guard=admin   # writes LUKK_ADMIN_SECRET to .env
```

Bind the admin model to its guard so `startSession()` / `revokeAllSessions()` mint and scope under it:

```php
// app/Models/Admin.php
use Lukk\Concerns\HasRefreshTokens;

class Admin extends Authenticatable
{
    use HasRefreshTokens;

    public function lukkGuard(): string
    {
        return 'admin';
    }
}
```

The `refresh_tokens` table already carries the nullable `guard` column that scopes families per guard (it ships in lukk's core migration and stays null under a single guard) — no extra migration to run.

> [!NOTE]
> **Enabling multi-guard on an existing single-guard app?** Its existing rows have `guard = NULL`, but once you configure guards the default guard scopes by its name — so backfill first, or current sessions log out once:
> ```sql
> UPDATE refresh_tokens SET guard = 'api' WHERE guard IS NULL;  -- 'api' = your config('lukk.guard')
> ```

## What you get

lukk auto-mounts each guard's **core session** routes under its `path` (+ `domain`), wired to `auth:{name}` and that guard's crypto identity:

```
POST admin/auth/login      admin/auth/refresh      admin/auth/logout
DELETE admin/auth/sessions admin/auth/sessions/others  POST admin/auth/confirm-password
```

Protect admin routes with `auth:admin`; they resolve against the `admins` table with the admin token identity.

## The isolation guarantees

- **Token identity.** A token minted for `admin` is rejected by the `users` guard on the **audience** check — and the **signature** too, if you gave it a separate secret. The rejection happens *before* the user is resolved, so it can never look up the wrong table.
- **Refresh + revocation.** Refresh-token families are scoped by a `guard` column. Rotating an admin refresh token on the users refresh endpoint fails (not found); `revokeAllSessions()` on `admin` id `5` leaves the users guard's id `5` sessions **untouched**.
- **Revocation can't cross.** The denylist is shared but keyed by `jti`/`fid` (UUIDs), so admin revocation only evicts admin families — a user's tokens are a different family and are never affected.

### Separate keys vs. a shared secret

Per the standards, a **shared secret + distinct audience is a fully compliant control** (ASVS §9.2.4; RFC 8725 lists key-separation and audience-differentiation as co-equal). Separate per-guard `secret`/keys are the stronger **defense-in-depth** option. Either way, the **audience is what isolates the tokens**, so lukk **refuses to boot** unless every guard declares a distinct, non-empty audience and mounts at a distinct path/domain — and unless every extra guard is declared in `config/auth.php`.

## Path vs. subdomain

Set a guard's `domain` to serve it on a **subdomain** instead of a path — the stronger isolation:

```php
'guards' => [
    'admin' => ['audience' => env('LUKK_ADMIN_AUDIENCE'), 'domain' => 'admin.api.example.com', 'path' => 'auth'],
],
'domain' => env('LUKK_DOMAIN'),  // give the default guard its own host too (e.g. api.example.com)
```

Distinct subdomains are distinct **origins**, so cookies (`__Host-` refresh, BFF sealed session), CORS, and CSP isolate automatically — and you can gate the admin host at the network layer (IP allowlist, VPN, zero-trust proxy). When you use domains, give **every** guard a domain so there's no host-agnostic catch-all.

## Client side (lukk-js / Nuxt)

The client needs **no special support** — it's one app per guard, each pointed at its guard's endpoints:

```ts
// clients app                                   // admin app (separate deployment / subdomain)
lukk: { baseURL: 'https://api.example.com/auth' }
lukk: { baseURL: 'https://admin.api.example.com/auth' }
```

Each app's BFF seals only its guard's tokens in its own cookie; with subdomains, those cookies isolate by origin automatically. The server enforces the boundary regardless of what any client does. (Driving *both* guards from a *single* Nuxt app would need a multi-instance client config — a separate concern; two apps is the recommended shape.)

## Security notes

- **This isolates authentication, not authorization.** A guard boundary stops a client token from reaching admin APIs; it does **not** replace per-object / per-action checks (OWASP API1 BOLA / API5 BFLA). Gate admin actions with Laravel Policies/Gates, deny-by-default.
- **Harden the admin tier further:** mandatory phishing-resistant MFA (passkeys), shorter TTLs, network-gated host, and an immutable audit log of admin actions.
- Per-guard email-verification / password-reset / 2FA / passkeys aren't wired to extra guards yet — those features run on the default guard.

Next: **[Security](/security)**
