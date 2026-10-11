# Account Deletion & Export

The right to erasure (**GDPR Art. 17**) and the right of access (**Art. 15 / 20**), for the
signed-in user's own account.

```
DELETE /auth/account          erase                  → 204, no-store
GET    /auth/account/export   everything lukk knows  → 200 JSON, no-store
```

Both need [step-up confirmation](/confirmation), and a [pinned](/abilities#derived-vs-pinned-grants)
token also needs the `lukk.account.delete` [ability](/abilities) — a derived grant (a human login) is
never refused by that gate. Erasure is irreversible and the export discloses everything lukk holds
about someone, so authentication alone must not be enough.

| Route | Middleware |
|---|---|
| `DELETE /auth/account` | `auth` + `lukk.confirm` + `RequirePinnedAbility:lukk.account.delete` (no route throttle of its own) |
| `GET /auth/account/export` | the same, plus `throttle:lukk-confirm` — the step-up budget, shared on purpose, so one confirmation can't be spent on bulk reads |

Both mount on the **default guard only**; an [extra guard](/multiple-guards) gets the core session
routes, not these.

> [!WARNING]
> **Step-up on its own does not keep a machine token out.** A confirmation is
> [bound to the session that earned it](/confirmation#bound-to-the-session-that-earned-it), so a
> [pinned token](/abilities#derived-vs-pinned-grants) can no longer present one the user's browser
> earned — but a pin carrying `lukk.account` can earn its *own*. That is why these routes carry a
> separate ability, and why `lukk.account.delete` is deliberately **not** covered by `lukk.account`:
> that ability already meant "manage my credentials", and widening it would have handed every
> existing token carrying it the power to destroy the account.
>
> [`features.gate_auth_routes`](/configuration#feature-toggles) does **not** switch this gate off, unlike
> lukk's other own-route gates. That flag exists to restore pre-`0.6` reach for tokens issued before
> abilities existed; these routes have no pre-`0.6` behaviour to restore, so honouring it would grant
> a narrow machine token an irreversible new power rather than give back an old one.

`features.account_deletion` defaults to **on**. Erasure is a legal right, and a default of off means
most installs quietly don't offer one. Turn it off where deletion belongs elsewhere:

```php
// config/lukk.php
'features' => ['account_deletion' => false],
```

## What erasure actually does

In this order, and the order is the substance:

1. **Reads the identifier**, while the user row is still whole.
2. **Revokes every session** — denylist first, so every access token dies immediately across every
   node.
3. **Erases lukk's artifacts and the user**, in one transaction (one per connection involved — see
   below): refresh tokens, passkeys, lockout counters, a pending password-reset row, then the row
   itself (which carries the two-factor material).
4. **Fires `AccountDeleted`** after the commit.

> [!IMPORTANT]
> **Lockout counters occupy three key spaces**, and the raw identifier is none of them:
> `id:<user id>` for the account's login counter, `idn:sha256:<digest>` for the login counter on
> the folded identifier, which every login failure also counts against (`idn:<normalized identifier>` for a lock written before lukk 0.7.0, which erasure
> still sweeps), and the bare user id for the step-up and two-factor caps. Step 1 exists because
> the `idn:` space is reachable only through the identifier — read it after the row is gone and those
> rows are unreachable forever, still naming someone who asked to be forgotten.

Passkeys are erased through whatever [`PasskeyRepository`](/customization#available-contracts) is bound, and the export reads them the same way (lukk 0.7.0). Earlier releases checked for a table literally named `passkeys` first, so a store that isn't that table — Redis, another service, a renamed model — was skipped: erasure reported success while the passkeys survived, and the export omitted them. A replacement store must therefore answer an empty or not-yet-provisioned store with `0` and `[]` rather than throw.

The pending password-reset row is deleted through the broker named by [`password_reset.broker`](/password-reset#setup) (or the default one) whenever that broker's table exists — whether or not `features.password_reset` is on, because the row holds the email address in plaintext and Laravel doesn't garbage-collect the table by default. The table is looked for on the broker's own connection, `auth.passwords.<broker>.connection` (lukk 0.7.0); earlier releases looked on the default connection, so a broker on another one kept the row after the account was gone. That key may name the connection with an enum, backed or pure, as Laravel's config allows; a pure enum stands for its case name (lukk 0.7.0 — before, an enum there threw before anything was erased).

Steps 2 and 3 are ordered deliberately too. Revoking first means a failure later leaves the account
**unreachable** rather than half-erased and still usable. And running everything else in one
transaction means a partial erasure can't happen — an account with no credentials that still exists
cannot log in, cannot be recovered, and cannot be erased again.

## Erasing your own data

lukk owns only the auth side. Your domain data is yours to erase, and two events exist for it:

```php
use Lukk\Events\AccountDeleting;
use Lukk\Events\AccountDeleted;

// INSIDE the transaction. Throw to abort the whole erasure.
Event::listen(AccountDeleting::class, function (AccountDeleting $event) {
    $event->user->orders()->delete();      // the user model is still intact here
});

// AFTER the commit. For work that must not be rolled back.
Event::listen(AccountDeleted::class, function (AccountDeleted $event) {
    ProcessorErasure::dispatch($event->userId);
});
```

| | `AccountDeleting` | `AccountDeleted` |
|---|---|---|
| When | before anything is erased | after the commit |
| Transaction | inside it — **throwing aborts the deletion** | outside it |
| Carries | `user` (the intact model) and `guard` | `userId`, `identifier` (the `lukk.username` value, or `null`) and `guard` |
| For | erasing your own rows | telling someone else to erase theirs |

`AccountDeleted` carries identifiers rather than the model on purpose: the row is gone, and handing
a listener a deleted Eloquent instance invites someone to `save()` it back. Note it **does** carry
the identifier — keep it out of logs.

> [!WARNING]
> A listener on `AccountDeleting` runs inside a database transaction, holding it open. Erase rows;
> don't call a payment processor. That belongs in `AccountDeleted`.
>
> Throwing aborts the **deletion**, but not the session revocation — that already happened, by
> design, so a failure can't leave an account half-erased and still usable. The subject keeps their
> account and has to log in again.

> [!NOTE]
> **The all-or-nothing guarantee is per database connection.** SQL has no cross-connection
> transaction without two-phase commit, so when the rows erasure writes live on more than one
> connection, each gets its own transaction. lukk opens one on every connection it writes to — the
> default one (passkeys, lockouts, your `AccountDeleting` listeners' default queries), the password
> broker's, the refresh-token store's (a [`useRefreshTokenModel`](/customization#swapping-the-refresh-token-model)
> model may have its own), and the user model's — nested, so a connection named twice is a savepoint
> rather than a second transaction (lukk 0.7.0; earlier releases opened only the token store's, so with
> that model elsewhere the passkey, lockout and reset-row deletes ran in autocommit, and a disposal that
> threw kept the user and lost their credentials). So anything that *throws* during erasure rolls
> them all back. What can't be covered is a failure during the commit itself, which
> can leave the user erased and lukk's rows restored. That's the direction lukk prefers anyway (the
> account is unreachable rather than half-erased and still usable), and `lukk:prune` sweeps what's
> left, but it isn't all-or-nothing and this page won't claim it is.

> [!CAUTION]
> **Listen to `AccountDeleting` synchronously.** A `ShouldQueue` listener is pushed when the event is
> dispatched, not when the transaction commits (Laravel's `after_commit` is off by default) — so its
> work is already on the wire if the erasure then rolls back. Your domain data is gone and the
> account it belonged to still exists: precisely the half-erased outcome the transaction is there to
> prevent. Queue from `AccountDeleted`, which fires once the erasure is a fact.
>
> For the same reason, don't queue `AccountDeleting` itself. It carries the whole user model, so
> serializing it writes the subject's email, password hash and encrypted two-factor secret into your
> `jobs` table — and into `failed_jobs`, which nothing prunes. That residue outlives the erasure that
> triggered it.

## Anonymizing instead of deleting

Sometimes the row has to survive — an anonymized order history, a retention obligation that outlives
the erasure request, a tombstone that stops the same identifier re-registering:

```php
Lukk::deleteUserUsing(function ($user) {
    $user->forceFill([
        'email' => 'anonymized-'.$user->getKey().'@example.invalid',
        'name' => 'Deleted user',
        // Two-factor material lives in columns ON this row. Miss these and the "erased"
        // account keeps a working authenticator.
        'two_factor_secret' => null,
        'two_factor_recovery_codes' => null,
        'two_factor_confirmed_at' => null,
    ])->save();
});
```

Everything lukk owns is still erased — only the row's fate changes.

> [!WARNING]
> The default disposal is **`forceDelete()`** where the model supports it. `delete()` on a
> `SoftDeletes` model is a silent no-op for Art. 17: the name, email, password hash and a live
> encrypted TOTP secret all survive. It also leaves the subject unable to return — re-registering
> the same address hits the database's unique index, which the `unique` validation rule's
> soft-delete scope ignores. If you want the row to survive, say so here, explicitly.

## The export

```json
{
  "generated_at": "2026-03-04T05:06:07+00:00",
  "account": { "id": 1, "identifier": "subject@example.com" },
  "sessions": [{ "session": "…", "created_at": "…", "last_rotated_at": "…", "revoked_at": null, "expires_at": "…", "amr": ["pwd", "otp", "mfa"], "authenticated_at": "2026-08-22T09:00:00+00:00" }],
  "passkeys": [{ "credential_id": "…", "name": "Yubikey at HQ", "created_at": "2026-08-01T10:00:00+00:00", "last_used_at": "2026-08-22T09:12:58+00:00", "aaguid": "…", "transports": ["usb", "nfc"] }],
  "two_factor": { "enabled": true, "confirmed_at": "…", "pending": false, "recovery_codes_remaining": 7 },
  "lockouts": [{ "purpose": "login", "attempts": 3, "locked_at": null, "first_failed_at": "2026-08-22T09:30:00+00:00", "last_failed_at": "2026-08-22T09:46:18+00:00" }],
  "password_reset": { "requested_at": "2026-08-22T09:50:00+00:00" }
}
```

`sessions` holds one entry per refresh-token row, not per session: every rotation writes a row, so a
session that refreshed ten times appears ten times under the same `session` (its family id), each with
its own times. From lukk 0.7.0 each entry also says how and when that session was signed in: `amr` (the
[RFC 8176 methods](/tokens-and-rotation#the-amr-claim)) and `authenticated_at` (its
[`auth_time`](/tokens-and-rotation#the-auth-time-claim), ISO-8601) — `null` where the row doesn't record them.

Every time in the export is an ISO-8601 string. From lukk 0.7.0 each passkey also carries
`created_at`, `aaguid` (the authenticator model) and `transports` — everything erasure destroys that
describes the person, so Art. 15 discloses what Art. 17 deletes — and its `last_used_at` is ISO-8601
too; it used to be unix seconds. The COSE public key and the sign counter stay out. Each entry is
mapped through an allowlist, so a [`PasskeyRepository`](/customization#available-contracts) returning
more cannot publish it; a store that doesn't supply the three new fields reports them as `null`.

`lockouts` arrives with lukk 0.7.0: the [account-lockout](/account-lockout) counters held against the account, which erasure also deletes. It reports the purpose, the attempt count and ISO-8601 timestamps (`locked_at` is `null` while the counter is not locked) — never lukk's internal subject keys. A custom `LockoutRepository` must implement `summariesForSubjects()` to supply it — and, from lukk 0.7.0, it is called (with `forget()` on erasure) whether or not a `lukk_lockouts` table exists, so a store kept elsewhere no longer leaves a deleted account's counters behind or out of the export.

lukk 0.7.0 also discloses the other facts erasure deletes, since GDPR Art. 15 must disclose what Art. 17
destroys:

- `two_factor.pending` — a TOTP secret was enrolled and never confirmed.
- `two_factor.recovery_codes_remaining` — how many unused recovery codes are left (`null` for a user model
  without `recoveryCodesRemaining()`). Never a code or its hash.
- `password_reset` — `{ "requested_at": … }` for a pending reset row on the configured broker's table and
  connection (`lukk.password_reset.broker`), or `null`. The row holds the address in plain text until the
  broker prunes it; the token is never included. `ExportAccount` takes the broker name as a new trailing
  optional constructor argument.

> [!WARNING]
> **This is the auth slice, not a complete Art. 15 response.** lukk knows about sessions, passkeys,
> lockout counters and whether two-factor is on. It knows nothing about the data your subject actually cares about.
> Append your own before you hand it over — a half-answer that looks whole is worse than no
> endpoint.

**Credential material is deliberately excluded.** A TOTP secret, recovery codes and refresh-token
hashes are not personal data a subject benefits from receiving — they are secrets whose only use is
authenticating *as* them, and Art. 15(4) says the right of access must not adversely affect others.
Handing a live second factor to whoever intercepts the export is exactly that. What is included is
the *fact* of each credential: this passkey exists, it was last used then.

## On the client

```ts
const { deleteAccount, exportAccount, busy } = useLukkAccount()
```

Both route through the confirmation flow, so a missing step-up surfaces your confirmation UI and
retries once. `deleteAccount()` clears local auth state on success — the server has already revoked
every token, but `user` would otherwise describe an account that no longer exists. A **failed**
erasure leaves that state alone.

## What lukk does not do

- **It doesn't cascade at the database level.** No foreign keys, no `ON DELETE CASCADE` — lukk can't
  know your users table's name or key type. Erasure is application-level and works with soft deletes
  and anonymization, which an FK cascade would not.
- **It doesn't fully erase users deleted outside this route.** Delete a row directly and lukk's
  artifacts survive: `lukk:prune` clears expired refresh tokens, spent lockout counters and
  **orphaned passkeys**, but a live refresh token lives until `refresh_ttl`. If you delete users
  elsewhere, call the `DeleteAccount` action, or hook your own model's `deleting` event.
- **It doesn't retain an erasure record.** If you need to evidence that a request was honoured,
  listen to `AccountDeleted` and write your own — lukk deliberately keeps nothing.

Next: **[Multiple Guards](/multiple-guards)**
