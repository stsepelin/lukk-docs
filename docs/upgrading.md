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
> **lukk `0.4.0` adds a `guard` column to `refresh_tokens`** (for [multiple guards](/multiple-guards)).
> It's folded into the core migration, so **fresh installs and single-guard apps need no action**.
> Only a **pre-release install that already ran the old migration** must add the column by hand —
> see [lukk UPGRADE.md](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md#upgrading-to-040-from-03x).

lukk-js has shipped **no breaking changes yet** — every release has been additive.
