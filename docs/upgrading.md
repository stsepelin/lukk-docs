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
- **Nothing auto-applies.** lukk's migrations are [publish-only](/installation) and its behavior
  is config-gated — an upgrade only touches what you've opted into.
- **Run your tests** after bumping, then read the entries at or below your target version.

## Highest-impact change right now

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
>
> The full list, including the `AuthenticatedSessionController` constructor change, is in
> [lukk UPGRADE.md](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md).

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
>   passkey or sign in again after every refresh. [Details](/confirmation#with-a-password).
> - **Cookie mode: token routes require JSON.** `login`, `register`, `refresh`, `two-factor-challenge`
>   and `passkeys/login` answer **`415`** unless the request has a JSON body or `Sec-Fetch-Site:
>   same-origin`/`none` (login CSRF, RFC 6265bis §5.7). Send `{}` as JSON for a cookie refresh; lukk-js
>   already does. Body mode is unchanged — except that its `/refresh` no longer reads a leftover refresh
>   cookie at all. [Details](/authentication#output-modes).
> - **Under bcrypt, a password over 72 bytes is refused** — a `422` on register, reset and
>   change-password (lukk adds the check after a [`registerValidation()`](/registration#customizing-the-user-s-fields)
>   rule set too), and "These credentials do not match" at **sign-in** against a bcrypt hash, which lukk
>   could verify only in part. lukk never stored such a password; an import or a hasher with
>   `hashing.bcrypt.limit` off may have, and those users must reset. See [Password policy](/security#password-policy).

lukk `0.7.0`'s smaller changes, each with what to check:

| Change | Impact | What to do |
|---|---|---|
| A failed sign-in takes at least [`login_timebox_micros`](/configuration#sign-in-timebox) (500 ms), every `forgot-password` at least [`password_reset.timebox_micros`](/password-reset#setup) (one second). | Low | Raise either if your slowest real path takes longer — the box pads, it never shortens. Queue the reset notification. |
| [`leeway`](/configuration#refresh-behavior) is clamped to 0–300 s for every token lukk decodes. | Low | A larger `LUKK_LEEWAY` now acts as 300; fix the clock skew instead. |
| [`passkeys.challenge_ttl`](/configuration#passkeys) defaults to 300 (was 120), is sent as the options' `timeout`, and the server keeps the challenge 30 s longer. | Low | None; an explicit `LUKK_PASSKEY_CHALLENGE_TTL` is kept. |
| `ceremony_id` on passkey login and step-up must be the UUID lukk issued. | Low | A custom client sending anything else gets `422` on `ceremony_id`. |
| [Unclaimed sessions](/configuration#refresh-behavior) (`claim_seconds`, off) and `POST /auth/session/claim` are new. | Low | Nothing until you set the key. A custom `RefreshTokenRepository` should populate `RefreshTokenRecord::$original`. |
| With [`block_unverified_login`](/email-verification#blocking-unverified-login) on, an unverified account with two-factor is refused (`403`) before a challenge is issued, and at redemption. | Medium | None — the gate now applies to the two-factor path too. It and `features.email_verification` are read per guard. |
| `DELETE /auth/sessions/others` answers a bare `204` (no `LogoutResponse`, no cookie cleared), and **`409`** for a bearer with no `fid`. | Low | A rebound `LogoutResponse` no longer shapes this route. Co-issuer clients should call `DELETE /auth/sessions`. |
| `features.logout_all` is honoured; `rotation` / `reuse_detection` / `denylist` are removed (never read). | Medium if you set `logout_all` to `false` | `false` now removes `DELETE /auth/sessions` (a `404`). Delete the three dead keys. |
| `LockoutRepository` gained `summariesForSubjects(array $subjects, ?string $guard): array`. | Medium if you implement it | Mirror `forget()`: reach exactly the rows it deletes, scoped to the guard. The [export](/account-deletion#the-export) gains `lockouts`. |
| A success clears only the per-address login bucket; non-account lockout subjects are stored as `idn:sha256:<digest>`. | Low | None. Old locks keep their key and are still found by `lukk:release`, erasure and the export. |
| Per-guard `features.lockout`, `lockout.*`, `rate_limits.login.*` and `rate_limits.two_factor.*` are honoured. | Low | Check that an extra guard's [overrides](/multiple-guards) are what you want enforced — they now are. |
| New [`password_reset.revoke_passkeys`](/password-reset#session-revocation) (off). | Low | Keep `revoke_sessions` on with it. |
| Reset and change-password write the model's `getAuthPasswordName()` column. | Low | Remove any `password` mutator you added to work around the `500`. |
| `lukk.username` must be a plain column name not containing `password`; in debug, one naming no column is refused. | Low | Rename a dotted name that only worked under `authenticateUsing`. |
| `lukk:secret --guard` refuses a name that isn't letters, digits, `_` or `-`. | Low | None. |
| [Authenticator events](/events#authenticator-events) are new. | Low | Listen and notify the user out of band (NIST SP 800-63B-4 §4.1.2.1). |
| `LogoutResponse` clears the cookie per guard and takes `bool $clearRefreshCookie`. | Low | A rebound one must honour the flag — see the logout warning above. |

See [lukk UPGRADE.md](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md) for the full text of each.

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

On the client side, `lukk-nuxt` **0.12.0** is the first release with anything to do on upgrade. Nothing
was renamed or removed, but every composable now declares a real return type where the published
declarations said `any`, so a typecheck that passed before can fail — most often on `user.value.name`,
which needs a `LukkUser` augmentation. `LukkAuth` also becomes a global auto-imported type, and
`lukk-auth` now defers rather than redirecting during a server render that couldn't identify the
visitor. Each with its migration step in
[lukk-js UPGRADE.md](https://github.com/stsepelin/lukk-js/blob/main/UPGRADE.md).

The same release (with `lukk-core` 0.12.0) also changes:

- **The `Amr` type** is `'pwd' | 'otp' | 'pop' | 'user' | 'mfa'`; `'webauthn'` is gone, to match lukk 0.7.0.
- **`refresh` hooks** are typed `() => Promise<RefreshOutcome>` and may return
  [`REFRESHED_WITHOUT_TOKEN`](/lukk-core#renewed-without-a-token). `$lukkRefresh` resolves to that
  symbol in BFF mode rather than the proxy's `{ ok, expires_in }`, and so does the `pair` of `$lukkRestore`'s result.
- **The app-API proxy answers `404` for lukk's own routes.** If your client reached lukk through
  `/api/...`, use the composables. If lukk sits at the root of `api.target`'s host, the proxy refuses
  everything — [move lukk under a prefix](/configuration#api-bff-app-api-proxy).
- **Sealed sessions expire** after [`session.maxAge`](/configuration#session-maxage) (30 days); keep it at
  least lukk's `refresh_ttl`. The auth proxy refuses bodies over [`bodyLimit`](/configuration#bodylimit)
  (1 MiB) with `413`, and chunked bodies with `411`.
- **`useLukkFetch` in direct-mode SSR** no longer sends the visitor's cookies to an absolute API base,
  no longer trusts `Host` on the server, and keeps an `Accept` you set. See [useLukkFetch](/use-lukk-fetch).
- **`useLukkForm` drafts** move to `lukk:form:<rememberKey>`; a draft under the old key isn't carried over.
- **`useLukkPasskeys().confirm()`** uses lukk 0.7.0's step-up options, falling back to the login options
  on a `404` from an older lukk.
- **The BFF session cookie now persists** for [`session.maxAge`](/configuration#session-maxage) (30 days),
  restarting on every write. It used to carry no `Max-Age`, so BFF users were signed out whenever the
  browser closed; now they stay signed in like direct-mode users. A cleared session's cookie is deleted.
- **The app-API proxy keeps CORS your app's own:** it drops the upstream's `Access-Control-*` and
  hop-by-hop headers and blanks `Origin` upstream. The **BFF auth proxy refuses a `cross-site` or
  `same-site` GET that isn't a top-level navigation** (an `<img>` pointing at it, say); links in emails
  still work.
- **Packaging:** `LUKK_BFF_PREFIX` and `LUKK_SESSION_COOKIE` import as values again
  (`import { LUKK_BFF_PREFIX } from 'lukk-nuxt'` failed with TS1362), `h3` is a declared dependency,
  and the internal `refreshOnce` helper is no longer auto-imported into your server code.
- **`useLukkPasskeys().login()`** resolves to a `LoginResult`. When lukk 0.7.0 answers a single-factor
  passkey with a two-factor challenge, `pendingTwoFactor` turns true and no user is loaded: show the same
  code form as after a password sign-in.
