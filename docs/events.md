# Events

lukk dispatches a small set of Laravel events at security-relevant moments. Attach listeners to log, alert, or react — you never edit the package. This page is server-only.

## Security events

### RefreshTokenReused

When a refresh token that was already consumed is replayed after the [grace window](/tokens-and-rotation#the-grace-window), lukk force-revokes the entire token family and dispatches `Lukk\Events\RefreshTokenReused`. This is a token-theft signal — listen for it to log or alert:

```php
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Log;
use Lukk\Events\RefreshTokenReused;

Event::listen(function (RefreshTokenReused $event) {
    Log::warning('Refresh token reuse detected', [
        'family' => $event->familyId,
        'reason' => $event->reason,
    ]);
});
```

The event carries two readonly properties, `$familyId` and `$reason`. The `reason` is one of:

| Reason | Meaning |
|---|---|
| `reuse` | A consumed token was replayed after the grace window — a successor already exists. The textbook theft signal. |

A replayed token whose family is **already** revoked is rejected quietly, without this event — the family is gone, so there's nothing left to protect or report.

From **lukk 0.7.0 it also fires from `POST /auth/logout`**, which now accepts a refresh token ([see why](/authentication#logging-out)). A logout presenting a consumed token past the grace window is the same signal as presenting it at `/refresh`, and the decision follows rotation's order exactly — revoked, then expired, then consumed past grace — so a token `/refresh` would call reuse is reported as reuse here too, and a merely stale one is not. The logout itself still answers `204` whatever the event says: it reveals nothing to the caller. A logout *retried* after the session already ended fires nothing — the family is revoked, so it is rejected quietly like any other replay into a dead family. What does reach your alerting is a client logging out with a refresh token its own session rotated past long ago: a stale cookie in a tab left open, or a browser that held onto one while another path rotated it.

> [!IMPORTANT]
> The revoke-then-dispatch happens **after** the rotation transaction commits, so the family revocation and the event stay consistent. See [Tokens & Rotation](/tokens-and-rotation) for the reuse-detection mechanics and the grace window that keeps normal concurrency from tripping a false revoke.

### SessionUnclaimed

**lukk 0.7.0.** With [`claim_seconds`](/configuration#refresh-behavior) on, `Lukk\Events\SessionUnclaimed` fires when a session's first use comes after its claim window, and lukk revokes that session. It carries `$familyId` and `$guard`.

Unlike [`RefreshTokenReused`](#refreshtokenreused), this is not a theft signal: the usual cause is a sign-in whose response never reached its client. Log it, but don't page anyone.

### RefreshFamilyForked

The [grace window](/tokens-and-rotation#the-grace-window) tolerates a re-consumption by minting a sibling rather than revoking — that's what stops a multi-tab or SSR client logging itself out. The cost is that a thief who replays *inside* the window gets a sibling too, after which both chains rotate independently and never trip reuse detection.

`Lukk\Events\RefreshFamilyForked` is the signal. It fires when a family carries more live, unrotated tokens than ordinary concurrency explains (`fork_threshold`, default 3 — a browser opening several tabs routinely produces two or three):

```php
use Illuminate\Support\Facades\Event;
use Lukk\Events\RefreshFamilyForked;

Event::listen(function (RefreshFamilyForked $event) {
    Log::warning('Refresh family fan-out', [
        'user' => $event->userId,
        'family' => $event->familyId,
        'live' => $event->liveTokens,
    ]);
});
```

It is **advisory by design**. Revoking automatically on a fork would mean revoking on suspicion — exactly the false logout the grace window exists to prevent — so lukk reports it and leaves the decision to you. A legitimate client settles at two or three siblings; a forked family keeps growing.

### PasskeyCloneDetected

When [passkeys](/passkeys) are enabled, an assertion whose signature counter *regresses* dispatches `Lukk\Events\PasskeyCloneDetected` — a signal that the authenticator may have been cloned. It's the credential-layer analog of refresh-token family reuse detection; listen to alert and consider disabling the credential:

```php
use Illuminate\Support\Facades\Event;
use Lukk\Events\PasskeyCloneDetected;

Event::listen(function (PasskeyCloneDetected $event) {
    Log::warning('Possible passkey clone', [
        'user' => $event->userId,
        'credential' => $event->credentialId,
    ]);
});
```

The event carries `$userId` and `$credentialId`. A **zero** counter is never flagged — synced passkeys always report `0`.

From lukk 0.7.0 it also fires for a non-zero counter that **did not advance** because another assertion got there first. Two concurrent assertions presenting the same counter used to both pass, since each read the stored value before either wrote it; the update is now forward-only and reports whether it won, and the loser is refused as a clone (WebAuthn L3 §6.1.1). The assertion is refused in either case. A credential deleted mid-ceremony, whose update also writes nothing, is refused without the event — only a row that is still there lost a race worth an alarm.

### AccountLocked / AccountReleased

When the opt-in [account lockout](/account-lockout) is on, `Lukk\Events\AccountLocked` fires the moment a consecutive-failure run hits the cap, and `Lukk\Events\AccountReleased` when a **held** lock is lifted — by a successful authentication, a password reset or change, or `lukk:release`. From lukk 0.7.0 clearing a counter that never reached the cap (every successful sign-in after a typo did this) or a lock already past `release_after` fires nothing; a rebound `LockoutRepository` should follow the same rule. Both carry `$purpose` (`login`, `two_factor` or `confirm`), `$subject`, and `$guard`:

```php
use Illuminate\Support\Facades\Event;
use Lukk\Events\AccountLocked;

Event::listen(function (AccountLocked $event) {
    Log::warning('Account locked', ['purpose' => $event->purpose, 'subject' => $event->subject]);
});
```

`AccountLocked` fires **once, on the transition**, and it is the only signal a locked-out user's account gets — so it's where you'd send the "someone is trying to get into your account" mail. `$subject` names the counter that locked:

| `$subject` | Meaning |
|---|---|
| `id:<user id>` | A login lock on an account. The one to notify. |
| `idn:sha256:<digest>` | A login lock on the identifier's case- and script-folded spelling. It names no one: it locks for an identifier that matches no account, and fires *alongside* the account's own `id:` lock for one that does (a login failure counts against both). Ignore it for notifications. |
| `<user id>` (bare) | A `two_factor` or `confirm` (step-up) lock. |

Locks written before lukk 0.7.0 for an identifier naming no account carry the older `idn:<identifier>` form. Because a login failure counts against both the fold and the account, `AccountLocked` can fire **twice** for one run when both reach the cap — act on the `id:` one.

### TokenAbilityDenied

**lukk 0.6.0.** `Lukk\Events\TokenAbilityDenied` fires when a verified token is refused a route because its [`scope`](/abilities) doesn't cover it. A stolen token probing for what it can reach looks like a run of these. It carries `$userId`, `$guard`, `$familyId`, `$required` (what the **route** asked for — never what the caller holds) and `$requiresAll` (`true` for `lukk.abilities`, `false` for `lukk.ability`). An event rather than a log line, so ability names reach your logs only if you put them there.

### AccountDeleting / AccountDeleted

When a user [erases their account](/account-deletion):

| Event | Fires | Properties |
|---|---|---|
| `AccountDeleting` | **Before** anything is erased, inside the transaction that erases it. Erase or anonymize your own domain data here: a listener that throws rolls the erasure back. Listen **synchronously** — a queued listener is pushed at dispatch and runs even if the transaction then rolls back — and keep it fast and transactional. Sessions are already revoked by then, so a throw still leaves the user logged out everywhere. | `$user` (the whole model, still intact), `$guard` |
| `AccountDeleted` | **After** the erasure commits. For work that must not roll back or hold a transaction open: telling a downstream processor to erase its copy, an audit record. Safe to queue. | `$userId`, `$identifier` (the `lukk.username` value — personal data, keep it out of logs), `$guard` |

`AccountDeleting` carries the whole model, so never queue it: that would serialize the email, password hash and encrypted TOTP secret into `jobs` and `failed_jobs`, which outlive the erasure.

### PasswordChanged

`Lukk\Events\PasswordChanged` fires when a signed-in user changes their own password via [change password](/change-password), having proven the current one. It carries `$user` — unlike the reset flow, there is always a resolved one — serialized as an identifier for a queued listener (see [below](#authenticator-events)).

```php
use Illuminate\Support\Facades\Event;
use Lukk\Events\PasswordChanged;

Event::listen(function (PasswordChanged $event) {
    $event->user->notify(new YourPasswordWasChanged);
});
```

Deliberately distinct from Laravel's `Illuminate\Auth\Events\PasswordReset` in the table below, which fires for the forgot-password flow. Both are worth reacting to, but they mean different things: one proves control of the email address, the other proves knowledge of the existing password. Users read *"your password was reset"* and *"your password was changed"* very differently — and an unexpected one of either is how account takeover gets noticed, which is why this sits with the security events rather than as a bare row.

### Authenticator events

**lukk 0.7.0.** NIST SP 800-63B-4 §4.1.2.1 requires telling the subscriber, through another channel, when an authenticator is bound to their account. lukk sends no mail, so it dispatches an event every time one is bound or removed, and you send the notice. Without them, an attacker holding a stolen session and a step-up could enrol their own key, or remove the victim's second factor, with nothing for your app to hang a warning on.

| Event | Fires when | Properties |
|---|---|---|
| `TwoFactorAuthenticationConfirmed` | A TOTP is confirmed. Enrolment alone binds nothing, so it doesn't fire. | `$user` |
| `TwoFactorAuthenticationDisabled` | A TOTP secret, confirmed or pending, is removed. Not for an account that had none. | `$user` |
| `RecoveryCodesGenerated` | A new set of recovery codes replaces the old. | `$user` |
| `PasskeyRegistered` | A passkey is stored. | `$user`, `$credentialId`, `$name` (nullable) |
| `PasskeyDeleted` | A credential was actually removed — by the user, or by a reset with [`revoke_passkeys`](/password-reset#session-revocation) on (one event per passkey). Not by [account erasure](/account-deletion). | `$user`, `$credentialId` |

All five are in `Lukk\Events`, and `$user` is the resolved `Authenticatable`. Names follow Fortify's where one exists. They use `SerializesModels`, like `PasswordChanged` and Laravel's own `PasswordReset` (lukk 0.7.0): a queued listener receives the user re-read from the database when the job runs, rather than the whole model — password hash, encrypted TOTP secret, recovery-code hashes — written into `jobs.payload` and, on failure, `failed_jobs`. A user deleted before the job runs fails it with `ModelNotFoundException`; copy what you need when queuing if that matters. Send the notice somewhere the attacker doesn't control — the account's email, not an in-app banner they can dismiss:

```php
use Illuminate\Support\Facades\Event;
use Lukk\Events\PasskeyDeleted;
use Lukk\Events\PasskeyRegistered;
use Lukk\Events\RecoveryCodesGenerated;
use Lukk\Events\TwoFactorAuthenticationConfirmed;
use Lukk\Events\TwoFactorAuthenticationDisabled;

Event::listen([
    TwoFactorAuthenticationConfirmed::class,
    TwoFactorAuthenticationDisabled::class,
    RecoveryCodesGenerated::class,
    PasskeyRegistered::class,
    PasskeyDeleted::class,
], function (object $event) {
    // A queued notification: "a sign-in method on your account changed — if this wasn't you, …"
    $event->user->notify(new SignInMethodChanged($event::class));
});
```

## Framework events

lukk also dispatches standard Laravel auth events, so your existing listeners work unchanged:

| Event | When |
|---|---|
| `Illuminate\Auth\Events\Lockout` | The decaying login throttle refuses an attempt — either the per-IP bucket (identifier + address, `max_attempts`) or the IP-independent one (identifier alone, `account_max_attempts`) has tripped. Both key on the folded identifier, never on a resolved account. Listen to alert on brute-force attempts. |
| `Illuminate\Auth\Events\Registered` | A user completes [registration](/registration). |
| `Illuminate\Auth\Events\Verified` | A user completes [email verification](/email-verification). |
| `Illuminate\Auth\Events\PasswordReset` | A user completes a [password reset](/password-reset). |

Login is constant-time by design (an unknown email runs the same hashing work as a wrong password), and every token-bearing response is sent `Cache-Control: no-store` — both are part of the security contract covered in [Security](/security).

Next: **[Customization](/customization)**
