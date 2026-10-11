# REVIEW.md — review rules for `lukk-docs`

**Every review of this repository applies these rules.** That includes pull-request bots (Greptile, Copilot), Claude Code and its subagents, and human reviewers. The site documents two codebases, [lukk](https://github.com/stsepelin/lukk) (PHP) and [lukk-js](https://github.com/stsepelin/lukk-js) (TypeScript). A wrong sentence here is a defect as real as a wrong line there, because operators configure security from these pages.

Sister files: `lukk/REVIEW.md` and `lukk-js/REVIEW.md` hold the full specification tables. This file references them and doesn't duplicate them. The method, severity and recurring-defect sections are shared across all three files: change one, change all three.

---

## 1. Method (mandatory)

1. **Check every claim against the code.** Each behaviour, default, status code, header, config key, event, claim, error message and limit described must match the code on the branch the docs target. Read the code, and quote `file:line` in the review. "The docs say X" is not evidence; the code is.
2. **Check every standard citation against the spec tables.** A cited clause (`RFC 9700 §4.14.2`, `NIST SP 800-63B-4 §4.1.2.1`, `WebAuthn L3 §6.1.1`, `ASVS 5.0 6.3.1` …) must:
   - name the right section for the claim, using the meaning recorded in `lukk/REVIEW.md` §4 and `lukk-js/REVIEW.md` §4;
   - use one version consistently: SP 800-63B-**4**, WebAuthn **Level 3**, ASVS **5.0** with the 4.0.3 number in parentheses where both are given;
   - not claim conformance lukk doesn't have. RFC 9068 is followed in shape only (no `client_id`), and the rotation grace window is a documented **deviation** from RFC 9700 §4.14.2, not compliance with it.
3. **Check consistency across pages.** The same fact appears on several pages (configuration, the feature page, security, upgrading, events). Grep for it and reconcile every occurrence. A contradiction between two pages is a finding even when one of them is right.
4. **Look for the opposite error.** When a change narrows or widens a guarantee, the pages that state the old guarantee are now wrong. Find them.
5. **Report format.** For each finding: severity, `docs/<page>.md:line`, what the page says, what the code does (`file:line`), and the corrected wording.

## 2. Severity

| Severity | Meaning |
|---|---|
| **Blocker** | The docs would make an operator **less secure** than they believe. Examples: a guarantee the code doesn't give, a default stated wrongly for a security setting, an upgrade step missing that's needed to stay safe, or a sample that leaks a token or turns off a protection. |
| **Major** | A wrong status code, config key, default or behaviour; a missing `UPGRADE`/upgrading entry for a breaking change; a broken anchor that a security page links to. |
| **Minor** | Wording, typos, style, a missing cross-link. |

## 3. What a review must always run

```bash
npm run docs:build     # must be clean; uses npm (package-lock.json)
```

The build does **not** catch these, so check them by hand:
- **Mermaid:** a `;` inside a sequence `Note` or message breaks rendering in mermaid 11 (it is a statement separator), and only fails in the browser.
- **Anchors:** every `](/page#anchor)` must exist in the built HTML (`docs/.vitepress/dist`). VitePress slugs drop `(`, `)`, `.` and `/` and lowercase the rest. An anchor that contains a version (`#upgrading-to-070-from-06x`) changes when "(unreleased)" is dropped at release.
- **Code samples:** PHP and TS samples must compile against the current API: the right names, argument order and config keys. Samples never put a token in `localStorage`/`sessionStorage`, never turn off a CSRF or origin check, and never use a weak `LUKK_SECRET`.

## 4. What each kind of page must carry

| Page kind | Must carry |
|---|---|
| A feature page (`two-factor-authentication`, `passkeys`, `account-lockout` …) | The routes, statuses and bodies for every outcome (including `403`/`409`/`422`/`423`/`429`), the config keys with defaults, the events, the standard clauses behind the behaviour, and its limits. |
| `configuration.md` | Every `config/lukk.php` key and every lukk-nuxt module option, with the real default, the type, what reads it (global or per guard), and what a missing key falls back to. |
| `security.md` | The standards mapping table, **Known limitations**, and the security checklist. Each limitation states its bound and why the alternative is worse. |
| `upgrading.md` | An entry for every behaviour change a consumer can see, with impact and the action needed, in both packages. It must agree with `lukk/UPGRADE.md`, `lukk/CHANGELOG.md`, `lukk-js/UPGRADE.md` and the lukk-js changesets. |
| `events.md` | Every event, when it fires and how often, its payload (with the personal data flagged), and whether it is safe to queue. |
| `architecture.md` | The layer and directory map, matching `src/`. |

## 5. Deliberate deviations: document them, never "fix" them

These are decisions, recorded in `lukk/REVIEW.md` §6 and `lukk-js/REVIEW.md` §6. The docs must describe each one as a deviation, with the reasoning. A review must not ask for the docs to promise the opposite:

- the 30 s rotation grace window;
- the BFF rotation journal answering some replays;
- throttle buckets keyed on the identifier fold only;
- the `sub` precheck refusing only what's certain without I/O;
- HS256 as the default;
- bcrypt passwords over 72 bytes needing a reset;
- the per-process BFF state;
- the `.php` front-controller trade-offs;
- the held dependency majors.

## 6. Recurring defect classes (2026-08 → 2026-10 audits)

1. **Docs describing an earlier version of a fix.** A guarantee was narrowed in code while three pages still stated the broad version.
2. **The same fact contradicted on two pages**, for example "throttle keys on the account" on one page and "on the fold only" on another.
3. **Mixed spec versions** (ASVS 4.0.3 and 5.0 numbering, SP 800-63B rev 3 and rev 4 sections).
4. **Over-claiming conformance**, for example "RFC 9700 compliant" where the grace window deviates.
5. **Status codes and response bodies that drifted**: a "throttled" 422 the code never returns, or a 403 documented as 422.
6. **Mermaid `;`** and **version-dependent anchors** breaking only in the browser or after release.
7. **Undocumented input rules**: identifier character rules, UTF-8, length limits, and the `422` messages they produce.
