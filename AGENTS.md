# AGENTS.md

Guidance for AI coding assistants and review bots working on **lukk-docs**. This is the VitePress site for [lukk](https://github.com/stsepelin/lukk) (Laravel JWT auth) and [lukk-js](https://github.com/stsepelin/lukk-js) (its TS/Nuxt client), published at <https://stsepelin.github.io/lukk-docs>.

## Reviews

**Every review applies [`REVIEW.md`](./REVIEW.md).** Check each claim against the code of both repositories. Check each standard citation against the specification tables in `lukk/REVIEW.md` §4 and `lukk-js/REVIEW.md` §4. Never report a documented deliberate deviation as a defect.

## Working on the docs

- `npm install`, then `npm run docs:dev` / `npm run docs:build`. Use npm, not pnpm: `package-lock.json` is the lockfile.
- Pages live in `docs/`, one per topic. The navigation is in `docs/.vitepress/config.*`.
- Never put a `;` inside a mermaid sequence `Note` or message. It breaks rendering in the browser and the build won't catch it.
- Write for operators: what it does, the defaults, the status codes, the limits, and the standard behind it. No marketing tone.
