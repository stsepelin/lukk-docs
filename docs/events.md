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

## Framework events

lukk also dispatches two standard Laravel auth events, so your existing listeners work unchanged:

| Event | When |
|---|---|
| `Illuminate\Auth\Events\Lockout` | The login throttle trips — an IP has exceeded the failed-login rate limit. Listen to alert on brute-force attempts. |
| `Illuminate\Auth\Events\Verified` | A user completes [email verification](/email-verification). |

Login is constant-time by design (an unknown email runs the same hashing work as a wrong password), and every token-bearing response is sent `Cache-Control: no-store` — both are part of the security contract covered in [Security](/security).

Next: **[Customization](/customization)**
