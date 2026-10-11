# Passkeys

lukk supports passkeys (WebAuthn / FIDO2) for **passwordless, phishing-resistant** login. A passkey is a public-key credential bound to your domain and stored on the user's device or password manager; logging in proves possession of the private key, which a phishing site can never obtain. The server owns the relying-party config, the challenges, and the credential store; the client's `useLukkPasskeys` drives the browser `navigator.credentials` ceremony.

> [!NOTE]
> Passkeys must be enabled on the server (`features.passkeys`, plus an `rp_id` and `origins`). WebAuthn requires a secure context (HTTPS, or `localhost`).

## Server (Laravel)

### Setup

Install the WebAuthn library (the default ceremony adapter wraps it), publish and run the migration, enable the feature, and set your relying-party configuration:

```bash
composer require web-auth/webauthn-lib
php artisan vendor:publish --tag=lukk-passkey-migrations
php artisan migrate
```

```php
// config/lukk.php
'features' => [
    'passkeys' => true,
    // ...
],

'passkeys' => [
    'rp_id' => 'example.com',                  // registrable domain shared by app + api
    'origins' => ['https://app.example.com'],  // your front-end origin(s)
],
```

See [Configuration → Passkeys](/configuration#passkeys) for every option.

> [!NOTE]
> The default adapter, `Passkeys\SpomkyWebAuthnCeremony`, works out of the box. To use a different WebAuthn library, rebind `Contracts\WebAuthnCeremony`.

### Endpoints

These routes are registered only when `features.passkeys` is enabled.

| Method | Path | Middleware | Purpose |
|---|---|---|---|
| `POST` | `/auth/passkeys/registration-options` | `auth` + confirm | Get a registration challenge → the bare WebAuthn creation options (no `ceremony_id`; the challenge is cached per user). |
| `POST` | `/auth/passkeys` | `auth` + confirm | Body `{ credential, name? }` (`name` a string of at most 255 characters, valid UTF-8 — otherwise `422`). Verify the attestation and store the credential → `204`. |
| `POST` | `/auth/passkeys/login-options` | `throttle` | Get an assertion challenge → `{ ceremony_id, options }`. |
| `POST` | `/auth/passkeys/login` | `throttle` | Body `{ ceremony_id, credential }`; `credential.id` must be a valid-UTF-8 string (`422` otherwise, here and on `confirm-passkey`). Verify the assertion → token pair (`amr: ["pop","user"]`, plus `"mfa"` for a [multi-factor assertion](#when-a-passkey-counts-as-multi-factor)), or a two-factor challenge. `401` when the credential's account no longer exists; `403` for an unverified account under [`block_unverified_login`](/email-verification#blocking-unverified-login). |
| `POST` | `/auth/confirm-passkey/options` | `auth` + `lukk.account`¹ + `throttle:lukk-passkeys` | Get a step-up challenge for the signed-in user → `{ ceremony_id, options }` (lukk 0.7.0). Metered per address only, on the passkey budget. |
| `POST` | `/auth/confirm-passkey` | `auth` + `lukk.account`¹ + `throttle:lukk-confirm` | Satisfy [step-up confirmation](/confirmation) with a passkey. |
| `GET` | `/auth/passkeys` | `auth` + `lukk.account`¹ | List the user's credentials → `{ passkeys: [{ id, name, last_used_at }] }` (`last_used_at` in unix seconds, or `null`). |
| `DELETE` | `/auth/passkeys/{id}` | `auth` + confirm | Revoke a credential → `204`, whether or not it existed. |

¹ `RequirePinnedAbility:lukk.account` — refuses a [pinned](/abilities#derived-vs-pinned-grants) token without that ability (`403`); a human login is never refused by it. See [Abilities → lukk's own routes](/abilities#lukk-s-own-routes).

### Registering a passkey

Registration happens while the user is logged in (and has [confirmed](/confirmation) their identity):

1. The client requests options from `/auth/passkeys/registration-options` and passes them to the browser's `navigator.credentials.create()`.
2. The browser returns an attestation, which the client posts to `/auth/passkeys`. lukk verifies it and stores the credential.

What the creation options ask for, and what registration accepts:

- **A discoverable credential** (`residentKey: required`). Passwordless login sends no `allowCredentials`, so a non-discoverable key could never be found at sign-in.
- **User verification** per [`passkeys.user_verification`](/configuration#passkeys) (`required` by default), and it is **enforced** on the attestation, not only asked for — at the default an authenticator that doesn't verify the user can't register.
- **ES256 or RS256** keys only — the two algorithms advertised in `pubKeyCredParams`, which are also the only ones verification accepts.
- **No attestation.** Only the `none` attestation format is supported; lukk records the AAGUID but doesn't verify the authenticator's make and model.

```mermaid
sequenceDiagram
    participant App as App (client)
    participant B as Browser + Authenticator
    participant API as lukk API

    App->>API: POST /auth/passkeys/registration-options (auth + confirm)
    API-->>App: { challenge, rp, user, ... }  (challenge cached per user)
    App->>B: navigator.credentials.create(options)
    B-->>App: attestation (new credential + public key)
    App->>API: POST /auth/passkeys { credential }
    Note over API: verify attestation vs cached challenge,<br/>rp_id + origin · store credential (COSE key encrypted)
    API-->>App: 204 No Content
```

### Logging in with a passkey

Login is fully passwordless:

1. The client requests options from `/auth/passkeys/login-options`. The response includes an opaque `ceremony_id` and the WebAuthn `options`; pass the options to `navigator.credentials.get()`.
2. The browser returns an assertion, which the client posts to `/auth/passkeys/login` along with the `ceremony_id`. lukk claims the challenge, verifies the signature and then either:
   - returns the normal [token pair](/authentication#logging-in), carrying `amr: ["pop","user","mfa"]` when the assertion was [multi-factor](#when-a-passkey-counts-as-multi-factor) — or `["pop","user"]` on an account with no confirmed TOTP; or
   - answers `{ "two_factor": true, "challenge_token": "…" }` when the assertion was single-factor and the account has a confirmed TOTP. The client completes it at `/auth/two-factor-challenge`, exactly like the [password path](/two-factor-authentication#logging-in-with-2fa).

The `ceremony_id` is the UUID lukk issued. Anything else is refused with `422` before it reaches the cache (lukk 0.7.0).

```mermaid
sequenceDiagram
    participant App as App (client)
    participant B as Browser + Authenticator
    participant API as lukk API

    App->>API: POST /auth/passkeys/login-options
    API-->>App: { ceremony_id, options.challenge }  (challenge cached by ceremony_id)
    App->>B: navigator.credentials.get(options)
    B-->>App: assertion (signed by the private key)
    App->>API: POST /auth/passkeys/login { ceremony_id, credential }
    Note over API: claim challenge atomically (single-use),<br/>verify origin/rp_id, signature vs stored public key,<br/>sign-count · resolve user
    alt multi-factor assertion, or no confirmed TOTP
        API-->>App: 200 { access_token, refresh_token }
    else single-factor assertion and a confirmed TOTP
        API-->>App: 200 { two_factor: true, challenge_token }
        App->>API: POST /auth/two-factor-challenge { challenge_token, code }
        API-->>App: 200 { access_token, refresh_token } · amr pop, user, otp
    end
```

The challenge is server-generated, single-use, and held server-side (in the cache) — it never travels inside a JWT. Redemption **claims** it with an atomic cache `add()` keyed on the challenge value (lukk 0.7.0), so of two concurrent requests presenting the same ceremony exactly one wins; `Cache::pull()`, which it replaced, is a get followed by a forget. The claim is atomic only on a store that implements `add()` natively (Redis, Memcached, database, file, DynamoDB) — not APC or the array store, where the cache falls back to get-then-put.

**Timing (lukk 0.7.0).** The options carry a WebAuthn `timeout` equal to [`passkeys.challenge_ttl`](/configuration#passkeys), in milliseconds, which now defaults to **300 seconds** (it was 120) — the WebAuthn L3 §15.1 recommendation for a ceremony that verifies the user, since a PIN, a biometric or a phone reached over hybrid transport routinely outlasts two minutes. Before, the options carried no `timeout`, so the browser's own default applied while lukk's challenge lasted two minutes, and a slow entry ended in "could not be verified". The server keeps the challenge **30 seconds longer** than the advertised `timeout`: the browser may close the prompt at exactly that moment (WebAuthn L3 §5.4, §5.5), and an assertion completed at the last second is still in transit. An explicit `LUKK_PASSKEY_CHALLENGE_TTL` is kept.

### When a passkey counts as multi-factor

**lukk 0.7.0.** A passkey is always possession of a key. It is *also* a second factor only when the authenticator verified the user (a PIN or a biometric), and lukk decides that per **assertion**, not from config:

- the assertion carries the user-verification (UV) flag, **and**
- the credential was already `uvInitialized` before this ceremony — it had shown user verification before.

The second condition is WebAuthn L3 §4's own rule: the UV flag must not be relied on for a credential that has never presented it. It closes the case of a stolen security key with no PIN, whose thief sets a PIN and presents UV from then on. lukk never promotes `uvInitialized` itself.

What that decides:

| Assertion | `amr` | An enrolled TOTP |
|---|---|---|
| Multi-factor | `["pop","user","mfa"]` | Skipped — the passkey already is two factors. |
| Single-factor (presence only, or UV not yet trusted) | `["pop","user"]` | **Challenged.** Login answers `{ "two_factor": true, "challenge_token": "…" }`, exactly like the [password path](/two-factor-authentication#logging-in-with-2fa). Redeeming it gives `["pop","user","otp"]`, without `mfa`. |

The last row is deliberately not `mfa`. A TOTP is possession too (NIST SP 800-63B-4 §3.1.4, §3.1.6), and two possession factors don't make multi-factor: §2.2.1 requires a password or a biometric comparison alongside a physical authenticator. Up to lukk 0.6 a passkey login skipped an enrolled TOTP unconditionally, and stamped `amr: ["webauthn"]`, a value outside the RFC 8176 registry.

`passkeys.user_verification` is still what lukk *asks* the authenticator for at login. It no longer decides whether the second factor is skipped: config is what was asked for, the assertion is what happened.

In lukk-js, `useLukkPasskeys().login()` resolves to that answer (lukk-nuxt 0.12). On a challenge it sets `pendingTwoFactor` and loads no user; complete it with `useLukkAuth().verifyTwoFactor()`, exactly as after a password sign-in.

### Managing passkeys

`GET /auth/passkeys` lists the current user's credentials, and `DELETE /auth/passkeys/{id}` revokes one (behind step-up confirmation).

Registering one dispatches [`PasskeyRegistered`](/events#authenticator-events), and removing one dispatches `PasskeyDeleted`. Listen to tell the user through another channel (lukk 0.7.0).

### Step-up with a passkey

`POST /auth/confirm-passkey` earns a [confirmation token](/confirmation), and that token is what binds and removes authenticators. So from lukk 0.7.0 it must meet the **account's own highest available level** (NIST SP 800-63B-4 §4.1.2.1):

- A **multi-factor** assertion always meets it.
- A **single-factor** assertion is refused when the account can reach AAL2: it has a password, or any passkey that has shown user verification. A stored value no password can ever match (`!`, `*`, an import placeholder, a truncated hash) is not a password here — only under Laravel's stock `EloquentUserProvider` using the application's own bcrypt or Argon hasher, where lukk can prove it with `crypt()`. Nobody can present such a value, so it does not lock the account out of step-up. Anything lukk cannot prove unusable — a legacy crypt hash under `hashing.bcrypt.verify` off, a provider or driver with its own hasher — still counts as a password, the safe direction. It is accepted only on a password-less account whose credentials are all single-factor, which has nothing stronger and would otherwise be stranded.

Negotiate the ceremony with `POST /auth/confirm-passkey/options` (authenticated) rather than the anonymous `passkeys/login-options`. It lists the user's own credentials, so a non-discoverable key works, and asks for `userVerification: required` exactly when the account can reach AAL2. The same requirement is **enforced** on the assertion, so options fetched from the login route gain nothing.

```http
POST /auth/confirm-passkey
Authorization: Bearer <access token>
Content-Type: application/json

{ "ceremony_id": "…", "credential": { … } }
```

A refused step-up answers **`422` on `credential`**, like a failed verification — not `403`. On a step-up route `403` means the token itself may never confirm, and clients abandon the prompt on it; here only the credential fell short, and the password or another passkey still works. The route takes no TOTP code: a TOTP is possession, like the passkey, so it can't lift the step-up to AAL2.

Two more checks apply to a step-up (lukk 0.7.0):

- **The credential must belong to the signed-in account.** The step-up passes that account to the ceremony as the expected user handle (WebAuthn L3 §7.2 step 6), so an assertion whose `userHandle` names another account is refused. A non-discoverable key, which returns no user handle, still works.
- **An accepted passkey clears the password-confirm [lockout](/account-lockout) only after every check has passed.** A step-up refused for the account's level used to clear it first, so alternating a refused passkey with password guesses reset the counter.

### Split-domain (BFF) deployments

When your front-end and API live on different subdomains (`app.example.com` and `api.example.com`), set:

- **`rp_id`** to the registrable domain they share — `example.com`, **not** `api.example.com`.
- **`origins`** to include the front-end origin — `https://app.example.com` — because the browser reports the front-end's origin, not the API's.

### Security notes

- Credential IDs are globally unique, and the COSE public key is **encrypted at rest**.
- A regressing signature counter is rejected and dispatches `Events\PasskeyCloneDetected`, but a credential whose **stored** counter is `0` is never flagged — synced passkeys (iCloud, Google, 1Password) always report `0`. Once the stored counter is non-zero, an assertion reporting `0` (or any value not above it) is a regression. The stored counter only ever moves forward (lukk 0.7.0): the write is conditional on the stored value being lower, so two concurrent assertions can't roll it back and let a clone presenting the higher value pass later. And of two concurrent assertions presenting the *same* non-zero counter, only the one whose write wins passes — the other is refused as a clone, with the same event (WebAuthn L3 §6.1.1). A credential deleted while its ceremony was in flight writes nothing either; it is refused, but without the alarm — whatever its counter did (lukk 0.7.0): a synced passkey reports `0` forever, and a check gated on an advancing counter let one the user had just removed (a stolen one, say) still sign in.
- **A passkey sign-in clears the password-confirm [lockout](/account-lockout) only when it grants a session on a multi-factor assertion** (lukk 0.7.0). This is lukk's own recovery path rather than the spec's — NIST SP 800-63B-4 §3.2.2 asks to disregard failures only for the authenticator that then succeeds, and a passkey isn't the password — so it lets a user who verifies with a PIN or biometric out of a confirm lock a token thief may have run up. Ending a run of password-confirm failures has to prove at least what a step-up would: a presence-only key proves possession alone, so with a stolen access token, signing in with it between password guesses would wipe the count every time and make the guesses unlimited (NIST SP 800-63B-4 §3.2.2). A sign-in refused by a later gate, or answered with a two-factor challenge, clears nothing. If you call `Lukk\Actions\FinishPasskeyLogin` from your own code, it no longer clears the lock itself — call `releaseConfirmLock($passkey)` once you have granted what the assertion was for.
- `rp_id` and `origins` are **required** when passkeys are enabled — lukk throws on an empty value rather than fall back to a weak default.
- By default lukk **asks for user verification** at login (`user_verification` → `required`) — the authenticator must verify the user (biometric/PIN), not just their presence. Lower it to `preferred` only if you must support authenticators that can't verify the user (see [Configuration](/configuration#passkeys)). Whether a given login *was* multi-factor is read from the assertion, [not from this setting](#when-a-passkey-counts-as-multi-factor), and a step-up sets its own requirement.
- Registration is verified against the COSE algorithms lukk advertised in the options (WebAuthn L3 §7.1), not a library default.
- An undecryptable stored credential (a rotated `APP_KEY` without `app.previous_keys`, a corrupt row) reads as one that doesn't match, rather than a `500`.
- The model hides `public_key` and `aaguid` from serialization (lukk 0.7.0), so `$user->passkeys` in a response no longer publishes the COSE key or the AAGUID that fingerprints the authenticator's make and model.
- Passkey storage sits behind `Contracts\PasskeyRepository` (`passkeys` table) and is swappable. A replacement must make `updateSignCount()` forward-only and answer an empty store on erasure, export and reset — see [Customization](/customization#available-contracts).
- Credentials are **scoped to a guard** (a `guard` column, as of `0.6.0`). Under [multiple guards](/multiple-guards) the assertion lookup takes a credential id and no user, so without scoping an admin's authenticator could resolve on the users guard. Single-guard installs are unaffected and the column stays null.

> [!WARNING]
> Passkeys are only as phishing-resistant as your weakest fallback. In lukk's default model, password login is always available — so deleting all passkeys can never lock a user out. For a **passwordless-only** deployment, guard the last credential at your application layer and ensure any recovery path is itself phishing-resistant; otherwise an attacker can downgrade to the weaker method.

## Client (Nuxt)

`useLukkPasskeys` drives the browser ceremony (`navigator.credentials`) and the base64url (de)serialization for you — you just `await` a verb. If the browser resolves the ceremony with no credential, the verb rejects with `lukk: the browser returned no passkey credential` rather than a `TypeError` from deep in the serializer (lukk-nuxt 0.12.0).

> [!IMPORTANT]
> Passkeys are phishing-resistant only because the authenticator binds each assertion to the **browser-facing origin**. Set lukk's `rp_id` to your app's registrable domain and `origins` to the exact origin in the address bar — **not** the lukk API host. In BFF mode the browser talks to your app, so the RP is your app's origin, even though the API lives elsewhere. Avoid wildcard origins. See [Split-domain (BFF) deployments](#split-domain-bff-deployments) above for setting `rp_id`/`origins` on the server.

### `useLukkPasskeys`

```ts
const {
  register, // (name?) => Promise<void>
  login,    // () => Promise<LoginResult | BffSignInResult> — passwordless; a session, or a two-factor challenge
  confirm,  // () => Promise<void>   — step-up via passkey
  list,     // () => Promise<{ passkeys: PasskeySummary[] }>
  remove,   // (credentialId) => Promise<void>
} = useLukkPasskeys()
```

### Registering a passkey

Registration is a sensitive action, so it sits behind [step-up confirmation](/confirmation). Confirm first, then register:

```mermaid
sequenceDiagram
    participant App
    participant Browser as navigator.credentials
    participant Lukk as lukk
    App->>Lukk: passkey registration options
    Lukk-->>App: creation options (challenge, rp, user)
    App->>Browser: create(options)
    Browser-->>App: attestation credential
    App->>Lukk: register passkey (credential, name)
    Lukk-->>App: 204
```

```ts
const { confirmPassword } = useLukkConfirmation()
const { register } = useLukkPasskeys()

await confirmPassword(currentPassword) // step up
await register('My MacBook')           // name is optional
```

The browser prompts the user to create the passkey; `register` handles the options, the ceremony, and posting the result to lukk.

### Passwordless login

`login()` runs the assertion ceremony and, on success, persists the tokens and loads the user — no email or password. It resolves to a `LoginResult` (in BFF mode a session comes back as the proxy's `{ ok: true, expires_in }`, typed `BffSignInResult` — lukk-nuxt 0.12.0): when the assertion was single-factor and the account has a confirmed TOTP, lukk answers with a two-factor challenge instead of a session, `pendingTwoFactor` is set, and no user is loaded:

```vue
<script setup lang="ts">
const { login } = useLukkPasskeys()
const { pendingTwoFactor } = useLukkAuth()

async function signInWithPasskey() {
  await login()
  if (pendingTwoFactor.value) {
    return navigateTo('/two-factor') // complete it with useLukkAuth().verifyTwoFactor()
  }
  await navigateTo('/dashboard')
}
</script>
```

A user can register a passkey on one device and sign in with it on another (synced passkeys "just work" — lukk never flags a zero sign-count).

### Managing passkeys

List the user's passkeys for a settings screen, and remove one by its credential id:

```ts
const { list, remove } = useLukkPasskeys()

const { passkeys } = await list()
// passkeys: { id, name, last_used_at }[] — never the key material

await remove(passkeys[0]!.id) // `!` under `noUncheckedIndexedAccess`
```

> [!NOTE]
> Removing a passkey is a sensitive action and is gated behind [confirmation](/confirmation) on the lukk side.

### Step-up with a passkey

A user can also satisfy [step-up confirmation](/confirmation) with a passkey instead of their password — convenient, and phishing-resistant:

```ts
const { confirm } = useLukkPasskeys()
await confirm() // runs an assertion → stores a confirmation token
```

`confirm()` asks lukk's step-up options (`passkeyConfirmationOptions()`, `POST /auth/confirm-passkey/options`), so the authenticator is asked for user verification whenever lukk will require it. Against a lukk older than 0.7.0 that route answers `404`, and only then does it fall back to the login options. A `403` from the options route abandons the pending confirmation, as a `403` from `confirm-passkey` already did. A passkey that falls short of the account's level rejects with a `422` on `credential`; offer the password instead.

After `confirm()`, the next sensitive action (managing 2FA, registering another passkey) is authorized, exactly as if they'd re-entered their password. See [Confirmation](/confirmation).

Next: **[Email Verification](/email-verification)**
