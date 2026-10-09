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
  refresh: () => lukk.refreshTokens().catch(() => null), // direct mode: relies on the __Host- cookie
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
| `onTokens?` | `(pair) => void` | Persist a freshly-minted pair (login / refresh / passkey login / restore). |
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
lukk.login(credentials)                 // → TokenPair | TwoFactorChallenge
lukk.twoFactorChallenge({ challenge_token, code | recovery_code })
lukk.refreshTokens(refreshToken?)       // direct mode passes the token; cookie mode omits it
lukk.restore()                          // silent refresh; null when there's no session
lukk.logout({ retry?, refreshToken? }) // retry: false skips refresh-and-retry on a 401 (renew it yourself)
lukk.revokeAllSessions()
lukk.revokeOtherSessions()

// account (each resolves to LukkStatus — { status: string })
lukk.forgotPassword(email)              // → { status: 'password-reset-link-sent' }
lukk.resetPassword({ token, email, password, password_confirmation })
lukk.changePassword({ current_password, password, password_confirmation })
lukk.sendEmailVerification()            // → { status: 'verification-link-sent' } (a 202)

// step-up confirmation
lukk.confirmPassword(password)          // → { confirmation_token }
lukk.passkeyConfirmationOptions()       // → { ceremony_id, options } — lukk ≥ 0.7.0, 404 on older
lukk.confirmPasskey(ceremonyId, credential)

// two-factor management
lukk.enableTwoFactor()                  // → { otpauth_uri, recovery_codes }
lukk.confirmTwoFactor(code)
lukk.disableTwoFactor()
lukk.recoveryCodeCount()                // → { remaining, total }
lukk.regenerateRecoveryCodes()

// passkeys
lukk.passkeyRegistrationOptions()
lukk.registerPasskey(credential, name?)
lukk.passkeyLoginOptions()              // → { ceremony_id, options }
lukk.loginWithPasskey(ceremonyId, credential) // → TokenPair, or a TwoFactorChallenge (lukk ≥ 0.7)
lukk.listPasskeys()                     // → { passkeys: PasskeySummary[] }
lukk.deletePasskey(credentialId)
```

Every shape is exported as a type (`TokenPair`, `TwoFactorChallenge`, `PasskeyLoginOptions`, …) and [conformance-tested](/architecture#conformance) against real lukk.

**`logout({ refreshToken })`** (lukk-core 0.12.0) presents the session's refresh token in the body. lukk ends a session by the refresh token the client holds — the RFC 7009 shape — so a [body-mode](/configuration#output-mode) binding whose access token has expired can log out without spending a rotation on a fresh bearer first, or while refreshing is throttled or failing. Cookie mode sends lukk's cookie instead, so leave it out there. Older lukk releases ignore it and use the bearer.

**`LukkStatus`** (lukk-core 0.12.0) is the acknowledgement lukk answers the fire-and-forget account calls with: `password-reset-link-sent`, `password-reset`, `password-changed` and `verification-link-sent`. They used to resolve to `void`. `status` is typed `string`, so a lukk release adding a value is not a type error.

`AccountExport` (the [export](/account-deletion) body) has an optional `lockouts` array — `purpose`, `attempts`, and ISO-8601 `locked_at` / `first_failed_at` / `last_failed_at` (each nullable) — for lukk releases that include the lockout counters. `PasskeySummary.last_used_at` is a number (unix seconds), not a string.

`Amr` types the access token's [`amr` claim](/tokens-and-rotation#the-amr-claim): `'pwd' | 'otp' | 'pop' | 'user' | 'mfa'`, the RFC 8176 values lukk 0.7.0 emits. `'webauthn'` is gone (a breaking type change in lukk-core 0.12.0): a passkey session is `pop` + `user`, and `mfa` marks a multi-factor one.

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
