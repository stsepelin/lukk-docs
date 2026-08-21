# Events

lukk dispatches a small set of Laravel events at security-relevant moments. Attach listeners to log, alert, or react — you never edit the package. This page is server-only.

## Security events

### RefreshTokenReused

When a refresh token that should no longer be usable is presented, lukk force-revokes the entire token family and dispatches `Lukk\Events\RefreshTokenReused`. This is a token-theft signal — listen for it to log or alert:

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
| `revoked` | An already-revoked token was replayed. |

> [!IMPORTANT]
> The revoke-then-dispatch happens **after** the rotation transaction commits, so the family revocation and the event stay consistent. See [Tokens & Rotation](/tokens-and-rotation) for the reuse-detection mechanics and the grace window that keeps normal concurrency from tripping a false revoke.

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

### AccountLocked / AccountReleased

When the opt-in [account lockout](/account-lockout) is on, `Lukk\Events\AccountLocked` fires the moment a consecutive-failure run hits the cap, and `Lukk\Events\AccountReleased` when a counter is cleared. Both carry `$purpose` (`login` or `two_factor`), `$subject`, and `$guard`:

```php
use Illuminate\Support\Facades\Event;
use Lukk\Events\AccountLocked;

Event::listen(function (AccountLocked $event) {
    Log::warning('Account locked', ['purpose' => $event->purpose, 'subject' => $event->subject]);
});
```

`AccountLocked` fires **once, on the transition**, and it is the only signal a locked-out user's account gets — so it's where you'd send the "someone is trying to get into your account" mail. Note that `$subject` is a submitted identifier, not a resolved user: it need not name a real account, so rate-limit anything you send off it.

### PasswordChanged

`Lukk\Events\PasswordChanged` fires when a signed-in user changes their own password via [change password](/change-password), having proven the current one. It carries `$user` — unlike the reset flow, there is always a resolved one.

```php
use Illuminate\Support\Facades\Event;
use Lukk\Events\PasswordChanged;

Event::listen(function (PasswordChanged $event) {
    $event->user->notify(new YourPasswordWasChanged);
});
```

Deliberately distinct from Laravel's `Illuminate\Auth\Events\PasswordReset` in the table below, which fires for the forgot-password flow. Both are worth reacting to, but they mean different things: one proves control of the email address, the other proves knowledge of the existing password. Users read *"your password was reset"* and *"your password was changed"* very differently — and an unexpected one of either is how account takeover gets noticed, which is why this sits with the security events rather than as a bare row.

## Framework events

lukk also dispatches standard Laravel auth events, so your existing listeners work unchanged:

| Event | When |
|---|---|
| `Illuminate\Auth\Events\Lockout` | The login throttle trips — an IP has exceeded the failed-login rate limit. Listen to alert on brute-force attempts. |
| `Illuminate\Auth\Events\Registered` | A user completes [registration](/registration). |
| `Illuminate\Auth\Events\Verified` | A user completes [email verification](/email-verification). |
| `Illuminate\Auth\Events\PasswordReset` | A user completes a [password reset](/password-reset). |

Login is constant-time by design (an unknown email runs the same hashing work as a wrong password), and every token-bearing response is sent `Cache-Control: no-store` — both are part of the security contract covered in [Security](/security).

Next: **[Customization](/customization)**
