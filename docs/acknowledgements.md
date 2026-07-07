# Acknowledgements

**lukk** (the Laravel package) and **lukk-js** (the TypeScript / Nuxt client) stand on the shoulders of the Laravel and Nuxt ecosystems. Their design is a deliberate synthesis of ideas from the first-party packages — sincere thanks to the authors and maintainers who built them.

lukk is an independent, unofficial project. It is **not affiliated with or endorsed by** the Laravel or Nuxt teams; the names below are referenced only to describe design influence and compatibility, and are trademarks of their respective owners. These are simply the works that shaped it.

## Server — lukk

- **[Laravel Sanctum](https://laravel.com/docs/sanctum)** — the architectural model. `HasRefreshTokens` is the `HasApiTokens` analog, the static `Lukk` hub mirrors Sanctum's configuration style, and the publish-only migration convention is borrowed wholesale.
- **[Laravel Fortify](https://laravel.com/docs/fortify)** — the customization philosophy: single-purpose actions + rebindable response contracts, hooks like `Lukk::registerUsing()` (à la `Fortify::createUsersUsing()`), the `Password::defaults()` policy, and the configurable login identifier.
- **[Laravel Passport](https://laravel.com/docs/passport)** — conventions for token issuance, publish-only migrations, and keeping models extensible.
- **[Laravel Jetstream](https://jetstream.laravel.com) & [Breeze](https://laravel.com/docs/starter-kits)** — the reference for two-factor + single-use recovery codes and step-up ("sudo") confirmation.
- **[tymon/jwt-auth](https://github.com/tymondesigns/jwt-auth)** — the established Laravel JWT package; its `lock_subject` approach to cross-guard isolation directly informed lukk's [multiple-guards](/multiple-guards) design.

Built on: **[firebase/php-jwt](https://github.com/firebase/php-jwt)** (the sole runtime dependency), **[pragmarx/google2fa](https://github.com/antonioribeiro/google2fa)** (TOTP), and **[web-auth/webauthn-lib](https://github.com/web-auth/webauthn-framework)** by Spomky-Labs (passkeys).

## Client — lukk-js

- **[Inertia.js](https://inertiajs.com)** — [`useLukkForm`](/use-lukk-form) is modelled on Inertia's `useForm`: the `data` / `processing` / `errors` / `isDirty` surface, `422` error-bag binding, and `remember` semantics all follow its lead.
- **[Nuxt](https://nuxt.com)** — the module + auto-imported composable design, and the SSR/BFF story (a Nitro proxy holding tokens server-side) build directly on Nuxt's server/client model.
- **[VueUse](https://vueuse.org)** — the reference for ergonomic, composition-first composable API shapes.
- **[unjs](https://unjs.io)** — `lukk-core` and the BFF proxy are built on **[ofetch](https://github.com/unjs/ofetch)** and **[h3](https://github.com/unjs/h3)** / Nitro.

## This documentation

Built with **[VitePress](https://vitepress.dev)**; diagrams rendered by **[Mermaid](https://mermaid.js.org)** (via [`vitepress-plugin-mermaid`](https://github.com/emersonbottero/vitepress-plugin-mermaid)); AI-ingestible `llms.txt` by [`vitepress-plugin-llms`](https://github.com/okineadev/vitepress-plugin-llms).

And, above all, the **[Laravel](https://laravel.com)** and **[Nuxt](https://nuxt.com)** communities that make all of this possible. 🙏
