# Change Password

The signed-in counterpart to [password reset](/password-reset): a user who is already authenticated and knows their current password can rotate it without an email round-trip.

`POST /auth/password` re-verifies the current password, applies your password rules to the new one, revokes every **other** session, and fires `PasswordChanged`. It's on by default and needs no configuration.

## Server (Laravel)

### Why it asks for the current password

This is the security story of the whole endpoint, so it's worth stating plainly: **a stolen access token must not be enough to take an account over permanently.**

An attacker holding a token already has the account until that token expires. If they could change the password with it, they'd have the account *forever* — and lock the real owner out. Requiring the existing password means the token alone isn't enough, and the real owner's reset flow still works.

That's also why the endpoint is metered the same way the login route is. See [Throttling](#throttling).

### Endpoint

| Method | Path | Middleware |
|---|---|---|
| `POST` | `/auth/password` | `auth` + `throttle:lukk-confirm` |

```http
POST /auth/password
Authorization: Bearer <access token>
Content-Type: application/json

{
  "current_password": "old-secret",
  "password": "new-secret",
  "password_confirmation": "new-secret"
}
```

```json
{ "status": "password-changed" }
```

| Status | Meaning |
|---|---|
| `200` | Changed. |
| `422` | Wrong `current_password`, mismatched confirmation, or the new password failed `Password::defaults()`. |
| `423` | The [account lockout](/account-lockout) is holding this account. |
| `429` | The step-up throttle is spent. |

The new password must **differ** from the current one — silently accepting a no-op would report success for a change that didn't happen, and this endpoint revokes every other session, which is a lot of collateral for nothing.

### What happens to other sessions

Every other session is revoked; **the one the change was made from survives.**

Changing a password is what someone does when they suspect another party is in the account, so leaving those sessions alive would defeat the point. But logging the user out of the tab they just did it in is a bad answer to a good instinct.

The session to keep is read from the caller's **own verified token**, not from the request body — so it can't be pointed at someone else's session to spare it from the sweep. Revocation goes through the denylist first, so the other sessions' access tokens stop working immediately rather than at the end of their TTL.

One edge worth knowing: a token carrying no `fid` — one minted by a co-issuer sharing your secret, in the [verify-only topology](/deployment#splitting-auth-and-api) — identifies no session here to preserve, so **every** session is revoked rather than none. Returning success while silently skipping the sweep would be the worse answer.

### Throttling

It runs on the **same budget as [step-up confirmation](/confirmation)** — the `lukk-confirm` limiter (`rate_limits.confirm`, default 5/60s) and, when [`features.lockout`](/account-lockout) is on, the same `confirm` counter.

That's deliberate. Both endpoints verify the same secret, so giving each its own allowance would simply mean twice as many guesses at one password.

A success clears **both** the `confirm` and the `login` counters. The failures they hold were against a password that no longer exists — and without releasing `login`, a user who was being brute-forced, noticed, and changed their password would still be locked out of login on every other device, with a password reset as the only way back.

### The event

```php
use Illuminate\Support\Facades\Event;
use Lukk\Events\PasswordChanged;

Event::listen(function (PasswordChanged $event) {
    $event->user->notify(new YourPasswordWasChanged);
});
```

Distinct from Laravel's `PasswordReset`, which fires for the forgot-password flow. Both are worth reacting to, but they say different things: one proves control of the email address, the other proves knowledge of the existing password. Users read *"your password was reset"* and *"your password was changed"* very differently — and an unexpected one of either is how account takeover gets noticed.

### Turning it off

```php
// config/lukk.php
'features' => [
    'change_password' => false,
],
```

On by default, like `logout_all`: it needs no configuration, and refusing a signed-in user the ability to change their own password isn't a sensible default. Turn it off where passwords live somewhere else — an identity provider, SSO, or your own endpoint that owns the column.

## Client (Nuxt)

### `useLukkChangePassword`

```ts
const { changing, changePassword } = useLukkChangePassword()

async function submit() {
  await changePassword({
    current_password: current.value,
    password: next.value,
    password_confirmation: confirm.value,
  })
}
```

| | |
|---|---|
| `changePassword(input)` | Sends the change. Rejects with a `LukkError` on failure. |
| `changing` | `true` while in flight — bind a submit button's `disabled` to it. |

A change made while one is already in flight is **refused without a request** (rejects with `status: 409`). That isn't just bookkeeping for `changing`: the second request would carry a `current_password` the first has already replaced, so lukk reads it as a wrong password and spends one of the account's [consecutive-failure attempts](/account-lockout) — a double-submit would quietly eat the user's lockout budget and report a `422` for a change that had just succeeded.

**Nothing else changes.** lukk keeps this session and revokes the others, so there's no token to swap and no re-login: the user stays where they are, and the other composables' state is already correct. That's why this composable is so small — a client that cleared session state here would log the user out of the tab they just secured.

### Showing validation errors

A `422` rejects with a `LukkError` carrying Laravel's bag, keyed by field:

```ts
import type { LukkError } from 'lukk-core'

const errors = ref<Record<string, string>>({})

async function submit() {
  errors.value = {}
  try {
    await changePassword({ /* … */ })
  }
  catch (e) {
    const bag = (e as LukkError).errors
    // `current_password` for a wrong password; `password` for a rule failure.
    if (bag) errors.value = Object.fromEntries(Object.entries(bag).map(([k, v]) => [k, v[0]!]))
  }
}
```

> [!NOTE]
> **[`useLukkForm`](/use-lukk-form) can't post here.** Its URLs resolve against your **app's** API base (`api.target`, or the proxy mount in BFF mode) — not lukk's auth base — so `form.post('/password')` would reach *your* `/password` route, not lukk's. That's by design: `useLukkForm` is for your own endpoints. lukk's auth endpoints are reached through the composables, which hold the right base.

In BFF mode the request goes through the proxy, so the browser still never holds a token.

Next: **[Step-Up Confirmation](/confirmation)**
