# Customization

lukk follows the Sanctum pattern: every moving part is either a **contract bound to a default** (rebind it in a service provider) or a **closure hook** on the static `Lukk` class (register it from a service provider's `boot` method). You never edit the package. This page is server-focused.

## The Lukk hub

The `Lukk` class is a static configuration hub, like `Sanctum`. Register hooks from the `boot` method of a service provider (for example `App\Providers\AppServiceProvider`):

```php
use Lukk\Lukk;

public function boot(): void
{
    Lukk::authenticateUsing(/* ... */);
    Lukk::tokenClaimsUsing(/* ... */);
    Lukk::useRefreshTokenModel(/* ... */);
}
```

The full set of hooks:

| Hook | What it replaces | See |
|---|---|---|
| `authenticateUsing(Closure)` | The credential check at login | [below](#custom-login-logic) |
| `tokenClaimsUsing(Closure)` | Adds custom claims to every access token | [below](#custom-token-claims) |
| `abilitiesUsing(Closure)` | The derived ability grant, per mint | [Abilities](/abilities#setup) |
| `rateLimitKeyUsing(Closure)` | The identity every throttle buckets on | [below](#lukk-ratelimitkeyusing) |
| `registerUsing(Closure\|string)` | The user create at `POST /auth/register` | [Registration](/registration#customizing-the-user-s-fields) |
| `registerValidation(Closure)` | The registration rules | [Registration](/registration#customizing-the-user-s-fields) |
| `deleteUserUsing(Closure)` | Disposing of the user row at erasure (e.g. anonymize) | [Account deletion](/account-deletion#anonymizing-instead-of-deleting) |
| `useRefreshTokenModel(string)` | The refresh-token Eloquent model | [below](#swapping-the-refresh-token-model) |
| `disableScheduling()` | lukk's own `lukk:prune` schedule, so you set the cadence | [Deployment](/deployment) |
| `actingAs($user, $guard, $abilities)` | Authenticates a user in your own tests | — |

And a few read-only helpers, for code of your own that must agree with lukk:

| Helper | Answers |
|---|---|
| `Lukk::rateLimitKey(Request)` | The throttle identity lukk uses for this request (your `rateLimitKeyUsing` result, or the normalized address) — key your own limiters on it. |
| `Lukk::usesAbilities(?string $guard)` | Whether abilities are in use on that guard: a callback is set **or** `features.abilities` is on. Not the same as "is `abilitiesUsing` set" — a pinned-grant-only install has no callback. |
| `Lukk::enforcesTwoFactor(?string $guard)` | Whether an enrolled second factor is challenged on that guard — `true` unless `features.two_factor` is explicitly `false`/`0`/`'0'` (unset fails closed). |
| `Lukk::currentGuard()` / `Lukk::onGuard($name, $callback)` / `Lukk::useGuard($name)` | The lukk guard active for this request; run a callback with another active (restored afterwards); set it outright, as lukk's per-guard route middleware does. See [Multiple guards](/multiple-guards). |

## Custom login logic

By default lukk validates the `email` and `password` against your configured user provider. To take full control — extra conditions, a different credential field, a "must be active" check — pass a closure to `authenticateUsing`. Return the authenticated user, or `null` to reject:

```php
use Illuminate\Http\Request;
use Lukk\Lukk;

Lukk::authenticateUsing(function (Request $request) {
    $user = User::where('email', $request->input('email'))->first();

    if ($user && Hash::check($request->input('password'), $user->password) && $user->is_active) {
        return $user;
    }

    return null;
});
```

> [!WARNING]
> If your callback authenticates on a **different field**, set `lukk.username` to match it. The login throttle and the [account lockout](/account-lockout) both key on that field — with a mismatch the lockout never sees an identifier to count and silently does nothing.


The login **throttle** still wraps your closure — failed attempts are rate-limited exactly as on the default path — and so does the [sign-in timebox](/configuration#sign-in-timebox) (lukk 0.7.0): a failed attempt is padded to `login_timebox_micros` whatever your closure did. **Equal work** is still *your* responsibility, though: the package's unknown-user equalizer (one key derivation on every failing path) only runs on the built-in path, and the box pads a fast failure but never shortens a slow one. A closure that does `User::where(...)->first()` and hashes only when the user exists stays inside the box only while one hash is shorter than the budget — make it do the same work either way, e.g. always run a `Hash::check` against a dummy hash when no user is found.

Two more things move to your side with a closure. lukk's re-read that shuts out a sign-in racing a [password change or reset](/security#login-responses) takes its baseline from the stored password read right *after* your callback returns (the model you return may not have it loaded), so a change landing before that read isn't caught. And the bcrypt 72-byte refusal at sign-in (see [Password policy](/security#password-policy)) is the built-in path's; your closure decides for itself.

## Custom token claims

Add custom claims — roles, a tenant id, anything your API needs — to every access token. The closure receives the user id and returns an array of claims:

```php
use Lukk\Lukk;

Lukk::tokenClaimsUsing(fn ($userId) => [
    'roles' => User::find($userId)->roles->pluck('name'),
]);
```

> [!NOTE]
> Your claims are merged in, but the standard claims (`sub`, `exp`, `iss`, `aud`, `jti`, `fid`, …) always win and cannot be overridden. So do the reserved claims `scope`, `pin` and (from lukk 0.7.0) `amr` and `auth_time`: a hook can neither forge an [authentication method](/tokens-and-rotation#the-amr-claim) the session never used nor erase the real one.

## Swapping the refresh token model

To use your own Eloquent model for refresh tokens (to add columns, relationships, or scopes), extend the base model and register it — the Sanctum approach:

```php
use Lukk\Lukk;
use App\Models\RefreshToken;

Lukk::useRefreshTokenModel(RefreshToken::class);
```

The model may live on its own connection (`protected $connection`). Rotation and bulk revocation open their transaction on that connection (lukk 0.7.0) — earlier releases opened it on the default one, so the row lock was taken in autocommit and released at once, and rotation and reuse detection were not atomic.

> [!NOTE]
> **`$timestamps = false` is safe here.** [`claim_seconds`](/configuration#refresh-behavior) recognises a session's original refresh token by its lineage — the row persisted with no predecessor — not by `created_at`, and the window itself is measured from the marker lukk wrote at sign-in. Timestamps are still worth keeping for the data-subject export, which reports when each session began.

## Swapping storage

Refresh-token **storage** sits behind `Contracts\RefreshTokenRepository`, separate from the rotation **policy** (which lives in `Actions\RotateRefreshToken`). To move storage from the database to Redis, bind your own implementation — the policy is untouched:

```php
use Lukk\Contracts\RefreshTokenRepository;
use App\Auth\RedisRefreshTokenRepository;

$this->app->bind(RefreshTokenRepository::class, RedisRefreshTokenRepository::class);
```

Four fields on `RefreshTokenRecord` carry policy that the repository is the only thing able to supply, and all of them fail quietly if you leave them out:

- **`original`** — whether this row is the family's first, the one you were handed with a `null` `$previousId`. It is how [`claim_seconds`](/configuration#refresh-behavior) recognises the refresh token the sign-in itself issued, and it is the field to return. It is a tri-state: leave it `null` ("I can't say") and lukk falls back to `createdAt`. Never answer `true` for a row you are unsure about — a successor reported as the original is a session in active use being logged out.
- **`createdAt`** — the row's creation time, and the fallback for `claim_seconds` when `original` is unknown. It only compares mint times, so a successor minted within a couple of seconds of the sign-in reads as the original; that tolerance is a fixed constant, deliberately not `leeway` (both timestamps come from the same server in one sign-in, so only write skew has to be absorbed). Leave **both** fields out and the revocation is disabled entirely (lukk logs one warning per worker process and carries on).
- **`scope`** — the family's pinned [ability](/abilities) grant. `null` and `''` are different answers: `null` means *derive the grant on every mint*, `''` means *pinned to nothing*. Round-trip the empty string. Collapsing the two lets the most restricted token in the system widen to its subject's full grant on the first refresh.
- **`amr`** (lukk 0.7.0) — the session's [authentication methods](/tokens-and-rotation#the-amr-claim). `persist()` takes a trailing `?string $amr = null`; store the string you are given and return it here, as you do `scope`. A repository that ignores it keeps the pre-0.7 behaviour: the claim is absent after the first refresh.

```php
public function persist(
    int|string $userId, string $familyId, ?string $previousId, string $tokenHash,
    int $expiresAt, ?string $scope = null, ?string $amr = null,
): void
```

PHP raises a fatal on a mismatched signature, so an implementation (or a `DatabaseRefreshTokenRepository` subclass overriding `persist()`) written for 0.6 fails at once rather than silently.

Two behaviours the signatures can't express:

- **`revokeUserFamilies()` / `revokeUserFamiliesExcept()` revoke by the ids they read**, never by the user again, and return exactly those ids. Revoking "every row for this user" in a second statement also catches a session that committed between the read and the update — under PostgreSQL READ COMMITTED or InnoDB — which is then revoked in the table but never denylisted or reported, and its user is signed out on the next refresh with nothing to show why.
- **A revoked row is dead.** `revokeFamily()` is family-wide, so a record carrying `revokedAt` means that family's revoke has already run, and lukk does no further work when one is presented.

## Reshaping responses

The token-bearing and branching responses are `Responsable` contracts. Rebind one to change the body shape, add headers, or switch between JSON and cookies:

```php
use Lukk\Contracts\LoginResponse;
use App\Http\Responses\MyLoginResponse;

$this->app->bind(LoginResponse::class, MyLoginResponse::class);
```

The response contracts are `LoginResponse`, `RefreshResponse`, `LogoutResponse`, `RegisterResponse`, `TwoFactorChallengeResponse` and `EmailVerificationResponse`. A contract exists only where the body is a genuine swap seam — it carries a token pair or a user resource, or it branches on the request (`EmailVerificationResponse` is a `204` for a JSON client and a redirect to `frontend_url` for a browser). Fixed acknowledgements and data reads (`{"status": "password-reset"}`, the passkey list, JWKS, the account export) return JSON directly; there is nothing to swap.

> [!WARNING]
> **`LogoutResponse` takes `bool $clearRefreshCookie` (lukk 0.7.0, default `true`), and a rebound implementation must honour it.** It is `false` when `POST /auth/logout` did not accept the refresh cookie from that request — none was presented, or the request had a shape a cross-site form could produce. Sending the clearing `Set-Cookie` anyway re-opens the forced-logout CSRF the check exists to close: a clearing cookie on a `204` is stored even after a fully cross-site top-level navigation, so any page could sign your visitors out.
>
> ```php
> public function __construct(private readonly bool $clearRefreshCookie = true) {}
> ```
>
> Read `cookie_mode` through `Lukk::guardConfig()` rather than the global config block, as the default does — read globally, a guard that opted into cookie mode is never sent the clear for the cookie its own login set.

> [!NOTE]
> **`DELETE /auth/sessions/others` no longer goes through `LogoutResponse`** (lukk 0.7.0). That route keeps the caller's session alive, while the contract's job is to end it — in cookie mode it cleared the caller's own refresh cookie, and the client could no longer refresh. It now answers a bare `204` directly: the same status and empty body as before, so no client changes, but a rebound `LogoutResponse` no longer applies there. It still shapes `POST /auth/logout` and `DELETE /auth/sessions`.

> [!NOTE]
> The default response shape is the contract the lukk-js clients consume. If you reshape it, keep the client in sync (or adapt it) so the two don't drift — see [Authentication](/authentication) and [Using lukk-core](/lukk-core).

## Swapping the issuer, verifier, or denylist

The cryptographic and revocation seams are contracts too. Rebind `Contracts\TokenIssuer` or `Contracts\TokenVerifier` to change how tokens are minted or validated (for example to move to RS256 — though that's built in; see [Deployment → Asymmetric keys](/deployment#asymmetric-keys)), or `Contracts\Denylist` to back revocation with something other than the cache.

## Available contracts

| Contract | Default | Responsibility |
|---|---|---|
| `TokenIssuer` | `FirebaseTokenIssuer` | Mints access tokens. |
| `TokenVerifier` | `FirebaseTokenVerifier` | Verifies access tokens and checks the denylist. |
| `RefreshTokenRepository` | `DatabaseRefreshTokenRepository` | Persists refresh tokens and families. |
| `Denylist` | `CacheDenylist` | Records and checks revoked `jti`/`fid` values. |
| `LoginResponse` / `RefreshResponse` / `LogoutResponse` | built-in | Shape the HTTP responses. |
| `RegisterResponse` | built-in | Shapes the [registration](/registration) response (token pair, challenge, or `201`). |
| `Http\Requests\RegisterRequest` | built-in | The registration rules. Bind a subclass overriding `rules()` (an alternative to `registerValidation()`); lukk's string/NUL/72-byte password checks still run after it. |
| `TwoFactorChallengeResponse` | built-in | Shapes the 2FA login challenge. |
| `EmailVerificationResponse` | built-in | Answers a verified link: `204` for JSON, a redirect to `frontend_url` for a browser. |
| `LockoutRepository` | `DatabaseLockoutRepository` | Stores the [account-lockout](/account-lockout) counters; also `forget()` for erasure and `summariesForSubjects()` for the export — called on whatever is bound, so answer `0` / `[]` for nothing stored. |
| `TwoFactorProvider` | `Google2FaTotpProvider` | Generates and verifies TOTP codes. |
| `WebAuthnCeremony` | `SpomkyWebAuthnCeremony` | Performs WebAuthn registration/assertion, and reports what an assertion proved. |
| `PasskeyRepository` | `DatabasePasskeyRepository` | Persists passkey credentials. |

Two more contracts describe your **user model** rather than a container binding: `TwoFactorAuthenticatable` (what the `HasTwoFactorAuthentication` trait provides for [two-factor](/two-factor-authentication)) and `HasTokenAbilities` (what the trait of the same name provides for [abilities](/abilities)). lukk only narrows to them in PHPDoc, so using the trait is enough; implementing the interface as well lets your own static analysis check it.

::: warning Implementing `WebAuthnCeremony` yourself (lukk 0.7.0)
`verifyAssertion()` returns a `Lukk\Support\PasskeyAssertion` (`signCount`, `userVerified`, `multiFactor`) instead of an `int`; it and `authenticationOptions()` take an optional `?string $userVerification` (`required`/`preferred`/`discouraged`, or `null` for your configured value), and there is a new `isMultiFactor(PasskeyRecord): bool`.

```php
public function authenticationOptions(string $challenge, array $allowCredentialIds, ?string $userVerification = null): array;

public function verifyAssertion(array $response, string $challenge, PasskeyRecord $stored, ?string $userVerification = null, int|string|null $owner = null): PasskeyAssertion;

public function isMultiFactor(PasskeyRecord $stored): bool;
```

**Enforce** `$userVerification` on the assertion, not only in the options — a step-up passes `required` when the account can reach AAL2. Report `multiFactor` true only when the assertion carries the UV flag **and** the credential was already `uvInitialized` before this ceremony; read that before verifying, because a WebAuthn library typically updates it as part of verification. lukk skips an enrolled TOTP on this answer. `isMultiFactor()` reports whether a stored credential has shown user verification, `false` when unknown. `$owner` is the account a step-up has already identified, or `null` at sign-in: pass it to your library as the expected user handle (WebAuthn L3 §7.2 step 6), so a returned `userHandle` naming another account is refused, and a non-discoverable key that omits it still works. A mismatched method is a fatal when your class loads, so it surfaces on the first passkey request rather than at boot.
:::

::: warning Implementing `PasskeyRepository` yourself (lukk 0.7.0)
`updateSignCount()` returns `bool` — whether the row was written:

```php
public function updateSignCount(string $credentialId, int $signCount): bool;
```

Make the write **forward-only** and conditional — update only while the stored counter is below `$signCount` — and report whether it moved. Of two concurrent assertions presenting the same counter, exactly one may win; lukk treats the loser's non-zero counter as one that did not advance, refuses it and fires [`PasskeyCloneDetected`](/events#passkeyclonedetected), as WebAuthn L3 §6.1.1 directs. Always answering `true` silently loses that check; always answering `false` refuses every non-zero counter.

**A rebound store is now called on every install.** Account [erasure](/account-deletion) (`deleteForUser()`), the [export](/account-deletion#the-export) (`summariesForUser()`) and a reset with [`revoke_passkeys`](/password-reset#session-revocation) (`summariesForUser()` + `delete()`) used to be skipped unless a table literally named `passkeys` existed, so a Redis or remote store was never reached: erasure reported success while the passkeys survived. They now call whatever is bound, so each method must answer an empty or not-yet-provisioned store without throwing — `[]` and `0`. The shipped `DatabasePasskeyRepository` answers an unpublished table itself, on its model's own connection and table name.
:::

::: warning Replacing `PasskeyRepository` or `RefreshTokenRepository` under multiple guards
Both are **guard-scoped**: an account is `(guard, id)`, not `id`, because [providers are separate tables](/multiple-guards) where `users.id === admins.id` is the ordinary case. Every method must honour that — including `findByCredentialId`, which takes a credential id and *no* user and is therefore the authentication decision itself.

The single exception is `PasskeyRepository::existsByCredentialId()`, which must be **unscoped**. `credential_id` is globally unique (WebAuthn requires it), so registration has to ask whether *any* guard holds an id before writing one; asking the scoped question instead lets a cross-guard duplicate reach the database constraint as a `500` rather than a clean validation error.

Bind a replacement with `bind`, not `singleton` — the active guard is per-request, and a memoized instance carries the previous request's guard into the next one.
:::

## `Lukk::rateLimitKeyUsing()`

Replace the identity every lukk throttle buckets on. The default is the caller's address, with IPv6 masked to [`rate_limits.ipv6_prefix`](/configuration#rate-limits); override it when the source address isn't the right bucket — a shared API gateway, a tenant, a CDN's own visitor token.

```php
use Illuminate\Http\Request;
use Lukk\Lukk;

Lukk::rateLimitKeyUsing(fn (Request $request) => 'tenant-'.$request->user()?->tenant_id);
```

The callback runs on every throttled request, so keep it cheap. The value must be **unforgeable** — it also buckets the login limiter, so a spoofable header would let an attacker mint a fresh bucket per request — and it is used verbatim as part of a cache key, so namespace anything untrusted. An empty return falls back to the address. Under a long-running worker (Octane) the closure outlives the request that registered it: derive everything from the `$request` argument, never capture it.

That's the whole customization surface. For the design rationale behind these seams, see [Architecture](/architecture); for the events lukk fires at the security-relevant moments, see [Events](/events). Questions or contributions are welcome on the [lukk](https://github.com/stsepelin/lukk) and [lukk-js](https://github.com/stsepelin/lukk-js) repositories.
