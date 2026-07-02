# Password Reset

lukk ships first-party password reset that fits the stateless-JWT model: a **reset link** the user requests when they're locked out, a page in your SPA that collects the new password, and — by default — a **revoke of every existing session** on success, so a session that predates the reset can't survive it. It's opt-in and rides Laravel's own password broker — there's **no lukk migration**. On the client, `useLukkPasswordReset` owns both steps: requesting the link and submitting the new password.

> [!NOTE]
> Password reset must be enabled on the server (`features.password_reset`). Both endpoints are **public** — the user is logged out — so there's no bearer token involved.

## Server (Laravel)

### How it works

Reset state is Laravel's own `password_reset_tokens` table, driven through the framework's **password broker** (`Password::broker()`). Your user model implements `Illuminate\Contracts\Auth\CanResetPassword` — the same contract Laravel's built-in reset already uses. lukk owns the **link target** and the **session revocation**, not the storage:

1. The user submits their email to `POST /auth/forgot-password`. lukk asks the broker to mint a token and email a reset link — and **always** returns a generic `200`, whether or not the email is registered (no user enumeration).
2. lukk points Laravel's `ResetPassword` notification at your SPA (`password_reset.frontend_url`), appending `?token=…&email=…`.
3. The user opens the link, enters a new password, and your page POSTs `{ token, email, password, password_confirmation }` to `POST /auth/reset-password`. lukk verifies the token through the broker, sets the new password, fires `Illuminate\Auth\Events\PasswordReset`, and — unless you've disabled it — **revokes every existing session** (refresh families + denylist).

There is **no auto-login**: reset succeeds, then the user logs in with their new password. That keeps the reset flow and the login flow (and its 2FA challenge) cleanly separated.

### Setup

Your user model must implement `CanResetPassword` (Laravel's default `App\Models\User` already `use`s the `Notifiable` trait and satisfies the contract via `Authenticatable`), you need the framework-default `password_reset_tokens` table, and a configured `auth.passwords` broker (both ship in a stock Laravel app). Then enable the feature:

```php
// config/lukk.php
'features' => [
    'password_reset' => true,
    // ...
],

'password_reset' => [
    'frontend_url' => env('LUKK_RESET_URL'), // e.g. https://app.example.com/reset-password
    'revoke_sessions' => true,                // kill existing sessions on reset (recommended)
    'broker' => null,                         // null = your app's default auth.passwords broker
],
```

Set `broker` (or `LUKK_RESET_BROKER`) only if you reset against a **non-default** `auth.passwords` broker — e.g. a separate admin guard with its own token table. `null` uses `config('auth.defaults.passwords')`.

The token's **lifetime** and **per-email throttle** come from the broker, not lukk — tune them in `config/auth.php`:

```php
// config/auth.php
'passwords' => [
    'users' => [
        'provider' => 'users',
        'table' => 'password_reset_tokens',
        'expire' => 60,   // token validity, minutes
        'throttle' => 60, // seconds between link requests for one email
    ],
],
```

No migration to publish — `password_reset_tokens` is a Laravel default.

### Endpoints

These routes are registered only when `features.password_reset` is enabled. Both are public and throttled by the `lukk-password-reset` limiter (`rate_limits.password_reset`, a per-IP guard).

| Method | Path | Middleware | Purpose |
|---|---|---|---|
| `POST` | `/auth/forgot-password` | throttle | Email a reset link. Body `{ email }`. Always `200` (no enumeration). |
| `POST` | `/auth/reset-password` | throttle | Set the new password. Body `{ token, email, password, password_confirmation }`. `200` on success, `422` on a bad/expired token or a weak/mismatched password. |

The new password is validated with Laravel's `Illuminate\Validation\Rules\Password::defaults()`, so you can tune complexity rules app-wide the usual way.

### Session revocation

The lukk-specific value-add: on a successful reset, `revoke_sessions` (default `true`) runs `RevokeAllSessions` for the user — revoking every refresh-token family and denylisting outstanding access tokens. A password reset almost always means "I lost control of this account," so **killing the pre-existing sessions is the safe default** (an attacker holding a stolen refresh token is logged out the moment the real owner resets).

Set it to `false` only if you have a specific reason to keep other sessions alive across a reset:

```php
'password_reset' => ['revoke_sessions' => false],
```

### Security notes

- **No user enumeration.** `forgot-password` returns the same `200` for a registered and an unknown email, and the per-email `throttle` is enforced by the broker — so the endpoint can't be used to probe which addresses have accounts. `reset-password` is hardened the same way: every failure (unknown user, bad/expired token, throttled) returns one **generic** `422`, so it never reveals whether an email is registered either.
- **Single-use, expiring tokens.** The reset token is broker-managed: hashed at rest, consumed on success, and invalid after `expire` minutes.
- **Flatten the timing.** The response body is identical for known and unknown emails, but a registered address does extra work (mint a token, send the mail) before responding. Run mail on a queue (`QUEUE_CONNECTION` other than `sync`, or a `ShouldQueue` notification) so `forgot-password` returns before the email is sent and the two paths take the same time.
- **Sessions die by default.** `revoke_sessions` closes the "attacker keeps their session after the owner resets" hole — see above.
- **No auto-login, no token leak.** Reset never mints tokens; the user re-authenticates through the normal login flow. Nothing secret is placed in the redirect URL beyond the broker's own reset token.

## Client (Nuxt)

`useLukkPasswordReset()` owns both steps of the flow — requesting the link and submitting the new password — with a `sending`/`resetting` flag for each so you can disable buttons while a request is in flight. Both calls route through your configured transport (BFF proxy or direct), identically.

### The flow

1. On your "forgot password" page, call `sendResetLink(email)`. It always resolves (even for an unknown address — the server doesn't enumerate), so show a generic "check your inbox" message regardless.
2. The email link lands on your SPA reset page carrying `?token=…&email=…`. Read those from the route, collect a new password, and call `reset({ token, email, password, password_confirmation })`.
3. On success, send the user to your login page — there's **no auto-login**; they sign in with the new password (and lukk has revoked any pre-existing sessions by default).

### The composable

```ts
const { sending, resetting, sendResetLink, reset } = useLukkPasswordReset()
```

| Member | Type | What it is |
|---|---|---|
| `sending` | `Ref<boolean>` | True while the reset-link request is in flight — bind a button's `disabled` to it. |
| `resetting` | `Ref<boolean>` | True while the reset submission is in flight. |
| `sendResetLink(email)` | `(email: string) => Promise<void>` | Ask lukk to email a reset link. Always resolves (no enumeration; throttled). |
| `reset(input)` | `(input: ResetPasswordInput) => Promise<void>` | Submit the token, email, and new password. Rejects with a `LukkError` (`422`) on a bad token or weak/mismatched password. |

### The request page

```vue
<!-- pages/forgot-password.vue -->
<script setup lang="ts">
const { sending, sendResetLink } = useLukkPasswordReset()
const email = ref('')
const sent = ref(false)

async function submit() {
  await sendResetLink(email.value)
  sent.value = true // generic — we don't reveal whether the address exists
}
</script>

<template>
  <form v-if="!sent" @submit.prevent="submit">
    <input v-model="email" type="email" required>
    <button :disabled="sending">Email me a reset link</button>
  </form>
  <p v-else>If that address has an account, a reset link is on its way.</p>
</template>
```

### The reset page

Point lukk's `password_reset.frontend_url` at a page in your app (e.g. `/reset-password`). Read `token` + `email` from the query, collect the new password, and submit:

```vue
<!-- pages/reset-password.vue -->
<script setup lang="ts">
import type { LukkError } from 'lukk-core'

const route = useRoute()
const { resetting, reset } = useLukkPasswordReset()

const password = ref('')
const passwordConfirmation = ref('')
const error = ref('')

async function submit() {
  error.value = ''
  try {
    await reset({
      token: String(route.query.token ?? ''),
      email: String(route.query.email ?? ''),
      password: password.value,
      password_confirmation: passwordConfirmation.value,
    })
    await navigateTo('/login?reset=1') // no auto-login — sign in with the new password
  }
  catch (e) {
    // 422: bad/expired token or a weak/mismatched password. `LukkError` also carries a
    // Laravel `errors` bag ((e as LukkError).errors?.password?.[0]) for field-level messages.
    error.value = (e as LukkError).message
  }
}
</script>

<template>
  <form @submit.prevent="submit">
    <input v-model="password" type="password" required>
    <input v-model="passwordConfirmation" type="password" required>
    <button :disabled="resetting">Set new password</button>
    <p v-if="error">{{ error }}</p>
  </form>
</template>
```

> [!NOTE]
> Because a successful reset **revokes existing sessions** by default, any other logged-in device is signed out — the reset page's own session (if any) included. That's intentional: route to login afterwards.

Next: **[Confirmation](/confirmation)**
