# Email Verification

lukk ships first-party email verification that fits the stateless-JWT model: a **signed link** the user clicks from their inbox, a **resend** endpoint, and a gate for routes that require a verified address. It's opt-in and rides Laravel's framework defaults — there's **no lukk migration**. On the client, `useLukkEmailVerification` owns the resend and the post-redirect sync; the verification click itself happens in the browser, straight from the email.

> [!NOTE]
> Email verification must be enabled on the server (`features.email_verification`). The client is the driver for it.

## Server (Laravel)

### How it works

Verification state is Laravel's own `users.email_verified_at` column, and your user model implements `Illuminate\Contracts\Auth\MustVerifyEmail` — the same contract Laravel's `verified` middleware and `Verified` event already use. lukk owns the **link** and the **gate**, not the storage:

1. Your app creates the user and triggers the verification email (Laravel's `Registered` event, or `$user->sendEmailVerificationNotification()`).
2. lukk points that notification at a **signed, expiring** URL on its own route (`GET /auth/email/verify/{id}/{hash}`).
3. The user clicks it. lukk validates the signature + the `{id}`/`{hash}` binding, marks the email verified, fires `Illuminate\Auth\Events\Verified`, and **redirects to your SPA** (or returns `204` to a JSON client).

The verify link is a **browser navigation, not an XHR** — that's why the signature is the authority (no session or bearer needed) and why the endpoint lives outside lukk's JSON-forcing group so it can redirect.

### Setup

Your user model must implement `MustVerifyEmail` (Laravel's default `App\Models\User` already `use`s the trait — just add the interface), and your `users` table must have the framework-default `email_verified_at` column (it does, in a stock Laravel app). Then enable the feature:

```php
// app/Models/User.php
use Illuminate\Contracts\Auth\MustVerifyEmail;

class User extends Authenticatable implements MustVerifyEmail { /* ... */ }
```

```php
// config/lukk.php
'features' => [
    'email_verification' => true,
    // ...
],

'email_verification' => [
    'frontend_url' => env('LUKK_VERIFY_URL'), // e.g. https://app.example.com/verify-email
    'expire' => 60,                            // signed-link validity, minutes
    'block_unverified_login' => false,         // see "Blocking unverified login"
],
```

No migration to publish — `email_verified_at` is a Laravel default.

### Endpoints

These routes are registered only when `features.email_verification` is enabled.

| Method | Path | Middleware | Purpose |
|---|---|---|---|
| `GET` | `/auth/email/verify/{id}/{hash}` | `signed` + throttle | The email-link target. Verifies, then redirects to `frontend_url` (browser) or returns `204` (JSON client). |
| `POST` | `/auth/email/verification-notification` | `auth` + throttle | Resend the verification link to the authenticated user (`202`). |

Both are throttled by the `lukk-email-verification` limiter (`rate_limits.email_verification`).

### Sending the first email

Registration is your app's job (lukk is not a registration package). After creating the user, trigger the notification the way you already would:

```php
event(new \Illuminate\Auth\Events\Registered($user));
// or
$user->sendEmailVerificationNotification();
```

Because the feature is on, lukk has repointed Laravel's `VerifyEmail` notification at its signed route, so the link in the email lands on lukk's endpoint and bounces the user back to your `frontend_url`. Your app's mail template and styling are unchanged.

### Gating routes

Attach the `lukk.verified` middleware to any route that needs a verified email:

```php
Route::middleware(['auth:api', 'lukk.verified'])->group(function () {
    // ...routes that require a verified email
});
```

An unverified user gets a **409 Conflict** (distinct from a plain authz `403`, so your client can prompt "verify your email" specifically). The check reads the user's current `hasVerifiedEmail()` each request — never a token claim — so a user who just verified is unblocked without re-logging-in.

### Blocking unverified login

By default an unverified user **logs in normally** and you gate the sensitive routes (`lukk.verified`) — the SPA-friendly model (show a "verify your email" banner, allow resend). If you'd rather refuse login outright, set:

```php
'email_verification' => ['block_unverified_login' => true],
```

Now login returns **403** for an unverified `MustVerifyEmail` user and issues no tokens. The check runs only *after* a successful credential check, so it never affects the constant-time unknown-user / wrong-password path.

### Split-domain (SPA / BFF)

The email link points at the **API** and redirects to your **SPA** (`frontend_url`), so it works in both direct and BFF deployments without a cross-origin round-trip:

- The user clicks the link → the browser navigates to the API → lukk verifies → redirects to `https://app.example.com/verify-email?verified=1`.
- Your SPA verify page then refreshes the session / reloads the user so the "unverified" UI clears.

> [!NOTE]
> **Exposing the verified state to the client.** the client reads `email_verified_at` (or a boolean `email_verified`) off your `user.endpoint` response to drive its `verified` state — so make sure your user resource **includes** that field. The optional [`Lukk\Http\Resources\UserResource`](/user) emits a derived `email_verified` boolean for you; a bare Eloquent model already serializes `email_verified_at`.

### Security notes

- The link is a **signed, temporary URL** (HMAC over your `APP_KEY`, expiring per `expire`), bound to the user's current email via the `sha1(email)` hash — so a tampered link, an expired link, or a link for an email that has since changed all fail (`403`).
- Verification is **idempotent** — a double-clicked link marks once and fires `Verified` once.
- The gate is **fail-fresh**: `lukk.verified` reads `hasVerifiedEmail()` off the resolved user, not a JWT claim, so it can't be stale.
- No secret is ever placed in a token or logged.

## Client (Nuxt)

`useLukkEmailVerification()` owns the two things the **client** does — resend the link, and reflect the user's verified state — while the verification click itself happens in the browser, straight from the email.

### The flow

Verification is a **browser navigation, not an XHR**: the link in the email points at lukk's signed API route, which verifies and then **redirects back to your SPA** (lukk's `email_verification.frontend_url`). So the client never posts the verification itself — it only:

1. **Resends** the link (`sendVerificationEmail()`), and
2. **Re-syncs** the user when they land back on your verify page (`syncAfterVerify()`), so `verified` flips and any "verify your email" banner clears.

This sidesteps the cross-origin-signature problem a fetch-relay through the BFF proxy would hit, and works identically in `direct` and `bff` modes.

### The composable

```ts
const { verified, sending, sendVerificationEmail, syncAfterVerify } = useLukkEmailVerification()
```

| Member | Type | What it is |
|---|---|---|
| `verified` | `ComputedRef<boolean>` | Whether the loaded user's `email_verified_at` is set. |
| `sending` | `Ref<boolean>` | True while a resend is in flight — bind a button's `disabled` to it. |
| `sendVerificationEmail()` | `() => Promise<void>` | Resend the link to the current user (a no-op server-side if already verified; throttled). |
| `syncAfterVerify()` | `() => Promise<void>` | Reload the user (used on the verify callback page). |

`verified` reads the same `useLukkAuth().user` you already load, so your `user.endpoint` must expose `email_verified_at` for it to reflect reality.

```vue
<script setup lang="ts">
const { verified, sending, sendVerificationEmail } = useLukkEmailVerification()
</script>

<template>
  <div v-if="!verified" class="banner">
    Please verify your email.
    <button :disabled="sending" @click="sendVerificationEmail">Resend link</button>
  </div>
</template>
```

### The verify callback page

Point lukk's `email_verification.frontend_url` at a page in your app (e.g. `/verify-email`). When the email link bounces the user here (with `?verified=1`), reload the user so the app reflects the new state:

```vue
<!-- pages/verify-email.vue -->
<script setup lang="ts">
const { verified, syncAfterVerify } = useLukkEmailVerification()

await syncAfterVerify() // re-fetch the user; `verified` becomes true
</script>

<template>
  <p v-if="verified">Your email is verified — you're all set.</p>
  <p v-else>We couldn't confirm that link. Try resending it.</p>
</template>
```

### Gating pages

To require a verified email before a page renders, use the **`lukk-verified`** route middleware (stack it after `lukk-auth`) — it redirects a logged-in, unverified user to `/verify-email`:

```ts
definePageMeta({ middleware: ['lukk-auth', 'lukk-verified'] })
```

Or branch on `verified` yourself, and lean on the server as the real enforcement: lukk's [`lukk.verified`](#gating-routes) middleware returns a **409** for unverified users, so an app-API call through [`useLukkFetch`](/use-lukk-fetch) to a gated route surfaces that status for you to handle.

Next: **[Confirmation](/confirmation)**
