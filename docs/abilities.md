# Abilities (Scopes)

Coarse, stateless authorization carried **in the access token**. `Lukk::abilitiesUsing()` decides what a user's tokens may do, `lukk.ability:` gates a route on it, and `$user->tokenCan()` answers the same question in your own code.

It is **inert until you configure it**: without a callback no `scope` claim is minted at all, and tokens stay byte-identical to 0.5.0. Once configured it is **deny by default** — a token with no `scope` grants nothing.

The wire format is the registered `scope` claim, space-delimited ([RFC 6749 §3.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.3), [RFC 9068 §2.2.3](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2.3)), so an API gateway or a non-lukk verifier can read it without knowing anything about lukk.

> [!WARNING]
> **Scope says what a *token* may do, never which *records* it may touch.** `orders.read` does not mean "these orders". Per-object authorization stays your Policies and Gates — this is deliberately the coarse half, and confusing the two is [OWASP API1 (BOLA)](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/).

## Setup

```php
// app/Providers/AppServiceProvider.php
use Lukk\Lukk;

public function boot(): void
{
    Lukk::abilitiesUsing(fn ($userId, $context) => User::find($userId)->permissionNames());
}
```

Then gate a route:

```php
Route::middleware(['auth:api', 'lukk.ability:orders.read,orders.write'])   // ANY of them
    ->get('/orders', [OrderController::class, 'index']);

Route::middleware(['auth:api', 'lukk.abilities:orders.read,orders.write']) // ALL of them
    ->post('/orders', [OrderController::class, 'store']);
```

The two aliases mirror Sanctum's split, so the semantics are the ones you already expect. In your own code:

```php
if ($request->user()->tokenCan('orders.write')) {
    // ...
}
```

## Naming abilities

> [!IMPORTANT]
> **Name abilities after resources, never after facts about a person.**
>
> An ability name is a public identifier. It travels in the `scope` claim of every access token — so every proxy, API gateway, APM and access log on the path sees it — it is published on the user resource, and it appears as a **literal string in your JavaScript bundle**, which anyone can download.
>
> `hiv_clinic.records.read` is a special-category disclosure at each of those hops. `clinic_a.records.read` is not. lukk validates the *syntax* of a name and can say nothing about its meaning.

Names must be valid RFC 6749 scope tokens: no space, `"`, `\`, control characters or non-ASCII bytes. lukk also rejects a comma, because `lukk.ability:a,b` uses it as a list separator — an ability named `orders,read` could be minted but never required. A malformed name **throws** at issue time rather than being dropped, because the claim is space-delimited and `['orders.read admin']` would otherwise parse back as two abilities and grant an `admin` nobody issued.

Abilities are bounded at 128 bytes each and 2048 bytes per claim. The claim rides in an `Authorization` header on every request; past roughly 8 KB proxies start rejecting it, and that failure only shows up in production.

## Wildcards

Two, and both only ever appear in the **grant**:

| Grant | Matches | Does not match |
|---|---|---|
| `*` | everything | — |
| `orders.*` | `orders.read`, `orders.read.all` | `orders`, `ordersX.read` |

A wildcard is never honoured in the **check**: `tokenCan('orders.*')` asks whether the literal ability `orders.*` was granted, so a caller cannot widen their own question. Matching is case-sensitive — scope tokens are opaque strings, so `Orders.Read` and `orders.read` are different abilities.

`orders.*` deliberately excludes the bare `orders`: a prefix grant is about what lives *under* the namespace, and including the namespace itself would make `orders.*` and `orders` indistinguishable to anyone reading a policy.

## The context argument

The second argument is a `TokenContext`:

```php
Lukk::abilitiesUsing(function (int|string $userId, TokenContext $context) {
    // $context->guard     — which guard this token is being minted for
    // $context->userId    — the subject
    // $context->familyId  — the session, stable across every rotation

    return $context->guard === 'admin'
        ? Admin::find($userId)->permissionNames()
        : Customer::find($userId)->permissionNames();
});
```

A multi-guard install serves different audiences often enough that `['*']` for a customer token and `['*']` for an admin one are not the same grant. It is an object rather than more positional parameters so a future field won't break callbacks already written.

> [!WARNING]
> **The callback runs on every mint — every login and every refresh — and must be a fast, local, side-effect-free read.**
>
> It runs *outside* lukk's refresh transaction, so a slow lookup can't extend a row lock and an error it swallows can't poison lukk's transaction. It may still throw: that fails the refresh cleanly, before the presented token has been consumed. Read your permission store, return names, do nothing else.

Returning an array, a `Collection`, or a single string all work. Return `['*']` for an unrestricted token.

## Derived vs pinned grants

By default abilities are **derived** — re-evaluated on every mint. Revoking one takes effect within `access_ttl` rather than lasting the life of the refresh token, which is the reason they aren't frozen at login.

A session can instead own a **fixed** grant, for the cases where the *token* is the principal rather than the user:

```php
use Lukk\Actions\StartSession;
use Lukk\Support\Abilities;

// A personal access token: this token can deploy, and nothing else — forever.
$pair = app(StartSession::class)($user->getKey(), [], ['ci.deploy']);

// An impersonation session capped below what the target user can actually do.
$pair = app(StartSession::class)($user->getKey(), [], ['orders.read']);
```

A pinned grant is stored on the `refresh_tokens` row and replayed verbatim through every rotation, so it never widens to the subject's current permissions. It also stamps a `pin` claim, which is how lukk's own routes tell a machine token from a human session.

| | Derived (default) | Pinned |
|---|---|---|
| Source | `abilitiesUsing`, per mint | the list you passed to `StartSession` |
| Revoking an ability | takes effect within `access_ttl` | never — the grant is fixed |
| Storage | none | `refresh_tokens.scope` |
| `pin` claim | absent | `true` |
| lukk's own session routes | ungated | gated (below) |

Pinning requires the `scope` column — see [Upgrading](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md).

## lukk's own routes

A token pinned to `['ci.deploy']` is refused by every gated route in *your* application — but lukk's own routes were gated on authentication alone, so it could still log the account out everywhere. Two of lukk's abilities close that:

| Ability | Required by | For |
|---|---|---|
| `lukk.sessions` | `DELETE /auth/sessions`, `DELETE /auth/sessions/others` | revoking **other** sessions |
| `lukk.account` | `POST /auth/confirm-password`, `POST /auth/confirm-passkey`, `POST /auth/password` | step-up, and changing the password |

Both step-up routes are gated, not just the password one — `confirm-passkey` is the other way in, and gating only the password path would make the gate decorative for any account with a passkey enrolled.

`lukk.account` covers step-up because step-up is the gateway to everything that takes an account over permanently — enrolling a passkey, disabling two-factor, regenerating recovery codes. All of it needs the password, so a pinned token could never do it silently; but *"a machine token must not log the account out everywhere"* and *"a machine token may enrol a permanent authenticator"* cannot both be the rule.

**Only pinned tokens are gated.** A derived grant is a live human login and is never affected, so enabling abilities breaks nothing — and you don't need to add `lukk.sessions` to a normal user's grant. If a machine token genuinely needs these, pin them:

```php
$pair = app(StartSession::class)($user->getKey(), [], ['ci.deploy', Abilities::SESSIONS]);
```

`POST /auth/logout` and `POST /auth/refresh` are never gated: they act on the calling session alone, and a pinned token has to be able to end and renew itself. Set `features.gate_auth_routes` to `false` to switch the whole thing off.

## Responses

| Situation | Status | |
|---|---|---|
| No credential reached the gate | `401` | so a client learns it needs to log in, rather than giving up |
| Authenticated, insufficient scope | `403` | with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` ([RFC 6750 §3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1)) |

A refusal dispatches `Lukk\Events\TokenAbilityDenied`, carrying the subject, guard, family and the **route's** requirement — never the caller's granted list. A token probing for what it can still reach looks exactly like a run of these, and it is the only lukk-side signal that one is. Deliberately an event rather than a log line: ability names travel widely enough already.

## On the client

lukk's `UserResource` publishes the token's abilities, which is the only channel a BFF-mode client has — the browser never sees the access token that carries the claim.

```ts
const { can, cannot, canAny, canAll, enforced } = useLukkAbilities()
```

```vue
<button v-if="can('orders.write')">New order</button>
```

> [!WARNING]
> **These are UI hints, never enforcement.** The server gates every request on the token itself; this only lets you avoid rendering a button that comes back 403. A client-side check is one devtools console away from being true.

**Absent and empty mean different things.** No `abilities` key means "this server doesn't use abilities" and `can()` returns `true` — so an app that upgrades without opting in doesn't find its UI blanked. An empty array means "in use, and this token was granted nothing", and `can()` returns `false`. `enforced` tells the two apart. A malformed value fails closed, and a logged-out visitor is granted nothing.

The client matcher mirrors the server's rules exactly, and lukk's conformance suite runs both against the same gates on a live instance and requires them to agree, so the two cannot drift.

## Multiple guards

`features.abilities` and `features.gate_auth_routes` are read through the **active guard's** resolved config, so you can enable either for one guard alone:

```php
'guards' => [
    'admin' => [
        // ...
        'features' => ['gate_auth_routes' => true],
    ],
],
```

## Feature flag

Configuring `abilitiesUsing` turns abilities on by itself, so most installs never touch this. Set it when grants come **only** from pinned sessions and there is no callback at all:

```php
'features' => [
    'abilities' => true,
],
```

Without it lukk cannot distinguish a token pinned to *nothing* from a server that doesn't use abilities, and a client would render the full privileged UI for the most restricted token you can issue.

Next: **[Multiple Guards](/multiple-guards)**
