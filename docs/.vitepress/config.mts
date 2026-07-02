import { withMermaid } from 'vitepress-plugin-mermaid'
import llmstxt from 'vitepress-plugin-llms'

// One documentation site for both halves of lukk: the Laravel package (server) and the
// TypeScript/Nuxt client (lukk-js). Organized by TOPIC, not by repo — each feature page
// carries a server section and a client section, the way Inertia documents its adapters.
export default withMermaid({
  title: 'lukk',
  description: 'First-party JWT auth for Laravel — the server package and its TypeScript/Nuxt client, in one place.',
  // Self-hosted at stsepelin.github.io/lukk-docs (this repo's own Pages).
  base: '/lukk-docs/',
  lastUpdated: true,
  // Migrated docs use real headings (not manual anchors), so validate links at build.
  ignoreDeadLinks: false,
  head: [
    ['meta', { name: 'theme-color', content: '#3c8772' }],
  ],
  // Emit llms.txt + llms-full.txt (+ per-page .md) so AI tools can ingest the docs.
  vite: { plugins: [llmstxt()] },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/introduction' },
      { text: 'Features', link: '/authentication' },
      { text: 'Client Toolkit', link: '/use-lukk-fetch' },
      { text: 'Reference', link: '/architecture' },
      {
        text: 'Packages',
        items: [
          { text: 'lukk (Packagist)', link: 'https://packagist.org/packages/lukk/lukk' },
          { text: 'lukk-core (npm)', link: 'https://www.npmjs.com/package/lukk-core' },
          { text: 'lukk-nuxt (npm)', link: 'https://www.npmjs.com/package/lukk-nuxt' },
        ],
      },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/introduction' },
          { text: 'How It Works', link: '/how-it-works' },
          { text: 'Installation', link: '/installation' },
        ],
      },
      {
        text: 'Core Concepts',
        items: [
          { text: 'Tokens & Rotation', link: '/tokens-and-rotation' },
          { text: 'Transport Modes', link: '/transport-modes' },
          { text: 'Configuration', link: '/configuration' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Authentication', link: '/authentication' },
          { text: 'The User', link: '/user' },
          { text: 'Two-Factor (TOTP)', link: '/two-factor-authentication' },
          { text: 'Passkeys (WebAuthn)', link: '/passkeys' },
          { text: 'Email Verification', link: '/email-verification' },
          { text: 'Step-Up Confirmation', link: '/confirmation' },
        ],
      },
      {
        text: 'Client Toolkit',
        items: [
          { text: 'useLukkFetch', link: '/use-lukk-fetch' },
          { text: 'useLukkForm', link: '/use-lukk-form' },
          { text: 'Using lukk-core', link: '/lukk-core' },
        ],
      },
      {
        text: 'Production',
        items: [
          { text: 'Deployment', link: '/deployment' },
          { text: 'Local Development', link: '/local-development' },
          { text: 'Security Model', link: '/security' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Events', link: '/events' },
          { text: 'Customization', link: '/customization' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/stsepelin/lukk' },
    ],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/stsepelin/lukk-docs/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
