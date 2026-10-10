# Account Lockout

**NIST SP 800-63B-4 §3.2.2** (formerly SP 800-63B §5.2.2) requires a verifier to limit **consecutive** failed authentication attempts on a single account to no more than **100**. lukk's [rate limits](/configuration#rate-limits) don't satisfy that clause — they bound a *rate*, not a *run*, and they decay — so lukk ships a separate, **opt-in** persistent counter that does.

It is off by default, and that is a deliberate security trade-off rather than an oversight: a hard lockout is a **denial-of-service primitive**. Anyone who knows an address can burn its budget on purpose and lock the owner out. Turn it on when the protocol requirement outweighs that, and read [Bounding the denial](#bounding-the-denial) before you do.

This page is server-only — there is no client configuration. The client sees a `423`.

## Rate limit vs. lockout

They solve different problems and lukk runs both:

| | Rate limit (always on) | Lockout (opt-in) |
|---|---|---|
| Bounds | A **rate** — attempts per window | A **run** — consecutive failures, ever |
| Storage | Cache, decaying | `lukk_lockouts` table, persistent |
| Cleared by | Time, or a success | A **success** only (or an explicit release) |
| Survives | Not a cache flush | A cache flush, a deploy, a restart |
| Status | `429` | `423 Locked` |
| Standard | Defense in depth | NIST SP 800-63B-4 §3.2.2 |

The gap the lockout closes is concrete. lukk's IP-independent per-identifier cap (`account_max_attempts`) is 20 failures per 60 seconds — about **1,200 per hour**, indefinitely, because the window keeps resetting. A patient attacker never trips it and never runs out of guesses. A consecutive-failure cap does run out.

## Setup

Publish the migration — like every lukk migration, it is publish-only, in its own group:

```bash
php artisan vendor:publish --tag=lukk-lockout-migrations
php artisan migrate
```

Then enable the feature:

```php
// config/lukk.php
'features' => [
    'lockout' => true,
    // ...
],

'lockout' => [
    'max_attempts' => 100,   // LUKK_LOCKOUT_MAX_ATTEMPTS — §3.2.2 says no MORE than 100
    'release_after' => 0,    // LUKK_LOCKOUT_RELEASE_AFTER — seconds; 0 = hold until released
],
```

`max_attempts` is a **ceiling, not a target**. 100 is what the standard permits; nothing stops you setting 10.

> [!WARNING]
> The counter keys on the `lukk.username` field. If you authenticate on a different field via [`Lukk::authenticateUsing()`](/customization#custom-login-logic), set `lukk.username` to match it — otherwise lukk never sees an identifier to count against and the lockout **silently does nothing**. (It refuses to count an empty subject rather than drop every caller into one shared, never-decaying bucket, which would lock out your entire user base at attempt 100.)

## Bounding the denial

`release_after` is the setting that decides what kind of feature this is, so choose it deliberately.

**`release_after = 0`** is the strict §3.2.2 reading: a run broken only by a **success**. It is also the version an attacker can weaponize — lock an account and it stays locked until a human intervenes.

**`release_after = 3600`** trades the strict reading for a decaying cap. 100 failures per hour is no longer "100 consecutive, ever" — but it *is* exactly **OWASP ASVS V2.2.1** ("no more than 100 failed attempts per hour on a single account"), a bar this package does not otherwise clear. **Most deployments should prefer this.** It is a 12× improvement on the throttle alone and the lock lifts itself.

```dotenv
LUKK_LOCKOUT_MAX_ATTEMPTS=100
LUKK_LOCKOUT_RELEASE_AFTER=3600
```

If you do run with `0`, pair it with a listener on [`AccountLocked`](#events) so the account owner learns about it, and give your support team [`lukk:release`](#releasing-a-lock).

## What's protected

Three authenticators get their own independent counter, distinguished by a `purpose` column:

| Purpose | Subject | Counted failure |
|---|---|---|
| `login` | `idn:sha256:<digest of the normalized identifier>` always, **and** `id:<primary key>` when the identifier names an account — two counters, either of which locks | A failed `POST /auth/login` |
| `two_factor` | The user id | A failed TOTP code at `POST /auth/two-factor-challenge` |
| `confirm` | The user id | A failed password at `POST /auth/confirm-password`, or a wrong `current_password` at `POST /auth/password` ([change password](/change-password)) |

`confirm` matters because [step-up confirmation](/confirmation) re-verifies the *same* password as login. Change password checks it too, and shares the `confirm` budget rather than getting its own — two allowances for guessing one password would just be a larger allowance; a locked one answers `423` on `current_password`. Without it, a caller already holding an access token — a stolen one, an XSS'd one, a shared device — could keep guessing behind the sudo gate while the login route stayed capped. `POST /auth/confirm-passkey` is throttled but deliberately **not** locked: an assertion is a signature, not a guessable secret, so there is nothing to cap.

Every failed `login` counts against **two** counters (lukk 0.7.0): the identifier's normalized fold (trim, lowercase, transliterate) always, and the account's identity too when the identifier resolves to one. Either being locked refuses the attempt.

- **The fold alone is not enough.** Normalizing is many-to-one across real accounts — `аdmin@example.com` with a Cyrillic а folds onto `admin@example.com` — so a look-alike account's owner could release the victim's lock with their own successful sign-in or password reset. The `id:` counter is released only by *that account's* own success, reset or password change.
- **The account alone was an existence oracle.** Failures on a spelling the database never resolves (a Cyrillic look-alike, another case on a binary collation) would lock a non-account's fold but nothing a real account's canonical spelling checks — `423` versus `422`. Counting the fold for everyone makes a non-resolving spelling lock the same place whether or not an account exists.

The price is the fold's: a victim's failures can lock a look-alike account's fold too, as before 0.6. When both counters lock, [`AccountLocked`](/events#accountlocked-accountreleased) fires for each — the `idn:` one names no one. With `release_after` above zero the two counters can expire apart, which leaves a slow timing residue; the default (`0`) has none.

The decaying [login throttle](/configuration#rate-limits) is a different mechanism: its buckets key on the fold **only**, never on the account (see [Security → Known limitations](/security#known-limitations)).

The `idn:` counter is not a leftover: an identifier that names **no account** must still accumulate a counter, or `423`-vs-`422` would answer "does this account exist?" for free. A `login` lock can therefore name an address that was never registered — a lock can name an account that doesn't exist. From lukk 0.7.0 it names it only by a SHA-256 digest: what was typed is often a real person's address, a typo of it, or a stranger's, a held lock is never pruned, and with no account behind it its owner has nothing through which to ask for it to be erased. The counter only compares for equality, so nothing is lost. Locks written by earlier releases keep their plain `idn:<normalized>` key; `lukk:release`, [account erasure](/account-deletion) and the export still find them. Counting an identifier that names nobody is intentional: skipping it would leak account existence through the lockout's timing and behaviour, and lukk's login path is deliberately [constant-time](/security).

Counters are per [guard](/multiple-guards), so an admin guard and a customer guard never share one. From lukk 0.7.0 `features.lockout` and the `lockout` block are read per guard too, so an extra guard can turn the lockout on for itself ([example](/multiple-guards#setup)); earlier releases read only the global block.

### Recovery codes are exempt

A locked-out user submitting a **recovery code** is not gated by a `two_factor` lock. A recovery code is ~119 bits of entropy, single-use and salted+hashed, so a consecutive cap protects nothing there — while gating it would strand a user whose second factor an attacker deliberately burned. The recovery code is the way *out* of a lock, so it can't be behind one.

### The attempt is consumed before the password is checked

The counter is incremented **before** the credential is verified, then compared against the cap. Reading "is it locked?" and counting afterwards is check-then-act: a burst of concurrent requests all pass the check together and all reach the password comparison, so the real number of verifications is `max_attempts` *plus* however many arrived at once. Reserving first makes the count authoritative at the moment it is taken.

A successful authentication releases the reservation, so the counter still means "consecutive failures" from the outside — a correct password never costs an attempt. One exception: a correct password over 72 bytes against a bcrypt hash, which bcrypt could only verify in part, is answered with the [must-reset](/security#password-policy) `422` and keeps its attempt, since it was never fully checked.

## What a locked account sees

`423 Locked`, not `429`:

```json
{
  "message": "This account is locked. Contact support to restore access.",
  "errors": {
    "email": ["This account is locked. Contact support to restore access."]
  }
}
```

`429` means "retry later", and with `release_after` at `0` that would be a lie — the lock needs intervention, not patience. When `release_after` is set, the message instead names the remaining wait, using Laravel's own `auth.throttle` translation line.

Both messages are `__()`-wrapped, so publish `lang/en/auth.php` and add your own keys to change them.

The lockout check runs **before** the in-action limiter (the per-identifier login buckets), so a locked account gets the `423` rather than a `429` that misdescribes its situation. The route throttles run earlier still, as middleware — `lukk-login`'s per-IP cap, `lukk-confirm`, `lukk-2fa` — so a caller who has exhausted one of those gets its `429` first.

## Releasing a lock

Five things clear a counter:

- **A successful authentication.** "Consecutive" is the whole point — any success ends the run and resets the count to zero. A successful **login** additionally clears a `confirm` lock: it proves the same password, and it's the self-service escape when someone locked step-up with a stolen token (they can't log in without the password, so this hands them nothing). A passkey clears it only on a step-up that passed every check, or a sign-in that granted a session on a [multi-factor assertion](/passkeys#when-a-passkey-counts-as-multi-factor) (lukk 0.7.0) — a presence-only key proves possession alone, and letting it clear the count would make password guesses with a stolen token unlimited.
- **A password reset.** [Completing a reset](/password-reset) releases the `login` **and** `confirm` locks, keyed off the *resolved* user — after a reset, failures counted against the old password are meaningless. Without this, an attacker who locked an account could keep it locked even after the owner did the one thing that should restore access — the owner would be stuck with no path left but a support ticket.
- **A password change.** A successful [`POST /auth/password`](/change-password) releases the account's `confirm` **and** `login` counters, for the same reason as a reset: the failures they hold were against a password that no longer exists, and reaching that point required proving the current one. Otherwise a user who noticed the attack and changed their password would stay locked out of login on every other device.
- **`release_after` elapsing**, when you've set it. This one is lazy and read-only: the lock simply *reports* unlocked, and the row is reset by the next failure or dropped by [pruning](#pruning). Nothing is written on a read path (that would break on a replica), so **no `AccountReleased` fires** for an expiry.
- **The console command**, for your support team:

```bash
php artisan lukk:release user@example.com
php artisan lukk:release 42 --purpose=two_factor
php artisan lukk:release 42 --purpose=confirm
php artisan lukk:release user@example.com --guard=admin
```

`--purpose` is `login` (default), `two_factor`, or `confirm`. `--guard` defaults to lukk's configured guard — locks are stamped with the guard that recorded them, so on a [multi-guard](/multiple-guards) app you must name the right one. The command normalizes the subject exactly the way the failure path recorded it, so pasting an address straight out of a support ticket works. It exits non-zero when no matching lock was found.

## Pruning

Spent counters accumulate. `lukk:prune` — already [scheduled daily](/deployment#pruning-expired-tokens) — drops released rows once they're stale:

```bash
php artisan lukk:prune --lockout-days=30
```

A **held** lock is never pruned, whatever its age — pruning must not quietly become a release path. What goes is the spent stuff: counters untouched for `--lockout-days`, and locks already past `release_after`. The sweep runs wherever the `lukk_lockouts` table exists, whether or not `features.lockout` is on now, so counters left from a time it was on still age out.

## Events {#events}

Both are dispatched on the **transition**, not on every attempt:

| Event | When |
|---|---|
| `Lukk\Events\AccountLocked` | A consecutive-failure run just hit the cap. |
| `Lukk\Events\AccountReleased` | A **held** lock was lifted — by a successful authentication, a password reset or change, or `lukk:release`. Not for clearing a counter that never reached the cap, and not for a lock already past `release_after`, whose expiry announces nothing (see [above](#releasing-a-lock)). |

Up to lukk 0.6 `AccountReleased` fired whenever a counter row was deleted, so every successful sign-in after a single typo told an audit log that a locked account had been unlocked. A rebound [`LockoutRepository`](#swapping-the-store) should follow the same rule: fire for a held lock only. `AccountLocked` can fire twice for one login failure — once for the identifier's fold, once for the account — when both reach the cap; only the `id:` subject names a user.

Each carries `$purpose` (`login`, `two_factor` or `confirm`), `$subject`, and `$guard`. A locked-out user gets **no other signal** — they simply can't authenticate — so `AccountLocked` is where you send the "someone is trying to get into your account" mail, or a release link:

```php
use Illuminate\Support\Facades\Event;
use Lukk\Events\AccountLocked;

Event::listen(function (AccountLocked $event) {
    Log::warning('Account locked', [
        'purpose' => $event->purpose,
        'subject' => $event->subject,
        'guard' => $event->guard,
    ]);
});
```

`$subject` is an identifier, not an `Authenticatable` — resolve it yourself if you need the user, and handle the case where it doesn't match one.

## Swapping the store

Storage sits behind `Lukk\Contracts\LockoutRepository`, like every other seam in the package. The default `DatabaseLockoutRepository` uses a transaction with a row lock to count, so concurrent failed attempts can't race past the cap. If you rebind it, **preserve that** — a non-atomic implementation lets a burst of parallel requests blow straight through `max_attempts`. Account [erasure and export](/account-deletion) call `forget()` and `summariesForSubjects()` on whatever is bound (lukk 0.7.0; they used to be skipped unless a `lukk_lockouts` table existed), so answer `0` and `[]` for nothing stored rather than throwing.

```php
// AppServiceProvider::register()
$this->app->bind(
    \Lukk\Contracts\LockoutRepository::class,
    \App\Auth\RedisLockoutRepository::class,
);
```

A cache-backed store is a poor fit for this specific job, though — a counter that expires isn't *consecutive*, and one that a cache flush erases isn't a durable cap. That's why the default is a table. See [Customization](/customization) for the full list of rebindable contracts.

Next: **[Multiple Guards](/multiple-guards)**
