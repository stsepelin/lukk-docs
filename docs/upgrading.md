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
