# Account Deletion & Export

The right to erasure (**GDPR Art. 17**) and the right of access (**Art. 15 / 20**), for the
signed-in user's own account.

```
DELETE /auth/account          erase
GET    /auth/account/export   everything lukk knows
```

Both need [step-up confirmation](/confirmation) **and** the `lukk.account.delete`
[ability](/abilities). Erasure is irreversible and the export discloses everything lukk holds about
someone, so authentication alone must not be enough.

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
3. **Erases lukk's artifacts and the user**, in one transaction: refresh tokens, passkeys,
   two-factor material, lockout counters, then the row itself.
4. **Fires `AccountDeleted`** after the commit.

> [!IMPORTANT]
> **Lockout counters occupy three key spaces**, and the raw identifier is none of them:
> `id:<user id>` for a login failure against a real account, `idn:<normalized identifier>` for one
> naming no account, and the bare user id for the step-up and two-factor caps. Step 1 exists because
> the `idn:` space is reachable only through the identifier — read it after the row is gone and those
> rows are unreachable forever, still naming someone who asked to be forgotten.

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
| Carries | the intact user model | identifiers only |
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
  "sessions": [{ "session": "…", "guard": null, "created_at": "…", "expires_at": "…" }],
  "passkeys": [{ "credential_id": "…", "name": "Yubikey at HQ", "last_used_at": 1787391978 }],
  "two_factor": { "enabled": true, "confirmed_at": "…" }
}
```

> [!WARNING]
> **This is the auth slice, not a complete Art. 15 response.** lukk knows about sessions, passkeys
> and whether two-factor is on. It knows nothing about the data your subject actually cares about.
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
