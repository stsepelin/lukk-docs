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

The client attaches the bearer token, and on a `401` it calls `refresh` once and retries the original request — concurrent 401s share a **single** in-flight refresh.

## The Hooks

| Hook | Type | Purpose |
|---|---|---|
| `baseURL` | `string` | lukk's auth URL incl. the route prefix. |
| `fetch?` | `typeof fetch` | Custom fetch (defaults to the global). |
| `getAccessToken?` | `() => string \| null \| Promise<…>` | The bearer token to attach. |
| `getConfirmationToken?` | `() => string \| null \| Promise<…>` | The step-up token for `X-Lukk-Confirmation`. |
| `refresh?` | `() => Promise<TokenPair \| null>` | Obtain a fresh pair on a 401; `null` if not refreshable. |
| `onTokens?` | `(pair) => void` | Persist a freshly-minted pair (login / refresh / passkey login / restore). |
| `onUnauthenticated?` | `() => void` | Refresh failed — the session is gone. |
| `confirmationHeader?` | `string` | Header name (default `X-Lukk-Confirmation`). |

Where the tokens actually live — memory, a sealed cookie, a server session — is entirely the caller's choice. The core only knows how to *speak* to lukk.

## Methods

```ts
// session
lukk.login(credentials)                 // → TokenPair | TwoFactorChallenge
lukk.twoFactorChallenge({ challenge_token, code | recovery_code })
lukk.refreshTokens(refreshToken?)       // direct mode passes the token; cookie mode omits it
lukk.restore()                          // silent refresh; null when there's no session
lukk.logout()
lukk.revokeAllSessions()
lukk.revokeOtherSessions()

// step-up confirmation
lukk.confirmPassword(password)          // → { confirmation_token }
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
lukk.loginWithPasskey(ceremonyId, credential)
lukk.listPasskeys()                     // → { passkeys: PasskeySummary[] }
lukk.deletePasskey(credentialId)
```

Every shape is exported as a type (`TokenPair`, `TwoFactorChallenge`, `PasskeyLoginOptions`, …) and [conformance-tested](/architecture#conformance) against real lukk.

## Errors

A failed request throws a typed `LukkError`:

```ts
interface LukkError {
  status: number
  message: string
  errors?: Record<string, string[]> // Laravel validation errors (422)
}
```

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
