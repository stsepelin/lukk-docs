# Upgrading

Both halves of lukk are pre-1.0 (`0.x`). Per [SemVer §4](https://semver.org/#spec-item-4), a
**minor** bump (`0.x.0`) may carry a breaking change; a **patch** bump (`0.x.y`) never does. The
1.0 releases will mark API/schema stability and end this cadence.

Each repo keeps a version-specific **`UPGRADE.md`** — the authoritative, "you may need to do
something" subset of its changelog, organized highest-version-first with **High / Medium / Low**
impact tags. Read it (and the changelog) before bumping:

- **lukk (Laravel package)** — [UPGRADE.md](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md) · [CHANGELOG](https://github.com/stsepelin/lukk/blob/main/CHANGELOG.md)
- **lukk-js (TypeScript / Nuxt client)** — [UPGRADE.md](https://github.com/stsepelin/lukk-js/blob/main/UPGRADE.md) · [`lukk-core` changelog](https://github.com/stsepelin/lukk-js/blob/main/packages/core/CHANGELOG.md) · [`lukk-nuxt` changelog](https://github.com/stsepelin/lukk-js/blob/main/packages/nuxt/CHANGELOG.md)

## Ground rules

- **Pin an exact version.** Don't float `^` on a `0.x` dependency you can't retest.
- **Upgrade the server first.** lukk's HTTP contract is the source of truth; the client only
  speaks it. When a server change needs a matching client change, its `UPGRADE.md` entry says so.
- **Schema changes don't auto-apply.** lukk's migrations are [publish-only](/installation), so a new
  column reaches your database only when you add it, and new features are config-gated. Changes to how
  existing routes behave *do* apply on upgrade — the entries below say which, and what to check.
- **Run your tests** after bumping, then read the entries at or below your target version.

## Highest-impact change right now

<!-- Release step: the two #upgrading-to-070-from-06x links resolve only once lukk's UPGRADE.md heading drops "(unreleased)"; until then GitHub's anchor is #upgrading-to-070-from-06x-unreleased. -->

> [!WARNING]
> **lukk `0.7.0` reworks `POST /auth/logout`.** It is no longer behind `auth:{guard}`: a valid access
> token **or** the client's refresh token ends the session, so an idle tab whose access token has
> lapsed can finally log out instead of getting a `401`. See [Logging out](/authentication#logging-out).
>
> What can surprise an existing install:
>
> - A request with no usable credential answers **`204`**, not `401`, and revokes nothing. A test using
>   logout as a "does this token authenticate on this guard" probe needs a real `auth:{guard}` route.
> - With only a refresh token, nobody is authenticated — `$request->user()` is `null` where the route
>   would previously have answered `401` and never reached your response. The `Authenticate` middleware
>   no longer runs here, so anything attached through it doesn't apply either.
> - **Cookie mode:** the refresh cookie is used, and the clearing `Set-Cookie` sent, only on
>   `Content-Type: application/json` or `Sec-Fetch-Site: same-origin`/`none`. A client that POSTs with no
>   body must now send `{}` as JSON (lukk-js does).
> - `LogoutResponse` takes `bool $clearRefreshCookie`. A [rebound implementation](/customization#reshaping-responses)
>   must honour it — ignoring it re-opens a forced-logout CSRF. And `DELETE /auth/sessions/others` no
>   longer goes through that contract.
> - The route has no throttle, but the refresh-token lookup does, and a throttled one answers **`429`**
>   with `Retry-After` rather than a `204` the client would read as "logged out".
> - A body `refresh_token` is read from a JSON body only. A **consumed** refresh token presented past the
>   grace window dispatches `RefreshTokenReused` and revokes its family, exactly as `/refresh` does.
>
> The full list is in [lukk UPGRADE.md](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md#upgrading-to-070-from-06x), including the constructor changes for anyone extending
> the controllers: `AuthenticatedSessionController` takes `EndSession` instead of `RevokeSession` and a
> trailing `ConfirmPasswordUnchanged`, and its `destroy()` no longer takes a `TokenVerifier`;
> `TwoFactorChallengedSessionController` gains `ChallengeToken` and `ConfirmPasswordUnchanged`.

> [!WARNING]
> **lukk `0.7.0` changes the `amr` claim and how a passkey is trusted.** High impact if anything reads
> `amr` — a gateway, a resource server, or your own gates.
>
> - **`amr` uses only [RFC 8176 values](/tokens-and-rotation#the-amr-claim).** A passkey is
>   `["pop","user"]`, plus `"mfa"` when the assertion was multi-factor; password + TOTP is
>   `["pwd","otp","mfa"]`; a single-factor passkey + TOTP is `["pop","user","otp"]`, without `mfa`.
>   `webauthn` is gone: replace a check for it with `pop`, and "was this multi-factor" with `mfa`.
> - **`amr` now survives refresh**, stored in a new `refresh_tokens.amr` column. The column went into
>   the existing core migration, so a fresh install gets it. An install that already ran that migration
>   adds it with a migration of its own — republishing doesn't help, the copy gets a new timestamp and
>   fails with "table already exists". Until then nothing breaks for reading `amr`: the claim just
>   disappears after the first refresh as before. (But see the password step-up below.)
>
>   ```php
>   Schema::table('refresh_tokens', function (Blueprint $table) {
>       $table->text('amr')->nullable();
>   });
>   ```
>
>   A custom [`RefreshTokenRepository`](/customization#swapping-storage) (or a subclass overriding
>   `persist()`) must add the trailing `?string $amr = null` argument and round-trip it. `amr` — and the
>   new [`auth_time`](/tokens-and-rotation#the-auth-time-claim) claim — are now **reserved**: a
>   `tokenClaimsUsing` hook can neither forge nor erase them.
> - **A passkey stands in for an enrolled TOTP only when the assertion was multi-factor** — UV flag on a
>   credential already `uvInitialized`, [decided per assertion](/passkeys#when-a-passkey-counts-as-multi-factor),
>   no longer by `user_verification`. Otherwise `POST /auth/passkeys/login` answers
>   `{"two_factor": true, "challenge_token": "…"}` like a password sign-in, and your client must complete it
>   at `/auth/two-factor-challenge` (lukk-js 0.12 does).
> - **A custom [`WebAuthnCeremony`](/customization#available-contracts)** must adopt the new signatures:
>   `verifyAssertion()` returns a `PasskeyAssertion` and takes `?string $userVerification` and
>   `int|string|null $owner` (the expected user handle on a step-up); `authenticationOptions()` takes
>   `$userVerification`; and there is a new `isMultiFactor()`. **A custom `PasskeyRepository`** must
>   return `bool` from a forward-only `updateSignCount()`, and answer an empty store without throwing,
>   because erasure, export and `revoke_passkeys` now call whatever is bound. A mismatched method is a
>   fatal on the first request that resolves the binding, not at boot.
> - **Passkey step-up** must meet the account's highest available level. Use the new
>   `POST /auth/confirm-passkey/options`; a refused step-up is `422` on `credential`, not `403`.
> - **Password step-up** is refused with `422` on `password` on an account with a second factor the guard
>   enforces, or a user-verifying passkey, unless the session's token carries `mfa` in `amr` **and** its
>   `auth_time` is within the new [`confirm.mfa_max_age`](/configuration#confirmation) (one day). **A token
>   with no `amr` counts as single-factor** — so migrate the `amr` column, or such users must confirm with a
>   passkey or sign in again after every refresh. An `auth_time` more than `leeway` in the future, or
>   not a timestamp at all, counts as no recent sign-in (a fractional one counts as the second it falls
>   in). `auth_time` is **stored with the session**, in the `amr` column beside the methods
>   (`{"amr":[…],"auth_time":…}`), so a session signed in before the upgrade has no `auth_time` after its
>   next refresh and needs a fresh multi-factor sign-in before it can step up with a password. A custom
>   `RefreshTokenRepository` must treat `$amr` as opaque and hand it back unchanged.
>   [Details](/confirmation#with-a-password).
> - **Cookie mode: token routes require JSON.** `login`, `register`, `refresh`, `two-factor-challenge`
>   and `passkeys/login` answer **`415`** unless the request has a JSON body or `Sec-Fetch-Site:
>   same-origin`/`none` (login CSRF, RFC 6265bis §5.7). Send `{}` as JSON for a cookie refresh; lukk-js
>   already does. Body mode is unchanged — except that its `/refresh` no longer reads a leftover refresh
>   cookie at all. [Details](/authentication#output-modes).
> - **Under bcrypt, a password over 72 bytes is refused** — a `422` on register, reset and
>   change-password (lukk adds the check after a [`registerValidation()`](/registration#customizing-the-user-s-fields)
>   rule set, or a rebound `RegisterRequest` subclass's `rules()`, too — with a `registerUsing()` hook
>   only the string and NUL-byte checks, not the 72-byte rule, which is bcrypt's). **Sign-in, step-up and
>   change-password's current password** refuse one against a bcrypt hash (`$2a$`/`$2b$`/`$2x$`/`$2y$`),
>   which lukk could verify only in part — and every earlier lukk release stored such passwords,
>   truncated. Those users are typing the right password: they get a `422` saying "This password is longer
>   than 72 bytes, which can no longer be checked in full. Reset your password to continue." and must
>   reset. You can't find them in the database (the hash doesn't record the length), so consider telling
>   your users before you upgrade. See [Password policy](/security#password-policy).

lukk `0.7.0`'s smaller changes, each with what to check:

| Change | Impact | What to do |
|---|---|---|
| The default guard must resolve users from the provider sign-in checks against: `auth.guards.<default>.provider` (or, naming none, `auth.defaults.provider`) must read the same users as [`lukk.user_provider`](/configuration#guard-provider), or boot throws naming both. Two provider names over the same users boot: the same `model` under the `eloquent` driver, the same `table` and `connection` under `database`, or — for any other driver — identical `auth.providers` entries. | **High** if they read different users | Point both at the same provider. Otherwise a password from one table signed in as the row with the same id in the other. The default (`users` on both) is unaffected. [Details](/multiple-guards#setup). |
| Sign-in, registration, forgot- and reset-password refuse an identifier carrying a [control, format or enclosing character, U+034F, or whitespace other than the ASCII space](/authentication#identifier-characters) with a `422`; registration's `name` refuses NUL. ZWNJ, ZWJ and U+20E3 COMBINING ENCLOSING KEYCAP are accepted. The login-throttle fold strips those characters (and combining marks, ZWNJ, ZWJ and the keycap) and trims Unicode whitespace. | Low | Find accounts whose stored identifier contains a refused character before upgrading — they can no longer type it to sign in ([how](#finding-identifiers-sign-in-now-refuses)). Buckets for such identifiers restart once, and a held `idn:` lock for one is no longer reached by it. |
| With `Lukk::authenticateUsing()` reading a field other than `lukk.username`, the IP-independent login bucket is skipped (an empty identifier was one bucket for everybody) and the per-address bucket keys on the address alone. | Low | Point [`lukk.username`](/configuration#guard-provider) at your field to keep the account cap. |
| The [lockout](/account-lockout#the-attempt-is-consumed-before-the-password-is-checked) still reserves an attempt before checking it, but locks — and fires `AccountLocked` — only once the check failed. The attempt that reaches the cap with the right credential signs in and fires neither `AccountLocked` nor `AccountReleased`. New optional contract `Lukk\Contracts\ReservesLockoutAttempts`. | Low — only if you implement `LockoutRepository` or listen for lockout events | A custom store keeps the old behaviour through `recordFailure()`; implement `reserve()` and `lockIfSpent()` to get the new one ([contract](/account-lockout#swapping-the-store)). |
| The two-factor per-account limiter counts an attempt before checking it, so a concurrent burst gets `rate_limits.two_factor.max_attempts` guesses and the rest a `429` on `code`. | Low | None. |
| With `block_unverified_login` on, an unverified account's two-factor challenge is refused (`403`) before the factor is checked, so no recovery code is spent on it. | Low | None. |
| [`RecoveryCodeUsed`](/events#recoverycodeused) fires when a recovery code is spent (`$user`, `$remaining`). | Low | Listen for it to notify the user and prompt new codes (NIST SP 800-63B-4 §4.2). |
| Refresh-token writes use `saveQuietly()`: model events (`creating`/`created`/`saving`/`saved`) no longer fire for rows lukk stores, a listener can't cancel one, and `persist()` throws if nothing was written. | Low — only if you observe a [`useRefreshTokenModel`](/customization#swapping-the-refresh-token-model) model | Audit sessions from lukk's events instead (`RefreshTokenReused`, `SessionUnclaimed`, your own login/logout listeners). A column filled from `creating` (a tenant trait's `tenant_id`) is no longer filled — on a `NOT NULL` column every sign-in and refresh then fails; [fill it as the model is built](/customization#filling-your-own-columns). |
| The [export](/account-deletion#the-export) gains `password_reset`, `two_factor.pending`, `two_factor.recovery_codes_remaining`, and per session `amr` and `authenticated_at`. `ExportAccount` takes the broker name as a trailing optional argument. | Low | None, unless you build `ExportAccount` yourself. |
| A `lukk-jwt` guard answers `401` with no query for a `sub` the model's key certainly cannot hold — for exactly `EloquentUserProvider` whose auth identifier is the key: the stock auto-incrementing integer `id`, or a `HasUuids`/`HasUlids` key judged by the model's own `isValidUniqueId()` — and for any `sub` containing a NUL byte. A non-UUID `fid` names no family (no PostgreSQL `500`). | Low unless a co-issuer mints tokens | Co-issuers must mint a `sub` your identifier column holds: for every other shape (Snowflake keys, a non-key identifier, a legacy 32-bit `increments('id')` past int4, `EloquentUserProvider` subclasses, custom providers) a subject the column refuses stays a reported PostgreSQL `500`, by design. [Details](/tokens-and-rotation#claim-validation). |
| `DELETE /auth/sessions/others` answers `409` for a token whose `fid` is empty, as for one without `fid`; `DELETE /auth/sessions` also denylists the presenting token when it names no family of lukk's. | Low | None. Before, an empty `fid` logged out every device, and logout-all left a co-issuer's bearer live. |
| A failed sign-in takes at least [`login_timebox_micros`](/configuration#sign-in-timebox) (500 ms); every `forgot-password` and every failed `reset-password` at least [`password_reset.timebox_micros`](/password-reset#setup) (one second). A successful sign-in or reset returns early. | Low | Raise either if your slowest real path takes longer — the box pads, it never shortens. Queue the reset notification. |
| [`leeway`](/configuration#refresh-behavior) is clamped to 0–300 s for every token lukk decodes. | Low | A larger `LUKK_LEEWAY` now acts as 300; fix the clock skew instead. |
| Input that is not valid UTF-8 is a `422`, never a `500` on PostgreSQL: the sign-in identifier, a passkey's `credential.id` (sign-in and step-up), a passkey name, a registration `name`, and a non-email `lukk.username`. A password is left alone — it never reaches SQL, and refusing one would lock out a password an earlier release stored. | Low | None. |
| [`passkeys.challenge_ttl`](/configuration#passkeys) defaults to 300 (was 120), is sent as the options' `timeout`, and the server keeps the challenge 30 s longer. | Low | None; an explicit `LUKK_PASSKEY_CHALLENGE_TTL` is kept. |
| `ceremony_id` on passkey login and step-up must be the UUID lukk issued. | Low | A custom client sending anything else gets `422` on `ceremony_id`. |
| [Unclaimed sessions](/configuration#refresh-behavior) (`claim_seconds`, off) and `POST /auth/session/claim` are new. | Low | Nothing until you set the key. A custom `RefreshTokenRepository` should populate `RefreshTokenRecord::$original`. |
| With [`block_unverified_login`](/email-verification#blocking-unverified-login) on, an unverified account with two-factor is refused (`403`) before a challenge is issued, and at redemption. | Medium | None — the gate now applies to the two-factor path too. It and `features.email_verification` are read per guard. |
| `DELETE /auth/sessions/others` answers a bare `204` (no `LogoutResponse`, no cookie cleared), and **`409`** for a bearer with no `fid`. | Low | A rebound `LogoutResponse` no longer shapes this route. Co-issuer clients should call `DELETE /auth/sessions`. |
| `features.logout_all` is honoured; `rotation` / `reuse_detection` / `denylist` are removed (never read). | Medium if you set `logout_all` to `false` | `false` now removes `DELETE /auth/sessions` (a `404`). Delete the three dead keys. |
| `LockoutRepository` gained `summariesForSubjects(array $subjects, ?string $guard): array`, and erasure and export now call a rebound one whether or not a `lukk_lockouts` table exists. | Medium if you implement it | Mirror `forget()`: reach exactly the rows it deletes, scoped to the guard. Answer `0` and `[]` for nothing stored. The [export](/account-deletion#the-export) gains `lockouts`. |
| `FinishPasskeyLogin` no longer clears the password-confirm lockout itself. | Medium if you call it from your own code | Call `releaseConfirmLock($passkey)` once you have granted what the assertion was for — and for a sign-in only on a multi-factor assertion. lukk's own routes [already do](/passkeys#security-notes). |
| A success clears only the per-address login bucket — the IP-independent `account_max_attempts` bucket decays instead of resetting — and non-account lockout subjects are stored as `idn:sha256:<digest>`. | Low | None, but a user who mistypes often may now meet `account_max_attempts` after a successful sign-in where before they would not. Old locks keep their key and are still found by `lukk:release`, erasure and the export. |
| Per-guard `features.lockout`, `lockout.*`, `rate_limits.login.*` and `rate_limits.two_factor.*` are honoured. | Low | Check that an extra guard's [overrides](/multiple-guards) are what you want enforced — they now are. |
| New [`password_reset.revoke_passkeys`](/password-reset#session-revocation) (off). | Low | Keep `revoke_sessions` on with it. |
| Reset and change-password write the model's `getAuthPasswordName()` column. | Low | Remove any `password` mutator you added to work around the `500`. |
| `lukk.username` must be a plain column name not containing `password`; in debug, one naming no column is refused. | Low | Rename a dotted name that only worked under `authenticateUsing`. |
| `lukk:secret --guard` refuses a name that isn't letters, digits, `_` or `-`. | Low | None. |
| [Authenticator events](/events#authenticator-events) are new. | Low | Listen and notify the user out of band (NIST SP 800-63B-4 §4.1.2.1). |
| `LogoutResponse` clears the cookie per guard and takes `bool $clearRefreshCookie`. | Low | A rebound one must honour the flag — see the logout warning above. |
| Refresh rotation, bulk revocation and recovery-code redemption open their transaction on the model's own connection; erasure checks the broker's reset table on `auth.passwords.<broker>.connection`. | Low | None. If a [`useRefreshTokenModel`](/customization#swapping-the-refresh-token-model) model or your user model sits on another connection, rotation and redemption were not atomic before — upgrade. |
| Confirm-password and change-password answer `422`, not `500`, when the stored hash is one the hasher refuses (another algorithm, a `$2b$` import with `hashing.bcrypt.verify` on). | Low | None — sign-in already failed that closed. |
| [Account erasure](/account-deletion#what-erasure-actually-does) opens a transaction on every connection it writes to — the default one, the password broker's and the refresh-token store's — and `auth.passwords.<broker>.connection` may be an enum, backed or pure. | Low | None. With a `useRefreshTokenModel` model on another connection, a failed erasure used to keep the user and lose their credentials — upgrade. |
| Access tokens whose `exp`, `iat` or `nbf` is not a timestamp between the epoch and the end of year 9999 are [rejected](/tokens-and-rotation#claim-validation); fractions and numeric strings stay valid. Challenge tokens take the same upper bound on `exp`. A token whose `aud` is a JSON object is refused too (RFC 7519 §4.1.3). | Low unless a co-issuer mints tokens | Check that a co-issuer stamps real Unix times and a string or array `aud` — a token it used to get through, only to `500` later, is now a `401`. |
| A [recovery code](/two-factor-authentication#recovery-codes) stored under a hasher the app has since left is no match, not a `500`. | Low | After switching hashers with `verify` on, have users regenerate their codes. |
| Registration, [reset](/password-reset) and [change-password](/change-password) require the new password to be a string under every rule set, and registration's safety net (string, NUL, 72-byte) also runs for a rebound `RegisterRequest` subclass that overrides `rules()`. A sign-in identifier that is not valid UTF-8 is a `422` before any lookup (the password is not checked for it). | Low | None — a JSON number or array password is a `422` on `password`. |
| An `auth_time` may be fractional (floored) or a numeric string; a negative one is refused; [`confirm.mfa_max_age`](/configuration#confirmation) may be a float, so a "never" past the integer range no longer `500`s, and a non-numeric one reads as `0` (the multi-factor allowance off). | Low | None. |
| [`POST /auth/password`](/change-password) on an account with an enforced TOTP or a user-verifying passkey requires a recent multi-factor session (`amr` carries `mfa`, signed in within `confirm.mfa_max_age`), as a password step-up does; otherwise `422` on `current_password`, before anything is checked. | Medium if users change passwords from password-only sessions | Have the user sign in again with their second factor first. Accounts with nothing stronger than a password are unaffected. |
| Two-factor challenges carry `pwf`, a fingerprint of the password (an HMAC of the stored hash under `app.key`), and one whose password changed — or that carries none — is refused at redemption with a `422` on `challenge_token`, before the code is checked, so nothing is spent. | Medium in the minutes around the deploy, and for co-issuers | A challenge minted by 0.6 and redeemed after the upgrade is refused (the user signs in again), and so is a co-issuer's. Deployments that redeem each other's challenges must share `APP_KEY` (and `app.previous_keys` across a rotation). |
| A malformed `lukk.guards` — a numeric guard name (there or as `lukk.guard`), a list of names, a truthy scalar — throws at boot naming the problem. | Medium if your config has one | Fix the config. `false` or `''` still mean "no extra guards". |
| A per-guard `features.two_factor` that is `null` or `''` (an unset `env()`) now challenges enrolled accounts, and the challenge route mounts on the same rule. | Medium if an extra guard sets it from an unset `env()` | Set the flag explicitly (`false`) if you meant "off". |
| `POST /auth/two-factor/confirm` on an account whose two-factor is already confirmed, and `POST /auth/two-factor/recovery-codes` on one with no two-factor (confirmed or pending), answer **`409`** instead of succeeding. | Low | None — neither changed anything a user needed. lukk-js passes them through as plain errors. |
| The [export](/account-deletion#the-export)'s `passkeys[]` entries are `credential_id`, `name`, `created_at`, `last_used_at`, `aaguid`, `transports`, and every time is **ISO-8601** — `last_used_at` was a unix integer. | Medium if you parse the export | Parse the string. A rebound `PasskeyRepository` may return `created_at` (unix int), `aaguid` and `transports` from `summariesForUser()`; one that doesn't exports `null`. |
| Per-guard `two_factor.challenge_ttl`, `confirm.ttl` and `confirm.header` are honoured. | Low | A guard with its own `confirm.header` needs its clients to send the confirmation there. |
| Cookie mode: the refresh cookie's `Max-Age` is what is left of the session's absolute expiry, not a fresh `refresh_ttl` per rotation. `TokenPair` gained an optional `refreshExpiresAt`. | Low | None; code building a `TokenPair` itself can leave it out (the cookie then gets the full `refresh_ttl`). |
| A negative `leeway` counts as zero everywhere — the denylist TTLs and the unclaimed-session window use the same clamped value as the verifier. | Low | None. |
| `AccountLocked` can fire twice for one run (the identifier's fold and the account); `AccountReleased` fires only when a held lock is released. | Low if you notify or audit on them | Mail the owner only for `id:` subjects. A rebound `LockoutRepository` should fire `AccountReleased` for a held lock only. |
| `PasswordChanged` and the authenticator events (`TwoFactorAuthenticationConfirmed`, `PasskeyRegistered`, …) use `SerializesModels`: a queued listener gets the user re-read when the job runs. | Low if you queue those listeners | A user deleted before then fails the job with `ModelNotFoundException`; copy what you need when queuing. |
| An explicit `null` `lukk.path` (an unset `env()`) mounts the routes at `auth`, not at the root. | Low | Set the path you want explicitly. |

See [lukk UPGRADE.md](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md#upgrading-to-070-from-06x) for the full text of each.

### Finding identifiers sign-in now refuses

An account whose **stored** identifier carries a character lukk 0.7.0 [refuses](/authentication#identifier-characters) can no longer type it to sign in, so find those accounts before upgrading. The authoritative check is the pattern lukk validates with, run in PHP — swap in your table and [`lukk.username`](/configuration#guard-provider) column:

```php
use Illuminate\Support\Facades\DB;
use Lukk\Support\Identifier;

DB::table('users')->select(['id', 'email'])->lazyById()->each(function ($row) {
    if (preg_match(Identifier::INVISIBLE, (string) $row->email) === 1) {
        echo $row->id, PHP_EOL;
    }
});
```

The SQL below matches the same set as PCRE2 10.49's Unicode tables (Unicode 17; checked on PostgreSQL 17 and MySQL 8.4). A later Unicode version can add format characters that only the PHP scan sees. On PostgreSQL, with `standard_conforming_strings` on (the default):

```sql
SELECT id, email FROM users WHERE email ~ '[\u0001-\u001F\u007F-\u00A0\u00AD\u034F\u0488-\u0489\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u1680\u180E\u1ABE\u2000-\u200B\u200E-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u20DD-\u20E0\u20E2\u20E4\u3000\uA670-\uA672\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]';
```

On MySQL 8.0.4+ (ICU regular expressions). With `NO_BACKSLASH_ESCAPES` in `sql_mode`, the doubled backslashes reach the regex as written and it fails with error 3697 — run it in a session without that mode, or halve them:

```sql
SELECT id, email FROM users WHERE email REGEXP '[\\x{0000}-\\x{001F}\\x{007F}-\\x{00A0}\\x{00AD}\\x{034F}\\x{0488}-\\x{0489}\\x{0600}-\\x{0605}\\x{061C}\\x{06DD}\\x{070F}\\x{0890}-\\x{0891}\\x{08E2}\\x{1680}\\x{180E}\\x{1ABE}\\x{2000}-\\x{200B}\\x{200E}-\\x{200F}\\x{2028}-\\x{202F}\\x{205F}-\\x{2064}\\x{2066}-\\x{206F}\\x{20DD}-\\x{20E0}\\x{20E2}\\x{20E4}\\x{3000}\\x{A670}-\\x{A672}\\x{FEFF}\\x{FFF9}-\\x{FFFB}\\x{110BD}\\x{110CD}\\x{13430}-\\x{1343F}\\x{1BCA0}-\\x{1BCA3}\\x{1D173}-\\x{1D17A}\\x{E0001}\\x{E0020}-\\x{E007F}]';
```

ZWNJ, ZWJ and the keycap are accepted, so neither query matches them. On PostgreSQL two accounts may differ only by one of them (`ab` and `a\u{200D}b`): the throttle folds them onto one bucket, as it does accounts differing only in case or accents. MySQL's collation already treats them as one value, so `unique` refuses the second.

> [!WARNING]
> **lukk `0.6.0` adds a `guard` column to `passkeys`** and turns **account deletion on by default**.
>
> The column is folded into the existing passkeys migration, so a **fresh install needs no action**
> and a **single-guard install is unaffected** (the column stays null and no query names it). An
> install that already ran that migration **and** uses [multiple guards](/multiple-guards) must add
> the column and **backfill it** — until it does, `lukk:prune` deliberately sweeps no passkeys at
> all rather than risk deleting a credential it cannot attribute.
>
> Removing a guard needs the *opposite* cleanup, and it fails **open**: rows still stamped with the
> departed guard's name become visible to the default guard, and for passkeys that lookup is the
> authentication decision. Delete or re-home them first.
>
> `features.account_deletion` defaults to `true`, so upgrading **adds an irreversible route**
> (`DELETE /auth/account`). Turn it off if deletion is owned elsewhere. Both directions and the SQL
> are in [lukk UPGRADE.md](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md#upgrading-to-060-from-05x).

> [!NOTE]
> **lukk `0.4.0` added a `guard` column to `refresh_tokens`** on the same terms — folded into the
> core migration, no action for fresh or single-guard installs, and the identical backfill caveat in
> both directions. See [lukk UPGRADE.md](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md#upgrading-to-040-from-03x).

On the client side, `lukk-nuxt` **0.12.0** (with `lukk-core` 0.12.0) is the first release with anything to
do on upgrade. No runtime API was renamed or removed, but behaviour changed in ways an app can notice even
without typechecking, and every composable now declares a real return type where the published
declarations said `any`, so a typecheck that passed before can fail — most often on `user.value.name`,
which needs a `LukkUser` augmentation. `LukkAuth` also becomes a global auto-imported type, and
`lukk-auth` now defers rather than redirecting during a server render that couldn't identify the
visitor. Each with its migration step in
[lukk-js UPGRADE.md](https://github.com/stsepelin/lukk-js/blob/main/UPGRADE.md).

Changes that need a look:

- **Passkey sign-in can return a two-factor challenge, and `Amr` changed** (lukk 0.7.0). `useLukkPasskeys().login()`
  resolves to a `LoginResult`: when lukk answers a single-factor passkey with a challenge, `pendingTwoFactor`
  turns true and no user is loaded — show the same code form as after a password sign-in. `confirm()` uses
  lukk 0.7.0's step-up options, falling back to the login options on a `404` from an older lukk. The `Amr`
  type is `'pwd' | 'otp' | 'pop' | 'user' | 'mfa'`; `'webauthn'` is gone.
- **`login()`, `register()` and passkey `login()` are typed for BFF mode.** There they resolve to the proxy's
  `{ ok: true, expires_in }` — the new `BffSignInResult` — so they now return `LoginResult | BffSignInResult`
  (`RegisterResult | BffSignInResult`). Reading `access_token` needs a narrowing first
  (`'access_token' in result`, or `isTwoFactorChallenge`). See [lukk-core](/lukk-core#methods).
- **The export's passkey times are strings** (lukk 0.7.0). `AccountExport.passkeys[]` gains the optional
  `created_at`, `aaguid` and `transports`, and its `last_used_at` is an ISO-8601 string — it was unix seconds,
  so `new Date(entry.last_used_at * 1000)` now fails to typecheck and gives `NaN` at runtime. `PasskeySummary`
  from `GET /auth/passkeys` is unchanged: `last_used_at` is still a number (the declaration used to say
  `string`). `AccountExport` also gains an optional `lockouts` array.
- **New refusals from lukk 0.7.0, passed through as plain `LukkError`s** — no refresh, no retry, nothing
  signed out: `useLukkTwoFactor().confirm()` rejects `409` (on `code`) when two-factor is already on,
  `regenerateRecoveryCodes()` `409` (on `two_factor`) without two-factor, and
  `useLukkChangePassword().changePassword()` can reject `422` on `current_password` from a session below the
  account's step-up level (the remedy is signing in again with the second factor), and
  `useLukkConfirmation().confirmPassword()` `422` on `password` on the same terms — there the step-up is a
  user-verifying passkey (`useLukkPasskeys().confirm()`) or a fresh sign-in with the second factor, so a
  modal that only asks for the password should offer one. A two-factor challenge
  issued before the password changed is refused like an expired one; the user signs in again.
- **`storage` is reserved.** It was read by nothing — BFF tokens always lived in the sealed session cookie.
  Any value but `'cookie'` now fails the build; remove the option. For ended sessions shared across
  instances, use [`session.sharedStore`](/configuration#session-sharedstore).
- **Direct mode keeps its credentials out of `useState`.** The access token, the step-up token and a pending
  2FA challenge are held on the Nuxt app, not in the `lukk:access`, `lukk:confirmation` and `lukk:challenge`
  state keys, which are gone: `useState` is the payload, and Nuxt's chunk-reload persists it to
  `sessionStorage`. Use the composables; `clearNuxtState()` no longer clears them — `logout()` does.
- **The account calls resolve to `{ status }`.** `forgotPassword`, `resetPassword`, `changePassword` and
  `sendEmailVerification` resolve to [`LukkStatus`](/lukk-core#methods) (`{ status: string }`) instead of
  `void` — what lukk always sent.
- **`refresh` hooks** are typed `() => Promise<RefreshOutcome>` and may return
  [`REFRESHED_WITHOUT_TOKEN`](/lukk-core#renewed-without-a-token). In BFF mode `$lukkRefresh()` resolves to
  that symbol rather than the proxy's `{ ok, expires_in }` (code reading `.expires_in` gets `undefined`), and
  so does the `pair` of `$lukkRestore`'s result. Both are truthy on success. `$lukkRestore` is typed in templates.
- **Sign-in calls no longer refresh and retry on a `401`.** `login`, `register`, `twoFactorChallenge` and
  `loginWithPasskey` reject with it — in lukk-core and in the BFF proxy. `logout()` keeps its refresh-and-retry
  and accepts `{ retry: false }`; `logout({ refreshToken })` presents a body-mode refresh token, so lukk 0.7.0
  ends the session even with an expired access token.
- **`lukk-core`:** [`LukkError.retryAfter`](/lukk-core#errors) carries a numeric `Retry-After`, and the new
  `retryAfterSeconds()` export reads one; app-API errors from `useLukkFetch` carry it too.

The proxies refuse more:

- **The app-API proxy answers `404` for lukk's own routes.** If your client reached lukk through
  `/api/...`, use the composables. If lukk sits at the root of `api.target`'s host, the proxy refuses
  everything — [move lukk under a prefix](/configuration#api-bff-app-api-proxy).
- **…including behind a PHP front controller.** Every `.php` in the path is read as the end of a script's
  name, as Symfony strips it — with no `/` needed after it, so `/api/index.phpauth/login` is refused as well as
  `/api/index.php/auth/login` and `/app/index.php/auth/login` under a sub-path — in the path and in `baseURL`
  (`https://host/index.php/auth`), on every decoding round, with the tab, LF and CR a re-parsing hop strips
  removed first; the path is judged as written too. A script in a subdirectory is read the way Symfony strips
  it, with everything before it (`/api/public/index.php/auth/login`, `/api/x/public/index.php/auth/login`).
  Where a path names a script without starting with its path, Symfony cuts as many characters as the
  deploy's `SCRIPT_NAME` has — a length the proxy can't know — so **a path that names a `.php` anywhere and
  holds lukk's last base segment (`auth`, ended by `/`, `\`, `?`, `#` or the end) anywhere is refused**.
  That refuses some paths that never reach lukk, such as `/api/oauth/callback.php`: rename such a route, or
  serve it without `.php`. So is **a path naming more than four `.php`** (in any decoding round), whatever
  it holds: each is a reading judged in full, so their number is bounded rather than the cost being
  quadratic in the path. Paths without `.php` are judged as before. It still can't see the front
  controller where no `.php` names it — shared hosting whose `.htaccess` rewrites into `public/index.php`
  routes `/public/auth/login` as `/auth/login` — nor lukk's extra guard mounts on the same host: point
  `api.target` at a host or prefix that does not serve lukk's routes at all.
  [Details](/transport-modes#authenticating-your-own-api-in-bff).
- **The app-API proxy refuses a path that further percent-decoding turns into lukk's routes**
  (`/api/x/%252e%252e/auth/login`, `/api/%2561uth/login`, and one behind a decoded `?` or `#`) with
  `404` — and **any path in which decoding reveals a whole `.` or `..` segment**, wherever it leads:
  `/api/files/a%2F..%2Fb`, `/api/files/foo%2F.%2Fbar.txt`, `/api/..%2Fx`, `/api/a%5c..%5cb`, and one a
  tab, LF or CR splits (`.%2509.`). A dot inside a segment name (`v1.2`, `.well-known`, `..y`) is
  unaffected. Check that no real API path carries an encoded separator around a dot segment.
- **Route checks collapse repeated slashes**, so `/api//auth/login` is refused like `/api/auth/login`.
- **The auth proxy refuses a path lukk routes nowhere but a hop in front might** with `404`: an empty
  segment (`/api/_lukk//logout`), an encoded slash or backslash (`%2F`, `%5C`) or an encoded `%` (`%25`).
  A trailing run of slashes is still forwarded. [Details](/transport-modes#bff-mode).
- **Both proxies answer `414`** for a path longer than **8 KiB** as the upstream URL serialises it (query
  aside; a `{` or `"` counts three, as `%7B`/`%22`) — nginx's and Apache's default request-line limit.
- **Both proxies refuse a `cross-site` or `same-site` GET that isn't a top-level navigation** (an `<img>`
  pointing at them, say) with `403` — the app-API proxy now too, since it injects the bearer. Only
  `Sec-Fetch-Dest: document` counts as top-level, so a navigation into an `<iframe>`, `<frame>`, `<embed>`
  or `<object>` from another site is refused. Links the visitor follows still work.
- **`/api/_lukk/refresh` accepts `POST` only**; anything else is `405` with `Allow: POST`.
- **The auth proxy caps request bodies** at [`bodyLimit`](/configuration#bodylimit) (1 MiB): over it is
  `413`, a chunked body without a length `411`. Every auth-proxy response carries
  `X-Content-Type-Options: nosniff`, and a non-JSON upstream body goes out as `text/plain`.
- **App-API responses carry `X-Content-Type-Options: nosniff`**, and any that is neither JSON nor a PDF
  also `Content-Security-Policy: sandbox`, added to the upstream's own policy — an HTML or SVG document
  from your API renders without script and outside the app's origin. Serve such documents from another
  origin if they need to run script.
- **The app-API proxy keeps CORS your app's own:** it drops the upstream's `Access-Control-*` and
  hop-by-hop response headers and removes `Origin` upstream. The headers it strips (`Origin`, `Cookie`, the
  spoofable forwarding set, anything named in `Connection`) are now removed, not forwarded empty. A
  header the browser itself sent empty is still forwarded as sent — `Accept` included, with
  `api.forceJson` off.

Sessions and rotation:

- **Sealed sessions expire** after [`session.maxAge`](/configuration#session-maxage) (30 days); keep it at
  least lukk's `refresh_ttl`. A seal written before 0.12.0 has no lifetime until it is next re-sealed.
  `session.maxAge` must be a positive whole number of seconds: anything else fails the build (`0` used to
  seal sessions that never expire), and a runtime override that isn't one makes every session write throw.
- **The BFF session cookie now persists** for `session.maxAge`, restarting on every write. It used to carry
  no `Max-Age`, so BFF users were signed out whenever the browser closed; now they stay signed in like
  direct-mode users. A cleared session's cookie is deleted.
- **A refresh is never abandoned on a timer.** The 15-second upstream deadline covers the auth proxy's own
  calls to lukk, body included, and the background revoke of a dropped session — but **never a refresh**:
  lukk commits a rotation on receipt, so abandoning it would lose the new token and the next refresh, past
  grace, would revoke the whole family (RFC 9700 §4.14.2). No request waits on a slow refresh for more than
  15 s either: `/api/_lukk/refresh` then answers `503` with `Retry-After: 5`, keeping the session (lukk-nuxt's
  client retries once after it, standing down for a logout); a proxied or app-API call goes ahead with the
  old access token; an SSR render leaves the session to the client. A refresh that never settles stops being
  shared after five minutes.
- **Every rotation is [journalled](/transport-modes#a-slow-rotation), and its straggler window starts when
  its cookie leaves.** A link from the consumed token to the pair it produced is recorded untaken and held
  ten minutes; a request still presenting a consumed token is handed the chain's newest pair instead of
  replaying it, and that takes nothing. The 30 s for stragglers start at **delivery** — when a caller's
  cookie carrying the pair actually leaves: the auth proxy's `/refresh` and 401 retry, a step-up
  confirmation, the app-API proxy when the upstream answers (or on its `502`), an SSR render when the page
  is done — set outright on the first delivery, after that only ever brought forward, never past the next
  link's end. A response whose browser went away before it could be sent (aborted request, destroyed
  response or socket) delivers nothing at any delivery point, so its link stays held. At delivery a caller seals the newest pair if the session rotated the one it was
  handed — or, if the session has moved past it and the links that led on are gone, withholds its cookie
  so the browser keeps the newer one: `/api/_lukk/refresh` and a step-up then answer **`409`** (the step-up
  is not recorded, and the user confirms again). The BFF remembers each session's newest refresh token for
  that check ten minutes past the latest rotation, hand-out or response, and for as long as any response that
  may seal a pair for the session is still out — an app-API long-poll has no deadline. `expires_in` counts
  from when lukk minted the token. A logout, and the revoke of a session a sign-in replaced, present the
  journal's current pair rather than the cookie's spent one, so lukk ends the session through the bearer
  instead of reading a replay (and firing `RefreshTokenReused`) — including a session sealed by an earlier
  lukk-nuxt release, whose rotations are journalled under a different key.
  **Two deliberate deviations**, bounded and traded against a false logout: the journal can answer a
  replay up to 10 min 30 s after lukk rotated (a rotation whose cookie never left), or a slow response's
  duration + 30 s — past lukk's own grace window — and those replays never reach lukk, so its reuse
  detection and `RefreshFamilyForked` don't see them (RFC 9700 §4.14.2). **The journal is per process**:
  behind a multi-instance BFF without sticky sessions, use sticky sessions or raise lukk's grace window.
- **A page render's own requests never rotate the session.** A BFF server plugin marks the page request
  (`x-lukk-ssr`, removed before a request reaches your API), so `useLukkFetch` and Nuxt's own
  `useFetch('/api/…')`, `useRequestFetch()` and `event.$fetch` inside the render pass the token on as it is,
  through the app-API proxy and the auth proxy alike (a marked `/refresh` answers `401`; a logout still
  renews, to revoke). The session is renewed once, before the render — by SSR hydration, or with
  `ssrHydrate: false` by a renew-only step that loads no user — so **with `ssrHydrate: false` an aged-out
  page load rotates twice** (the server's renewal, then the client's restore), and both count against lukk's
  per-IP refresh throttle. A server route's `event.$fetch('/api/…')` is not marked: read the session with
  `getLukkAccessToken` there. [Details](/transport-modes#a-render-renews-the-session-once).
- **A `withConfirmation()` still waiting for a step-up is cancelled** — it rejects — when the session ends by
  logout or a sign-in replaces it. It retries once, instead of asking again, when a confirmation landed while
  its request was out. A step-up that can never be earned (`403`) rejects the waiting action even when the
  modal is a different `useLukkConfirmation()` instance. A 2FA challenge left from an earlier attempt is
  dropped by any later sign-in, and when another tab changes the session.
- **A request made for one account is not replayed as another.** In direct mode, when a `401` renewal comes
  back as a different account (another tab signed in; the refresh cookie is shared), lukk-core's client and
  `useLukkFetch` no longer retry the request: it rejects with a `401` whose `reason` is
  [`SESSION_CHANGED`](/lukk-core#errors). The new session is kept and the user reloaded; repeating the action
  as that account is the caller's call. A `401` from another origin — where no credentials went — is no
  longer renewed for at all. `useLukkAuth`'s user load doesn't read that rejection as a sign-out: it asks
  again, once, as the account the session now holds, and failing that counts as a load that couldn't tell,
  leaving the next refresh to notice the switch.
- **A step-up belongs to the session that earned it.** A sign-in (here or in another tab), or a renewal that
  turns out to be another account, drops `confirmed` and the held confirmation token, so the
  `lukk-confirmed` middleware no longer lets the new account through on the old one's step-up.
- **An expired or invalid two-factor challenge** (`422` on `challenge_token`) clears `pendingTwoFactor`, so
  the user signs in again instead of spending the throttle on it. A wrong code keeps it.
- **`experimental.restoreState`**: lukk's session state (`lukk:user`, `lukk:ready`, `lukk:confirmed`, …) is
  taken out of the snapshot Nuxt saves when it reloads the page itself (a chunk error, a new deploy), so it
  can no longer be restored over the session the new page resolved. `useLukkForm` drafts are kept.

`useLukkFetch`, `useLukkForm` and the base path:

- **`useLukkFetch` sends credentials only where it has checked they belong.** Its default is
  `credentials: 'same-origin'`, upgraded per request; a call that passes its own `onRequest` (replacing
  lukk's) or a per-call `baseURL` on another origin now goes out **without** the bearer (direct mode) or the
  cookies (any cross-origin target) and gets a `401`. In BFF mode a same-origin call still carries the
  session cookie, so it is unaffected. Wrap the instance rather than replacing its hook. A relative path with an
  explicitly empty `baseURL` goes to the page's origin and, in direct mode with an absolute API base, carries
  no credentials unless the page is on the API's origin. [Details](/use-lukk-fetch).
- **In direct mode `useLukkFetch` attaches the held step-up token** to requests on the API's own origin, as
  it does the bearer, so `withConfirmation()` can reach a `lukk.confirm`-gated route of your API.
- **Direct-mode SSR** no longer sends the visitor's cookies to an absolute API base, no longer trusts `Host`
  on the server, and keeps an `Accept` you set.
- **`useLukkForm`**: drafts move to `lukk:form:<rememberKey>` (a draft under the old key isn't carried
  over); a cancelled submit rejects with the `AbortError` itself rather than ofetch's `FetchError`; `onFinish`
  runs even when `onError` throws. A new submit aborts one still in flight, and a superseded one that settles
  anyway no longer touches `processing`, `errors` or the success state. `errors` accepts Laravel's dotted keys
  (`errors['authorization.role']`), and `nestedErrors` is typed along `data`. [Details](/use-lukk-form#cancelling-a-submit).
- **`user.endpoint` resolves under `app.baseURL` in BFF mode**, like the proxy mount it points at. In
  direct mode `useLukkFetch` no longer prefixes a relative `api.target` with the app's base. **Action
  needed** if you worked around the old behaviour with a base-prefixed *relative* endpoint:
  `'/admin/api/me'` under `app.baseURL: '/admin/'` now resolves to `/admin/admin/api/me` and `404`s,
  which signs everyone out on load. Drop the prefix (`'/api/me'`). An absolute endpoint keeps working.
- **Types:** `isTwoFactorChallenge` and `isRegistrationPending` accept any value, so
  `isTwoFactorChallenge(await login(...))` type-checks on the composables' results. The module's nested
  options (`api`, `session`, `user`) are optional field by field, as their defaults fill them — a documented
  `api: { path, target }` no longer fails the app's typecheck. In BFF mode `useNuxtApp().$lukk` is typed
  `LukkBffClient`: its sign-ins and renewals resolve the proxy's `{ ok, expires_in }`, and a step-up resolves
  without its token — `useLukkConfirmation().record()` accepts that `{ ok: true }` as well as
  `{ confirmation_token }`. The module's own composables and proxy now type-check under BFF mode too.
  [Details](/lukk-core#methods).
- **`confirmationHeader`** is validated as it ends up — one set through `runtimeConfig.public.lukk` fails the
  build too. [Details](/configuration#confirmationheader).
- **Packaging:** `LUKK_BFF_PREFIX` and `LUKK_SESSION_COOKIE` import as values again
  (`import { LUKK_BFF_PREFIX } from 'lukk-nuxt'` failed with TS1362), `h3` is a declared dependency,
  and the internal `refreshOnce` helper is no longer auto-imported into your server code.
