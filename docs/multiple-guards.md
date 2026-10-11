# Multiple guards (admin + users)

Some apps serve two audiences that must never mix — a **users** API and an **admins** API. lukk lets each be its own guard with its **own cryptographic token identity**, so a token minted for one can never authenticate on the other. It's opt-in: an app with no `lukk.guards` behaves exactly as a single-guard app — provided `config/auth.php` maps only one guard to `lukk-jwt`, since a second one with no `lukk.guards` block is refused at boot (below).

## The problem it solves

Point two guards at the `lukk-jwt` driver naively and they'd share one secret + issuer + audience, differing only by which table the subject id is looked up in. An admin token (`sub=5`) would then verify fine on the users guard and resolve `User::find(5)` — **account takeover by subject-id collision**. lukk closes this by giving each guard a distinct, validated **audience** (the [RFC 8725 §3.9](https://www.rfc-editor.org/rfc/rfc8725.html#section-3.9) / [OWASP ASVS 5.0](https://github.com/OWASP/ASVS) §9.2.3–9.2.4 control), rejecting a foreign token **before** any user is resolved. The naive setup isn't left to chance either: a `lukk-jwt` guard in `config/auth.php` with no `lukk.guards` block of its own would inherit the default guard's secret *and* audience, so lukk refuses to boot until you give it one.

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

The **default** guard is the exception to "lukk reuses the `provider`": sign-in checks its passwords against [`lukk.user_provider`](/configuration#guard-provider), while the guard resolves each token's `sub` through `auth.guards.<default>.provider` (or, naming none, `auth.defaults.provider`). The two must read the same users — pointed at different ones, a `users` password would mint a token for the `admins` row with the same id — so from lukk 0.7.0 the application refuses to boot until they agree, naming both settings. What is compared is the users each provider reads, not its name: two provider names over the same users boot — the same `model` under the `eloquent` driver (`api_users` and `users`, both over `App\Models\User`), or the same `table` on the same `connection` under `database`. A provider with any other driver boots only if its whole `auth.providers` entry is identical to the other's, and one that is unconfigured or names no model or table is never taken for the same. The default configuration (`users` on both sides) is unaffected.

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

Everything the guard doesn't declare is **inherited** from the top-level config (ttls, features, cookie, …). The **top-level config is the default guard** (`config('lukk.guard')`, `api`), unchanged — configure it there, never as an entry under `guards` (lukk refuses to boot on one: its overrides would be ignored while still switching multi-guard mode on).

`audience` is taken as written here. Unlike the top-level `LUKK_AUDIENCE`, a per-guard `env()` value is not split on commas, so `LUKK_ADMIN_AUDIENCE=a,b` is one audience named `a,b` — list several as an array (`'audience' => ['https://admin.example.com', 'https://ops.example.com']`).

A guard can harden itself — say, an admin guard with the [account lockout](/account-lockout) on and tighter login caps:

```php
'admin' => [
    // …
    'features' => ['lockout' => true],
    'lockout' => ['max_attempts' => 10],
    'rate_limits' => [
        'login' => ['max_attempts' => 3, 'account_max_attempts' => 10],
        'two_factor' => ['max_attempts' => 3],
    ],
],
```

From lukk 0.7.0 `features.lockout`, the `lockout` block, `rate_limits.login.*` and `rate_limits.two_factor.*` are read **per guard**. Earlier releases read them from the global block, so an override like this was silently ignored. The same release reads these per guard too: `features.logout_all`, `features.two_factor` (where only an explicit `false`, `0` or `'0'` switches enforcement off), `email_verification.block_unverified_login`, `cookie_mode` when logout clears the cookie, `claim_seconds`, `login_timebox_micros`, `confirm.mfa_max_age`, `two_factor.challenge_ttl`, `confirm.ttl` and `confirm.header` — the last being the header of the guard that authenticated the request, so a guard with its own needs its clients to send the confirmation there.

Generate a per-guard secret:

```bash
php artisan lukk:secret --guard=admin   # writes LUKK_ADMIN_SECRET to .env
```

The guard name becomes part of an env variable name (`-` turns into `_`, letters are uppercased), so the command refuses a name that contains anything other than letters, digits, `_` and `-` (lukk 0.7.0) rather than write a line that could clobber another guard's.

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
> **Enabling multi-guard on an existing single-guard app?** Its existing rows have `guard = NULL`, but once you configure guards every guard — the default one included — stamps its name on what it writes and reads only its own rows. So backfill first: unbackfilled sessions log out once, and unbackfilled [passkeys](/passkeys) go dark — they can't be asserted, listed, erased or pruned until they carry a guard name:
> ```sql
> UPDATE refresh_tokens SET guard = 'api' WHERE guard IS NULL;  -- 'api' = your config('lukk.guard')
> UPDATE passkeys       SET guard = 'api' WHERE guard IS NULL;
> ```
>
> **Removing a guard needs the opposite cleanup, and it fails open.** Once `lukk.guards` is empty again no scope is applied at all, so rows still stamped with the departed guard become visible to the default guard — for passkeys that lookup is the sign-in decision, so the removed guard's authenticator would log in as whichever account holds the same id in the default provider. Delete or re-home those rows **before** dropping the guard:
> ```sql
> DELETE FROM passkeys       WHERE guard = 'admin';
> DELETE FROM refresh_tokens WHERE guard = 'admin';
> ```
> The full text is in [lukk UPGRADE.md](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md#upgrading-to-060-from-05x).

## What you get

lukk auto-mounts each guard's **core session** routes under its `path` (+ `domain`), wired to `auth:{name}` and that guard's crypto identity:

```
GET    admin/auth/jwks
POST   admin/auth/login      admin/auth/refresh      admin/auth/logout
POST   admin/auth/session/claim                      admin/auth/confirm-password
DELETE admin/auth/sessions   admin/auth/sessions/others
POST   admin/auth/two-factor-challenge               (only while that guard enforces two-factor)
```

`DELETE admin/auth/sessions` follows the guard's own `features.logout_all`. `two-factor-challenge` is mounted on the same rule login challenges on, so an enrolled account is never challenged without somewhere to answer; the two-factor *management* routes, passkeys, registration and the other features stay on the default guard.

Some settings have no per-guard reading at all, because the feature they configure runs on the default guard: `registration.login`, every `password_reset.*` key, and `email_verification.frontend_url` and `email_verification.expire`. A value for them under `lukk.guards.{name}` is ignored. The email verification link, likewise, looks its user up through the **default** guard's user provider.

Protect admin routes with `auth:admin`; they resolve against the `admins` table with the admin token identity.

## The isolation guarantees

- **Token identity.** A token minted for `admin` is rejected by the `users` guard on the **audience** check — and the **signature** too, if you gave it a separate secret. The rejection happens *before* the user is resolved, so it can never look up the wrong table.
- **Refresh + revocation.** Refresh-token families are scoped by a `guard` column. Rotating an admin refresh token on the users refresh endpoint fails (not found); `revokeAllSessions()` on `admin` id `5` leaves the users guard's id `5` sessions **untouched**.
- **Revocation can't cross.** The denylist is shared but keyed by `jti`/`fid` (UUIDs), so admin revocation only evicts admin families — a user's tokens are a different family and are never affected.
- **[Passkeys](/passkeys) are guard-scoped too** (a `guard` column, as of `0.6.0`). This one matters most: the assertion lookup takes a credential id and *no* user, so it is the authentication decision itself — unscoped, an admin's authenticator resolved on the users guard. It also keeps [erasure and export](/account-deletion) off a colliding account's credentials. Registering a credential for a non-default guard outside lukk's own routes must set the active guard first (`Lukk::useGuard('admin')`), or the row lands on the wrong one.
- **[Lockout](/account-lockout) counters** are guard-scoped, so a flood against one guard's login can't lock a colliding account out of another.

### Separate keys vs. a shared secret

Per the standards, a **shared secret + distinct audience is a fully compliant control** (ASVS §9.2.4; RFC 8725 lists key-separation and audience-differentiation as co-equal). Separate per-guard `secret`/keys are the stronger **defense-in-depth** option. Either way, the **audience is what isolates the tokens**, so lukk **refuses to boot** unless every guard declares a distinct, non-empty audience and mounts at a distinct path/domain — and unless every extra guard is declared in `config/auth.php` with the `lukk-jwt` driver, every `lukk-jwt` guard there has a `lukk.guards` block (the default guard excepted), and no block is named after the default guard. A numeric guard name, or a list of names instead of a `name => [...]` map, is refused too (lukk 0.7.0).

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
- Per-guard email verification, password reset and passkeys aren't wired to extra guards yet — those features run on the default guard. Two-factor is split: a guard whose config enables it gets its own `two-factor-challenge` route, so a challenged login can complete there, but enrolment and management (which need step-up) stay on the default guard.

## Cookie mode across guards

In [cookie mode](/transport-modes#direct-mode) each guard gets its **own** refresh cookie: the default guard keeps `__Host-refresh`, and every other guard is suffixed with its name (`__Host-refresh-admin`). Guards may legitimately share a host and differ only by path, and a single cookie name at `Path=/` meant logging into one silently overwrote the other's cookie — each login destroying the other session.

Per-guard `cookie_mode`, `refresh_ttl` and `cookie.*` overrides are honoured too, so a short-lived admin session can sit alongside a long-lived user one:

```php
'guards' => [
    'admin' => [
        'audience' => ['https://admin.example.com'],
        'refresh_ttl' => 60 * 60 * 8,   // 8 hours, vs the default guard's 30 days
    ],
],
```

Next: **[Security](/security)**
