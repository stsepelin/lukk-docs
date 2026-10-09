# Registration

lukk ships a first-party `POST /auth/register` that mirrors login: it creates the user, fires Laravel's `Registered` event (so email verification can send its link), and returns the **same token pair a login yields** — so a new user is signed in immediately, exactly like logging in. It's opt-in, and you keep full control of the user's fields, validation, and creation. Without it, an app has to hand-roll a controller that calls `startSession()` and re-implements token emission, the 2FA / email-verification interception, and BFF/cookie handling; registration does all of that for you.

> [!NOTE]
> Registration must be enabled on the server (`features.registration`). You own the user's shape via `Lukk::registerUsing()` / `Lukk::registerValidation()`.

## Server (Laravel)

### How it works

Registration reuses the exact login machinery. `POST /auth/register`:

1. **Validates** the input (`RegisterRequest` — `name`, the identifier (`email` by default) and a confirmed password; customizable).
2. **Creates** the user — via your `Lukk::registerUsing()` hook, or the default (the configured model with `email` + a hashed `password`).
3. **Fires** `Illuminate\Auth\Events\Registered`, so — when `features.email_verification` is on and your model is `MustVerifyEmail` — the framework listener sends the (lukk-signed) verification link.
4. **Responds** the same way login does:
   - a **token pair** (auto-login), honoring BFF vs cookie mode, or
   - a **2FA challenge** if the new user is already enrolled (`{ two_factor: true, challenge_token }`), or
   - a **`201`** `{ registered: true, requires_verification: true }` with **no session** when `email_verification.block_unverified_login` is on — the user verifies their email, then logs in.

### Setup

Enable the feature:

```php
// config/lukk.php
'features' => [
    'registration' => true,
    // ...
],
```

The built-in default create works with the **stock Laravel `users` shape out of the box** — it writes `name` + the identifier (`email` by default) + a hashed `password`. If your table has a different shape (no `name`, extra columns, a `username`), point `Lukk::registerUsing()` at your own create (below); lukk doesn't presume your columns beyond the stock default.

Two settings tune the built-in flow:

```php
// config/lukk.php
'registration' => [
    'login' => true, // auto-login after registering (false → create-only, 201, sign in separately)
],

'username' => 'email', // the identifier column for login + registration (see "Username instead of email")
```

### Endpoints

Registered only when `features.registration` is enabled. Per-IP throttled by the `lukk-register` limiter (`rate_limits.registration`).

| Method | Path | Middleware | Purpose |
|---|---|---|---|
| `POST` | `/auth/register` | throttle | Create an account. Body `{ name, email, password, password_confirmation }` by default. |

**Responses** — identical to login, so a client treats a successful register exactly like a login:

- **`200`** with a token pair (`{ access_token, refresh_token?, expires_in }`; `refresh_token` only in BFF/body mode).
- **`200`** with `{ two_factor: true, challenge_token }` if the new user is already 2FA-enrolled — complete it at `/auth/two-factor-challenge`.
- **`201`** with `{ registered: true, requires_verification }` and no tokens, when the account can't log in yet — either `registration.login` is off (sign in separately; `requires_verification: false`) or `email_verification.block_unverified_login` is on (verify first; `requires_verification: true`).
- **`422`** on validation failure (including a duplicate identifier).

All responses are `Cache-Control: no-store`.

### Customizing the user's fields

Point `Lukk::registerUsing()` at a closure (or an invokable class-string) that creates and returns the new user. It receives the validated payload (with the **plaintext** `password` — hash it yourself) and must return a **brand-new** Authenticatable:

```php
use Illuminate\Support\Facades\Hash;
use Lukk\Lukk;

Lukk::registerUsing(function (array $input) {
    return User::create([
        'name' => $input['name'],
        'email' => $input['email'],
        'password' => Hash::make($input['password']),
    ]);
});
```

> [!WARNING]
> The hook must **create** a user — never return an existing one (e.g. `firstOrCreate`). lukk signs in whatever you return, so handing back an existing account would be a credential-free takeover. lukk guards the common Eloquent case (it rejects a returned model that wasn't just created), but keep your hook a pure create.

Declare the matching validation rules with `Lukk::registerValidation()` (or rebind `RegisterRequest` to a subclass):

```php
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password;
use Lukk\Support\HashablePassword;

Lukk::registerValidation(fn ($request) => [
    'name' => ['required', 'string', 'max:255'],
    'email' => ['required', 'string', 'max:255', 'email', Rule::unique(User::class)],
    'password' => ['required', 'confirmed', 'max:255', HashablePassword::rule(), Password::defaults()],
    // add a captcha field, a terms checkbox, etc.
]);
```

The default rules (`RegisterRequest`) are `name` (required), the identifier (a valid, **unique** address when it is `email`), and `password` (`confirmed`, at most 255 characters, meeting `Password::defaults()`). Tune password strength app-wide with `Password::defaults()` — see [Password policy](/security#password-policy).

A `registerValidation()` hook **replaces** the default rules, but while lukk's own create runs, lukk 0.7.0 still applies three password checks after yours: the password must be a string (an array used to `500` in the default create), contain no NUL byte (`Hash::make` throws on one — a `500` on a public route), and under bcrypt be at most 72 bytes — a `422` each. bcrypt reads only the first 72 bytes, so a longer password would be stored truncated and any string sharing that prefix would sign in (NIST SP 800-63B-4 §3.1.1.2); with Laravel's `hashing.bcrypt.limit` on it was a `500` instead. Other drivers pass the length check untouched.

**With a `registerUsing()` hook, the 72-byte rule is yours.** It is bcrypt's limit, and your hook may store the password its own way — or hand it to an identity provider that takes longer passphrases — so lukk leaves it out. The string and NUL-byte checks still apply (lukk 0.7.0), since any hook that hashes would `500` on either. List `HashablePassword::rule()` in your rules, as above, if you hash with bcrypt — otherwise a password over 72 bytes is stored truncated, and from lukk 0.7.0 its owner can't sign in with it until they [reset](/security#password-policy).

### Username instead of email

`lukk.username` (default `email`) is the identifier column, Fortify-style — it governs **both login and registration**. Set it once and the whole stack follows: the login/register request field, the constant-time credential lookup, the per-identifier login throttle, and the default create + validation all use that column.

```php
// config/lukk.php
'username' => 'username', // or env('LUKK_USERNAME')
```

Now `POST /auth/login` and `POST /auth/register` take `username` instead of `email` (registration validates it as a plain unique string rather than an email address). Your `users` table needs that column, and if you drop `email` entirely, make it nullable or use `Lukk::registerUsing()` for the create.

From lukk 0.7.0, while `app.debug` is on, sign-in refuses a `lukk.username` that names no column on the users table, and says what to fix. A typo is otherwise quiet on SQLite, which reads a double-quoted identifier matching no column as a string literal, so the lookup matches every row; PostgreSQL and MySQL answer it with an unexplained `500`. The check applies to the stock `EloquentUserProvider` only, and costs one schema read per sign-in in debug, and one class comparison and a config read in production. An unset, null or empty `lukk.username` falls back to `email`.

In every environment, lukk 0.7.0 also refuses a `lukk.username` that is not a plain column name (letters, digits and underscores) or that contains `password`, with an `InvalidArgumentException` naming the setting. Laravel's user provider drops any credential key containing `password`, so such a column looked nothing up and every sign-in failed as an ordinary `422`. A dotted name read nested request input and became a table-qualified column.

### Register-only (no auto-login)

By default a successful register signs the user in (returns a token pair). Set `registration.login` to `false` to **create the account only** — the endpoint returns a `201` and the user logs in separately:

```php
'registration' => ['login' => false],
```

Use this when you want a deliberate "account created → now log in" step, or a manual-approval flow. (Email verification has its own gate — `block_unverified_login` — which also withholds the session until the address is verified.)

### Customizing the response

`Contracts\RegisterResponse` is rebindable like the other response contracts — bind your own implementation to reshape the body or cookies:

```php
$this->app->bind(\Lukk\Contracts\RegisterResponse::class, MyRegisterResponse::class);
```

### Security notes

- **Passwords are hashed** (bcrypt via `Password::defaults()`), never stored or logged in plaintext; `confirmed` is enforced server-side, and the length is bounded (`max:255`) so an unauthenticated caller can't force unbounded verifier work.
- **Enumeration**: a registration form inherently reveals whether an identifier is taken (the `unique` rule → `422`). lukk adds no faster oracle — same status, same shape for taken vs. new beyond that rule.

> [!WARNING]
> **Add a captcha before you expose a public sign-up form.** The endpoint is per-IP throttled, but that alone does **not** stop a distributed attacker (rotating IPs, each under the cap) from mass-creating accounts and — when email verification is on — making your app **email arbitrary victim addresses** (a spam-relay / blacklisting risk). Add a captcha or proof-of-work as a field validated via [`registerValidation`](#customizing-the-user-s-fields), and keep the throttle.

- **Auto-login trusts an unverified identity.** With `registration.login` on (default) and email verification off, a successful register issues a **session for an unverified email/identifier** — enabling account squatting (registering someone else's address first). If any authorization keys off the identifier, enable [email verification](/email-verification) with `block_unverified_login` so the session is withheld until the address is proven.
- **No bypass**: registration runs the **same** 2FA and unverified-email checks as login before issuing a session — a new user can't skip a 2FA challenge or the `block_unverified_login` gate.

## Client (Nuxt)

The client exposes a `register()` that mints a session, parallel to `login()` — same transport (BFF or direct), same outcomes (token pair, 2FA challenge, or verify-first), so your sign-up form is as simple as your login form.

```ts
const { register } = useLukkAuth()

async function submit() {
  const result = await register({
    name: name.value,
    email: email.value,
    password: password.value,
    password_confirmation: passwordConfirmation.value,
  })

  if (result?.two_factor) {
    // new user is 2FA-enrolled — send them to your challenge screen (same as login)
  }
  else {
    await navigateTo('/dashboard') // signed in
  }
}
```

Because a successful register returns the same token pair as login, the session is established for you — no separate login call. When `block_unverified_login` is on, `register()` resolves without a session and the client surfaces the `requires_verification` signal so you can route to a "check your inbox" page; pair it with [`useLukkEmailVerification`](/email-verification) to resend the link.

For a form bound to Laravel's validation errors (per-field messages on the `422`), use the [lukk-js form helper](/use-lukk-form).

Next: **[The User](/user)**
