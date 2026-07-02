# How It Works

lukk splits authentication into two token types with two very different jobs, and the two halves — the Laravel server and the TypeScript client — cooperate so your application code barely has to think about either. This page walks the full request lifecycle end to end: logging in, attaching a token, verifying it, surviving a 401, refreshing with rotation, and what happens when a stolen token is replayed. The internals of each step live in [Tokens & Rotation](/tokens-and-rotation), [Transport Modes](/transport-modes), and [Architecture](/architecture) — here we stay at the level of the flow.

## The two tokens

Everything below turns on the split between them:

- **The access token** is a short-lived, signed JWT (HS256, 15 minutes). It's stateless — the server verifies it by checking a signature and a few claims, no database lookup — and it's attached to every request as a bearer.
- **The refresh token** is a long-lived, opaque random string (30 days). It's never a JWT and carries no meaning on its own; the server stores only its `sha256` hash. Its only job is to mint a fresh access token when the old one expires, and it's **rotated** — replaced with a new one — every single time it's used.

Short-lived-and-stateless plus long-lived-and-revocable is the whole design. See [Tokens & Rotation](/tokens-and-rotation) for the claim set and the rotation algorithm.

## 1. Logging in

The client posts credentials to lukk's `/auth/login`. lukk verifies them in constant time (an unknown user runs an equivalent hash check, so a wrong email is indistinguishable from a wrong password), starts a refresh-token **family**, and returns a **token pair**: an access token and a refresh token, plus an `expires_in`.

Where those tokens land depends on the client's [transport mode](/transport-modes):

- In **`bff`** mode a same-origin Nitro proxy captures the pair and seals it into an encrypted, server-side cookie. The browser receives only an opaque session cookie and never sees a token.
- In **`direct`** mode the access token is held in the client's memory and the refresh token rides lukk's hardened `__Host-` cookie set by the server.

Either way your component code is identical — the client exposes one `useLukkAuth()` surface over both.

## 2. Attaching the access token

On every subsequent request the client attaches the access token as `Authorization: Bearer <jwt>`. In `direct` mode the client reads it from memory; in `bff` mode the proxy injects it server-side so the browser never handles it. The [`useLukkFetch`](/use-lukk-fetch) composable does this for your own app API too, correctly in the browser, during SSR, and in server routes.

## 3. Verifying a request

lukk's guard (`auth:api`, backed by the `lukk-jwt` driver) verifies the access token statelessly:

- the **algorithm is pinned** from config and never read from the token header (the alg-confusion defense);
- `iss`, `aud`, and `exp`/`nbf` are validated, and the `typ=at+jwt` header is asserted;
- the **denylist** is checked by both `jti` (this token) and `fid` (this whole session).

If it all passes, `$request->user()` is populated and the request proceeds — no database round-trip for the token itself.

## 4. Hitting a 401

Access tokens are deliberately short-lived, so a `401` is a routine event, not an error. When lukk rejects a request (expired token, or a revoked one), the client catches the `401` and — instead of bubbling it up to your UI — kicks off a refresh.

Concurrent 401s are common (SSR fires a burst of requests, or a user has ten tabs). The client collapses them into a **single in-flight refresh** (`singleFlight`): a page that fires ten requests at once triggers one refresh, not ten. In `bff` mode the proxy single-flights its server-side refresh per session for the same reason.

## 5. Refreshing and rotating

The client sends the refresh token to `/auth/refresh`. lukk, inside a transaction, looks up the row by hash, confirms it's live, **marks it consumed, and mints a successor** in the same family — the token is rotated, not reused. It returns a fresh access token and a fresh refresh token. The client retries the original request with the new access token, and your UI never sees the interruption.

## 6. Reuse detection

Rotation is what makes theft detectable. Because a refresh token is consumed on use, presenting an **already-consumed** token after a short [grace window](/tokens-and-rotation#the-grace-window) is the signature of a stolen token being replayed. lukk responds by revoking the **entire family** — every live access and refresh token for that session — and denylisting it by `fid`, so every access token dies within one 15-minute TTL. It also dispatches a [`RefreshTokenReused`](/events) event so you can alert on it.

The grace window is the counterweight: legitimate concurrent refreshes (multiple tabs, SSR + hydration) present the same token nearly simultaneously and must **not** be mistaken for theft, so within the window the straggler is served a fresh token under the same family instead of triggering a revoke. This is why the client single-flights and why lukk keeps `grace_seconds > 0`.

## 7. Revocation

Because the denylist is checked on every request, revocation is instant. A logout revokes the current session; `DELETE /auth/sessions` revokes them all. Either way the denylist entry (keyed by `fid`/`jti`) self-evicts when the token it kills would have expired anyway, so revocation costs are proportional to revoked sessions, not to all tokens ever issued.

---

That's the whole loop: log in once, ride short access tokens that refresh silently, and a single replayed token takes the whole session down. For the token internals read [Tokens & Rotation](/tokens-and-rotation); for where the tokens physically live, [Transport Modes](/transport-modes); for the code that implements all of it, [Architecture](/architecture).

Next: **[Installation](/installation)**
