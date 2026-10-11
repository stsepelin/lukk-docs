# Using lukk-core

`lukk-core` is the framework-agnostic client that `lukk-nuxt` is built on. Use it directly when you're not on Nuxt — a React app, a Svelte app, a CLI, a different SSR framework — or when you're writing a new binding.

## Install

```bash
npm i lukk-core
```

It has **no runtime dependencies** and ships ESM + types.

## Creating a Client

`createLukkClient` takes a set of hooks — the seam where *you* decide where tokens live and how a refresh happens — and returns a typed client with a method per lukk endpoint:

```ts
import { createLukkClient, isTwoFactorChallenge } from 'lukk-core'

let accessToken: string | null = null

const lukk = createLukkClient({
  baseURL: 'https://api.example.com/auth',
  getAccessToken: () => accessToken,
  onTokens: pair => { accessToken = pair.access_token },
  // Return null when not refreshable. (The client also treats a throwing
  // refresh as "not refreshable", but returning null is the documented contract.)
  // Cookie mode (what lukk-nuxt's direct mode uses): no argument, lukk reads its __Host- cookie.
  // Body mode: pass the refresh token you hold — lukk.refreshTokens(refreshToken).
  refresh: () => lukk.refreshTokens().catch(() => null),
})

const result = await lukk.login({ email, password })
if (isTwoFactorChallenge(result)) {
  await lukk.twoFactorChallenge({ challenge_token: result.challenge_token, code })
}
```

The client attaches the bearer token, and on a `401` it calls `refresh` once and retries the original request — concurrent 401s share a **single** in-flight refresh. The sign-in calls (`login`, `register`, `twoFactorChallenge`, `loginWithPasskey`) are the exception: they don't authenticate with the current session, so their `401` is the answer and they reject with it.

## The Hooks

| Hook | Type | Purpose |
|---|---|---|
| `baseURL` | `string` | lukk's auth URL incl. the route prefix. |
| `fetch?` | `typeof fetch` | Custom fetch (defaults to the global). |
| `getAccessToken?` | `() => string \| null \| Promise<…>` | The bearer token to attach. |
| `getConfirmationToken?` | `() => string \| null \| Promise<…>` | The step-up token for `X-Lukk-Confirmation`. |
| `refresh?` | `() => Promise<RefreshOutcome>` | Renew on a 401: a `TokenPair`, [`REFRESHED_WITHOUT_TOKEN`](#renewed-without-a-token), or `null` if not refreshable. |
| `onTokens?` | `(pair) => void` | Persist a freshly-minted pair (register / login / 2FA challenge / passkey login / restore, and the pair a `refresh` hook returns). |
| `onUnauthenticated?` | `() => void` | Refresh failed — the session is gone. |
| `confirmationHeader?` | `string` | Header name (default `X-Lukk-Confirmation`). |

Where the tokens actually live — memory, a sealed cookie, a server session — is entirely the caller's choice. The core only knows how to *speak* to lukk.

### Renewed without a token

A `refresh` hook's answer is shape-checked: only a real token pair is retried with and handed to `onTokens`, so an arbitrary response body can never be stored as a token. A binding whose session is renewed somewhere the client holds no token — a BFF proxy re-sealing a server-side session — has no pair to return. It returns the exported symbol `REFRESHED_WITHOUT_TOKEN` instead: the request is retried once and `onTokens` isn't called. A symbol can't come out of a response body, so the shape gate on real pairs is unchanged.

```ts
import { createLukkClient, REFRESHED_WITHOUT_TOKEN, type RefreshOutcome } from 'lukk-core'

const lukk = createLukkClient({
  baseURL: '/api/_lukk',
  refresh: async (): Promise<RefreshOutcome> => {
    const res = await fetch('/api/_lukk/refresh', { method: 'POST' })
    return res.ok ? REFRESHED_WITHOUT_TOKEN : null
  },
})
```

`RefreshOutcome` is `TokenPair | typeof REFRESHED_WITHOUT_TOKEN | null`. lukk-nuxt's BFF mode uses it, which is how a `401` is now retried there once the proxy has renewed the session (lukk-core 0.12.0); its `$lukkRefresh` resolves to the symbol in BFF mode (still truthy on success) and is typed `() => Promise<RefreshOutcome>`, and `$lukkRestore` resolves to `{ pair, unavailable, superseded? }`, whose `pair` is that outcome.

## Methods

```ts
// session
lukk.register(input)                    // → TokenPair | TwoFactorChallenge | RegistrationPending
lukk.login(credentials)                 // → TokenPair | TwoFactorChallenge
lukk.twoFactorChallenge({ challenge_token, code | recovery_code })
lukk.refreshTokens(refreshToken?)       // body mode passes the token; cookie mode omits it
lukk.restore()                          // silent refresh; resolves null on ANY failure
lukk.logout({ retry?, refreshToken? }) // retry: false skips refresh-and-retry on a 401 (renew it yourself)
lukk.claimSession()                     // POST /session/claim — lukk ≥ 0.7, 404 on older
lukk.revokeAllSessions()
lukk.revokeOtherSessions()

// account (each resolves to LukkStatus — { status: string })
lukk.forgotPassword(email)              // → { status: 'password-reset-link-sent' }
lukk.resetPassword({ token, email, password, password_confirmation })
lukk.changePassword({ current_password, password, password_confirmation })
lukk.sendEmailVerification()            // → { status: 'verification-link-sent' } (a 202)

// the account itself (behind step-up)
lukk.exportAccount()                    // → AccountExport
lukk.deleteAccount()                    // irreversible; ends this session too

// step-up confirmation
lukk.confirmPassword(password)          // → { confirmation_token }
lukk.passkeyConfirmationOptions()       // → { ceremony_id, options } — lukk ≥ 0.7.0, 404 on older
lukk.confirmPasskey(ceremonyId, credential)

// two-factor management
lukk.enableTwoFactor()                  // → { otpauth_uri, recovery_codes }
lukk.confirmTwoFactor(code)
lukk.disableTwoFactor()
lukk.recoveryCodeCount()                // → { remaining, total }
lukk.regenerateRecoveryCodes()          // → { recovery_codes }

// passkeys
lukk.passkeyRegistrationOptions()
lukk.registerPasskey(credential, name?)
lukk.passkeyLoginOptions()              // → { ceremony_id, options }
lukk.loginWithPasskey(ceremonyId, credential) // → TokenPair, or a TwoFactorChallenge (lukk ≥ 0.7)
lukk.listPasskeys()                     // → { passkeys: PasskeySummary[] }
lukk.deletePasskey(credentialId)

// anything else under baseURL
lukk.request<T>(path, init?, allowRetry?)
```

Every shape is exported as a type (`TokenPair`, `TwoFactorChallenge`, `PasskeyLoginOptions`, …) and [conformance-tested](/architecture#conformance) against real lukk.

**`register(input)`** takes the identifier (`email` or `username`), `password` and `password_confirmation`, plus any extra fields your [registration hooks](/registration) read (the stock create expects a `name`). It resolves like a login — a pair, which is handed to `onTokens`, or a two-factor challenge — or to a `RegistrationPending` (`{ registered: true, requires_verification }`) when the account was created without a session. Narrow it with `isRegistrationPending()` / `isTwoFactorChallenge()`.

**`refreshTokens(refreshToken?)`** depends on lukk's [output mode](/configuration#output-mode). In **body mode** the client holds the refresh token and passes it. In **cookie mode** — which lukk-nuxt's direct mode pairs with — leave it out: lukk reads its `__Host-` cookie. It does not call `onTokens`; your `refresh` hook returns the pair and the client hands it on.

**`restore()`** is the silent refresh for app load: it posts `{}` as JSON (cookie mode — lukk 0.7.0 refuses a cookie refresh without a JSON body or a same-origin `Sec-Fetch-Site`, with `415`) and, on success, hands the pair to `onTokens`. It resolves `null` on **any** failure — a `401`, a `429`, a `5xx`, a network error alike — so treat `null` as "no session I could restore", not as "signed out for sure".

**`claimSession()`** confirms that this client received the session a sign-in just issued, for lukk's [unclaimed sessions](/configuration#refresh-behavior) (`claim_seconds`): a session first used after that window is revoked. Any authenticated request to lukk claims too; this one lets a client do it straight away. Older lukk releases answer `404`.

**`exportAccount()` / `deleteAccount()`** sit behind [step-up confirmation](/confirmation) (send the token through `getConfirmationToken`); see [Account Deletion & Export](/account-deletion). `deleteAccount()` revokes every token before it deletes the row, so treat its resolution as "signed out, and the account is gone".

**`request<T>(path, init?, allowRetry = true)`** is the transport every method above uses, for a lukk route the client has no method for. `path` joins onto `baseURL` (an absolute `http(s)` URL passes through); it sets `Accept: application/json` (and a JSON `Content-Type` when there is a body), never follows a redirect, and attaches the bearer, the step-up header and cookies only to a target on `baseURL`'s origin. A non-2xx rejects with a `LukkError`.

**`logout({ refreshToken })`** (lukk-core 0.12.0) presents the session's refresh token in the body. lukk ends a session by the refresh token the client holds — the RFC 7009 shape — so a [body-mode](/configuration#output-mode) binding whose access token has expired can log out without spending a rotation on a fresh bearer first, or while refreshing is throttled or failing. Cookie mode sends lukk's cookie instead, so leave it out there. Older lukk releases ignore it and use the bearer.

**`LukkStatus`** (lukk-core 0.12.0) is the acknowledgement lukk answers the fire-and-forget account calls with: `password-reset-link-sent`, `password-reset`, `password-changed` and `verification-link-sent`. They used to resolve to `void`. `status` is typed `string`, so a lukk release adding a value is not a type error.

**`AccountExport`** (the [export](/account-deletion#the-export) body) follows lukk 0.7.0. Each `passkeys[]` entry is `credential_id`, `name`, `last_used_at` and the optional `created_at`, `aaguid` (the authenticator model) and `transports` (`string[]`); **its times are ISO-8601 strings**, like every other time in the export, and any may be `null`. lukk 0.6.0 sent `last_used_at` as unix seconds and none of the three optional fields — parse the string rather than multiplying by 1000. The optional `lockouts` array — `purpose`, `attempts`, and ISO-8601 `locked_at` / `first_failed_at` / `last_failed_at` (each nullable) — comes from lukk releases that include the lockout counters. **`PasskeySummary`** from `listPasskeys()` is different: its `last_used_at` is still a number (unix seconds).

`Amr` types the access token's [`amr` claim](/tokens-and-rotation#the-amr-claim): `'pwd' | 'otp' | 'pop' | 'user' | 'mfa'`, the RFC 8176 values lukk 0.7.0 emits. `'webauthn'` is gone (a breaking type change in lukk-core 0.12.0): a passkey session is `pop` + `user`, and `mfa` marks a multi-factor one.

> [!NOTE]
> **`BffSignInResult` is lukk-nuxt's, not lukk-core's.** In BFF mode lukk-nuxt's `login()`, `register()` and passkey `login()` resolve to the proxy's acknowledgement, `{ ok: true, expires_in? }` — the token pair stays in the sealed session. Their types are `LoginResult | BffSignInResult` (`RegisterResult | BffSignInResult`), so narrow with `'access_token' in result` or `isTwoFactorChallenge()` before reading a token. lukk-core's own methods always resolve to what lukk sent. In BFF mode `useNuxtApp().$lukk` is typed `LukkBffClient` (lukk-nuxt's), not `LukkClient`: its `login`, `loginWithPasskey`, `register`, `twoFactorChallenge` and `refreshTokens` resolve the proxy's acknowledgement, and `confirmPassword` / `confirmPasskey` resolve `{ ok: true }` without the token, which the proxy holds.

## Other Exports

Besides the client and the types above, `lukk-core` exports the helpers its bindings are built from:

| Export | What it does |
|---|---|
| `isTwoFactorChallenge(r)`, `isRegistrationPending(r)` | Narrow a sign-in or registration result. Both take `unknown`, so they also narrow lukk-nuxt's composable results (`isTwoFactorChallenge(await login(...))`, where the type includes `BffSignInResult`). |
| `SESSION_CHANGED` | The `reason` of a `401` that was not retried because the renewal belonged to another account — see [Errors](#errors). |
| `isTokenPair(value)` | The shape gate every token sink uses: an object with a string `access_token`. |
| `singleFlight(fn)` | Collapse concurrent calls into one in-flight promise (how the client shares a refresh). |
| `isSameOrigin(base, path)`, `carriesOrigin(path)` | The credential guard: whether a target stays on `base`'s origin, and whether a string carries an origin of its own (a scheme or `//host`), after canonicalising it the way the URL parser does. |
| `lukkError(status, statusText, body)` | Build a `LukkError` from a Laravel error body. |
| `retryAfterSeconds(value)` | A `Retry-After` header's delay-seconds, or `undefined` for anything else (the HTTP-date form included). |
| `shapeUser(raw, key?)`, `isEmailVerified(user)`, `userShapeWarning(user)` | Unwrap a user-endpoint body (a clean `{ data }` or a configured key), read either verification field, and the dev-time "this looks wrapped" diagnostic. |
| `can`, `cannot`, `canAny`, `canAll`, `normalize`, `enforcesAbilities` | The [abilities](/abilities) matcher — UI hints, never enforcement. |
| `LUKK_SESSIONS`, `LUKK_ACCOUNT`, `LUKK_ACCOUNT_DELETE` | lukk's own ability names. |
| `base64urlToBuffer`, `bufferToBase64url` | The [WebAuthn](#webauthn-helpers) encoding primitives. |

Types: `LukkClient` (what `createLukkClient` returns), `LukkClientHooks`, `RefreshOutcome`, `LukkMode` (`'bff' | 'direct'`), `LukkIdentifier` (`{ email } | { username }`), `LoginInput`, `RegisterInput`, `RegisterResult`, `RegistrationPending`, `TwoFactorInput`, `ResetPasswordInput`, `ChangePasswordInput`, `TwoFactorEnrollment`, `RecoveryCodeCount`, `ConfirmationToken`, `PasskeySummary`, `PasskeyLoginOptions`, `AccountExport`, `LukkStatus`, `LukkUser`, `Amr`.

## Errors

A failed request throws a typed `LukkError`:

```ts
interface LukkError {
  status: number
  message: string
  errors?: Record<string, string[]> // Laravel validation errors (422)
  reason?: string                    // lukk's machine-readable cause, where it names one
  retryAfter?: number                // the response's Retry-After, in seconds
}
```

`reason` (lukk-core 0.12.0) is passed through when lukk's body carries a string one. Branch on it, never on `message`: a `423` with `reason: "confirmation_session_mismatch"` means the held step-up belongs to another session — discard it and confirm again — while a `423` without one means *earn a confirmation*.

One `reason` comes from the client itself. On a `401` the client renews once and retries — but only for a target on `baseURL`'s origin, where its credentials went; a `401` from another origin rejects as it came, without a renewal. When the renewal hands back a token for a **different account** than the one the request was sent as (another tab signed in, and the refresh cookie is shared), the request is not sent again: it rejects with `status: 401` and `reason: SESSION_CHANGED` (`'session_changed'`, exported). The new session is kept; whether to repeat the action as that account is the caller's decision. (lukk-nuxt's `useLukkAuth` does not read it as a sign-out when it comes back from loading the user: it loads once more as the account the session now holds, and if that fails too, treats it as a load that couldn't tell rather than signing the tab out.) The accounts are compared by the JWT's `sub`, decoded but not verified, and only when both tokens name one.

`retryAfter` (lukk-core 0.12.0) is the response's `Retry-After` header when it gives delay-seconds (RFC 9110 §10.2.3); the HTTP-date form is left out rather than guessed at, so the field is absent then. It is how a binding comes back when the server asked: a `429` from a throttle, or the lukk-nuxt BFF's `503` for a refresh lukk is slow to rotate, which [lukk-nuxt's client retries once](/transport-modes#a-slow-rotation) after at most ten seconds. lukk-core itself does not retry on it.

```ts
try {
  await lukk.login({ email, password })
}
catch (e) {
  const err = e as LukkError
  if (err.status === 422) showFieldErrors(err.errors)
}
```

## WebAuthn Helpers

For passkey ceremonies, the core exports the `ArrayBuffer ⇄ base64url` plumbing lukk speaks:

```ts
import {
  toCreationOptions,  // lukk JSON → navigator.credentials.create() input
  toRequestOptions,   // lukk JSON → navigator.credentials.get() input
  credentialToJSON,   // a PublicKeyCredential → JSON to post back to lukk
} from 'lukk-core'

const options = toCreationOptions(await lukk.passkeyRegistrationOptions())
const credential = await navigator.credentials.create({ publicKey: options })
await lukk.registerPasskey(credentialToJSON(credential as PublicKeyCredential))
```

`lukk-nuxt`'s `useLukkPasskeys` wraps exactly this — you only need these helpers when writing your own binding.

Next: **[Deployment](/deployment)**.
