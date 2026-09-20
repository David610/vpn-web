# Arcana repo scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `vpn-web` repo as a working Next.js static-export site — build tooling, the shared design system (tokens + base components), and a minimal marketing landing page for the VPN product "Arcana" — with no backend/auth/payments wiring yet (that's later plans).

**Architecture:** Next.js 15 + React 19 + Tailwind CSS v4, statically exported (`output: 'export'`) for Cloudflare Pages, following the exact tooling shape already proven in the sibling repo `ml-consulting-website` (same Next/Tailwind/Cloudflare-Pages pattern, same CSS-custom-property design-token approach). The design system is trimmed to only what a VPN SaaS marketing/auth/dashboard site needs — no service cards, FAQ accordion, contact form, or admin-analytics CSS from the source site, since those are consulting-business-specific (YAGNI). Colors/typography match the spec's reference (`david610.github.io`'s look): white background, system sans font, `#333`/`#666`-range text, `#0070f3` accent blue, `#eaeaea`-range borders, narrow content column, no stock VPN visuals.

**Tech Stack:** Next.js 15.5, React 19, TypeScript 5.9, Tailwind CSS v4 (CSS-first config via `@config`), ESLint (`next/core-web-vitals` + `next/typescript`), ready for a later `wrangler`/Cloudflare Pages deploy (not configured to actually deploy in this plan — no Cloudflare account exists yet per the spec's prerequisites).

**Spec:** `docs/superpowers/specs/2026-09-20-vpn-website-mvp-design.md` in the sibling repo `singbox-vpn` (absolute path on this machine: `D:\ISDA\singbox-vpn\docs\superpowers\specs\2026-09-20-vpn-website-mvp-design.md`) — §1 (design language: match `david610.github.io`, base tooling on `ml-consulting-website`), §3 (repo layout), §10 (explicit non-goals: no service cards/testimonials/stock VPN imagery).

## Global Constraints

- Brand name is **Arcana** everywhere (package name, page title, nav, footer, metadata).
- Static export only (`output: 'export'` in `next.config.ts`) — this repo has no server runtime; a later plan adds Cloudflare Pages Functions under `functions/` for the API surface (Stripe webhook, `/api/vpn/config`), following exactly the pattern already proven in `ml-consulting-website/functions/`.
- Design tokens (colors, spacing, type scale, radii) live as CSS custom properties in `src/app/globals.css`, and Tailwind's config reads them via `var(--...)` — one source of truth, matching the sibling repo's approach. Do not hardcode a color/size value anywhere else.
- No dark theme: `color-scheme: light` is set explicitly and every color is a hardcoded light value (same reasoning as the sibling repo: avoids native browser chrome mismatching a light-only page).
- No consulting-site-specific CSS/components carry over: no `.service-card`, `.faq`, `.contact`, `.process-grid`, `.why` (inverted band), `.about-grid`, admin-analytics styles. Only the general-purpose pieces a VPN site's landing/auth/dashboard pages will actually use: tokens, `body`/focus/reduced-motion base rules, `.dm-container`/`.dm-section`, `.btn`/`.btn-primary`/`.btn-secondary`, `.field`/`.field-label`/`.field-error`, `.dm-nav*`, `.dm-footer*`, `.hero*`, `.dm-card*`, `.tag`, `.text-link`, `.check-row`/`.check-bullet`.
- `SITE_URL` is a placeholder (`https://arcana.example`) isolated to one constant in `src/lib/site-config.ts` — no real domain has been purchased yet (tracked as a prerequisite in the spec). Nothing else in the codebase may hardcode a domain.
- Node >=22, npm (matching the sibling repo's `engines` field).

---

## Task 1: Project scaffold — package.json, Next.js/Tailwind/TypeScript/ESLint config, design tokens

**Files:**
- Create: `package.json`
- Create: `next.config.ts`
- Create: `tailwind.config.js`
- Create: `postcss.config.mjs`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `.gitignore`
- Create: `src/app/globals.css`
- Create: `src/lib/site-config.ts`

**Interfaces:**
- Consumes: nothing (first task, no prior code in this repo besides the existing `LICENSE`).
- Produces: `SITE_URL`, `SITE_NAME`, `IS_PRODUCTION` exported from `src/lib/site-config.ts` — Task 2's `layout.tsx`/page metadata imports these. The CSS custom properties defined in `globals.css` (`--bg`, `--fg`, `--fg-2`, `--fg-3`, `--border`, `--accent`, `--accent-hover`, `--radius-sm/md/lg`, `--font-sans`, `--text-*`, `--space-*`, `--container-*`, `--header-h`, `--section-pad-y`) and the base classes (`.dm-container`, `.dm-section`, `.btn`, `.btn-primary`, `.btn-secondary`, `.field`, `.field-label`, `.field-error`, `.dm-nav*`, `.dm-footer*`, `.hero*`, `.dm-card*`, `.tag`, `.text-link`, `.check-row`, `.check-bullet`, `.section-eyebrow`, `.section-head`, `.section-h2`) are the vocabulary Task 2's landing page is written against.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "arcana-web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "^15.5.11",
    "react": "19.1.0",
    "react-dom": "19.1.0"
  },
  "devDependencies": {
    "@eslint/eslintrc": "^3",
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "^15.5.11",
    "tailwindcss": "^4",
    "typescript": "5.9.2"
  },
  "overrides": {
    "postcss": "8.5.25"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

Note: no `@supabase/*`, no `vitest`/testing-library, no `wrangler` yet — those are added by the plans that actually need them (auth, Stripe/Functions deploy), keeping this scaffold's dependency footprint to only what a static marketing page needs.

- [ ] **Step 2: Run `npm install` and verify it succeeds**

Run: `npm install`

Expected: completes with no errors, creates `package-lock.json` and `node_modules/`.

- [ ] **Step 3: Write `next.config.ts`**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for Cloudflare Pages — unconditional, so a plain local
  // `next build` produces the same artifact CI and Cloudflare produce.
  // `next dev` ignores this setting, so local development is unaffected.
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Write `postcss.config.mjs`**

```js
const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
```

- [ ] **Step 6: Write `tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-alt': 'var(--bg-alt)',
        'bg-panel': 'var(--bg-panel)',
        fg: 'var(--fg)',
        'fg-2': 'var(--fg-2)',
        'fg-3': 'var(--fg-3)',
        border: 'var(--border)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        danger: 'var(--danger)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
    },
  },
  plugins: [],
}
```

- [ ] **Step 7: Write `eslint.config.mjs`**

```js
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  { ignores: [".next/**", "out/**", "node_modules/**", ".wrangler/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
```

- [ ] **Step 8: Write `.gitignore`**

A `.gitignore` with just `/.worktrees/` already exists in this repo (isolated-workspace tooling) — keep that line and add the rest:

```
# Local agent worktrees — never part of repo history
/.worktrees/

/node_modules
/.next/
/out/
/.wrangler/
.env.local
*.tsbuildinfo
next-env.d.ts
.DS_Store
```

- [ ] **Step 9: Write `src/lib/site-config.ts`**

```ts
// SITE_URL is a placeholder until a real domain is purchased (tracked as a
// prerequisite in the spec, not decided yet). This is the ONLY place a
// domain may be hardcoded — everything else (metadata, canonical links,
// OG tags in later tasks) imports it from here.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://arcana.example";
export const SITE_NAME = "Arcana";
export const IS_PRODUCTION = process.env.NODE_ENV === "production";
```

- [ ] **Step 10: Write `src/app/globals.css`**

```css
@import "tailwindcss" source(none);
@config "../../tailwind.config.js";

:root {
  /* Surfaces */
  --bg:           #FFFFFF;
  --bg-alt:       #FAFAF9;
  --bg-panel:     #F5F5F3;
  --bg-ink:       #0A0A0A;

  /* Ink */
  --fg:           #0A0A0A;
  --fg-2:         #5F5F5A;
  --fg-3:         #6E6E68;
  --fg-on-ink:    #FFFFFF;

  /* Borders */
  --border:       #E9E9E6;
  --border-strong:#0A0A0A;
  --border-soft:  #F2F2F0;

  /* Accent */
  --accent:       #0070F3;
  --accent-hover: #0056B3;
  --danger:       #B91C1C;

  /* Radii */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;

  /* Fonts — one system-UI sans, no webfont loaded. */
  --font-sans:    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu,
    Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
  --font-display: var(--font-sans);
  --font-body:    var(--font-sans);

  /* Motion */
  --t-fast:    120ms ease-out;
  --t-base:    180ms ease-out;
  --t-slow:    260ms ease-out;

  /* Type scale — rem-based so it grows with user text-size settings. */
  --text-xs:      0.75rem;
  --text-sm:      0.875rem;
  --text-base:    1rem;
  --text-lg:      1.125rem;
  --text-h3:      1.125rem;
  --text-h2-sub:  1.75rem;
  --text-h2:      2.25rem;
  --text-h1:      clamp(2rem, 1.6rem + 1.6vw, 3.5rem);

  --track-h1:   -0.03em;
  --track-h2:   -0.02em;
  --track-h2-sub: -0.015em;
  --track-h3:   -0.01em;
  --track-xs:    0.01em;

  /* Spacing — 4px grid in rem. */
  --space-1:  0.25rem;
  --space-2:  0.5rem;
  --space-3:  0.75rem;
  --space-4:  1rem;
  --space-6:  1.5rem;
  --space-8:  2rem;
  --space-12: 3rem;
  --space-16: 4rem;
  --space-24: 6rem;

  /* Layout */
  --container-max:       1040px;
  --container-max-prose: 37rem;
  --container-pad:       4rem;
  --header-h:            3.75rem;
  --section-pad-y:       5rem;
  --section-head-max:    38.5rem;
  --section-head-mb:     2.5rem;
}

@media (max-width: 1024px) {
  :root {
    --container-pad:   2rem;
    --section-pad-y:   4rem;
    --text-h2:         1.875rem;
    --text-h2-sub:     1.625rem;
  }
}
@media (max-width: 768px) {
  :root {
    --container-pad:     min(1.5rem, 24px);
    --section-pad-y:     3.5rem;
    --section-head-mb:   2rem;
    --text-h2:           1.75rem;
    --text-h2-sub:       1.5rem;
  }
}
@media (max-width: 480px) {
  :root { --container-pad: min(1.25rem, 20px); }
}

html {
  box-sizing: border-box;
  color-scheme: light;
  scroll-padding-top: calc(var(--header-h) + var(--space-4));
}
*, *::before, *::after { box-sizing: inherit; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-body);
  font-size: var(--text-base);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

*:focus-visible {
  outline: 2px solid var(--fg);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto !important; }
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}

.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0,0,0,0);
  white-space: nowrap;
  border-width: 0;
}
.sr-only:focus {
  position: absolute;
  width: auto; height: auto;
  padding: 0.5rem 1rem;
  margin: 0;
  overflow: visible;
  clip: auto;
  white-space: normal;
  background: var(--bg-ink);
  color: var(--fg-on-ink);
  z-index: 100;
  top: 1rem; left: 1rem;
}

/* Container / section */
.dm-container {
  max-width: var(--container-max);
  margin: 0 auto;
  padding-left: var(--container-pad);
  padding-right: var(--container-pad);
}
.dm-section {
  padding: var(--section-pad-y) max(var(--container-pad), (100% - var(--container-max)) / 2);
  border-bottom: 1px solid var(--border);
}
.dm-section > * {
  max-width: var(--container-max);
  margin-left: 0;
  margin-right: 0;
}
.section-head {
  max-width: min(var(--section-head-max), 100%);
  margin-left: 0;
  margin-right: auto;
  margin-bottom: var(--section-head-mb);
}
.section-h2 {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: var(--text-h2);
  line-height: 1.1;
  letter-spacing: var(--track-h2);
  color: var(--fg);
  margin: 0 0 var(--space-4);
  max-width: 22ch;
  text-wrap: balance;
}
.section-sub {
  font-family: var(--font-body);
  font-size: var(--text-base);
  line-height: 1.6;
  color: var(--fg-2);
  max-width: 56ch;
  margin: 0;
}
.section-eyebrow {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3);
  margin-bottom: var(--space-3);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 500;
  line-height: 1;
  min-height: 2.75rem;
  padding: 0.75rem 1.125rem;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background-color var(--t-base), color var(--t-base),
              border-color var(--t-base), transform var(--t-fast);
  letter-spacing: var(--track-xs);
  white-space: nowrap;
  max-width: 100%;
  text-decoration: none;
}
@media (max-width: 480px) {
  .btn { white-space: normal; }
}
.btn-primary {
  background: var(--accent);
  color: var(--fg-on-ink);
  border-color: var(--accent);
}
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-primary:active { transform: scale(0.98); }
.btn-primary:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
.btn-secondary {
  background: transparent;
  color: var(--fg);
  border-color: var(--border);
}
.btn-secondary:hover { border-color: var(--fg-3); background: var(--bg-panel); }
.btn-secondary:active { transform: scale(0.98); }

/* Tag / chip */
.tag {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  font-weight: 500;
  letter-spacing: var(--track-xs);
  color: var(--fg-2);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  padding: 0.1875rem 0.5625rem;
  border-radius: var(--radius-sm);
}

/* Form fields */
.field {
  display: block;
  width: 100%;
  max-width: 100%;
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.625rem 0.75rem;
  min-height: 2.75rem;
  transition: border-color var(--t-base), box-shadow var(--t-base);
}
.field::placeholder { color: var(--fg-3); }
.field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0, 112, 243, 0.12); }
.field[aria-invalid='true'] { border-color: var(--danger); }
.field[aria-invalid='true']:focus { box-shadow: 0 0 0 3px rgba(185, 28, 28, 0.12); }
.field-label {
  display: block;
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-2);
  margin-bottom: var(--space-2);
}
.field-error {
  display: block;
  font-family: var(--font-body);
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--danger);
  margin-top: var(--space-2);
}

.text-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--fg);
  text-decoration: none;
  border-bottom: 1px solid var(--fg);
  padding-bottom: 2px;
  transition: border-color var(--t-base);
}
.text-link:hover { border-bottom-color: var(--border); }

/* Hero */
.hero {
  padding: var(--space-16) var(--container-pad) var(--space-24);
  border-bottom: 1px solid var(--border);
}
.hero__inner {
  max-width: var(--container-max);
  margin: 0 auto;
}
.hero__title {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: var(--text-h1);
  line-height: 1.05;
  letter-spacing: var(--track-h1);
  color: var(--fg);
  margin: 0 0 var(--space-6);
  max-width: 18ch;
}
.hero__lede {
  font-family: var(--font-body);
  font-size: var(--text-base);
  line-height: 1.65;
  color: var(--fg-2);
  max-width: 52ch;
  margin: 0 0 var(--space-8);
}
.hero__actions {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-8);
}
.hero__tags { display: flex; gap: var(--space-2); flex-wrap: wrap; }
@media (max-width: 1024px) {
  .hero { padding: var(--space-12) var(--container-pad) var(--space-16); }
}
@media (max-width: 768px) {
  .hero { padding: var(--space-8) var(--container-pad) var(--space-12); }
}

/* Navigation */
.dm-nav {
  position: sticky;
  top: 0;
  z-index: 50;
  height: var(--header-h);
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--container-pad);
}
.dm-nav__brand {
  display: inline-flex;
  align-items: center;
  padding: var(--space-3) 0;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: var(--text-sm);
  letter-spacing: var(--track-h3);
  color: var(--fg);
  text-decoration: none;
}
.dm-nav__desktop {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.dm-nav__link {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--fg-2);
  text-decoration: none;
  padding: var(--space-3);
  transition: color var(--t-base);
}
.dm-nav__link:hover { color: var(--fg); }
.dm-nav__cta {
  margin-left: var(--space-3);
  min-height: 2.25rem;
  padding: 0.5rem 0.875rem;
  font-size: var(--text-xs);
}

/* Bordered rounded card */
.dm-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.dm-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4);
  border-bottom: 1px solid var(--border);
}
.dm-card-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-display);
  font-weight: 600;
  font-size: var(--text-sm);
  letter-spacing: var(--track-h3);
  color: var(--fg);
}

/* Check row / bullet */
.check-bullet {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 999px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  color: var(--accent);
}
.check-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--fg);
}

/* Footer */
.dm-footer {
  padding: var(--space-8) var(--container-pad) var(--space-6);
  border-top: 1px solid var(--border);
  background: var(--bg);
}
.dm-footer__top,
.dm-footer__bottom {
  max-width: var(--container-max);
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.dm-footer__top {
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-soft);
}
.dm-footer__bottom { margin-top: var(--space-4); }
.dm-footer__brand {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: var(--text-sm);
  letter-spacing: var(--track-h3);
  color: var(--fg);
}
.dm-footer__links { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; }
.dm-footer__link {
  font-family: var(--font-body);
  font-size: var(--text-xs);
  letter-spacing: var(--track-xs);
  color: var(--fg-2);
  text-decoration: none;
  padding: var(--space-3) var(--space-2);
  transition: color var(--t-base);
}
.dm-footer__link:hover { color: var(--fg); }

/* Accessibility preference fallbacks */
@media (prefers-reduced-transparency: reduce) {
  .dm-nav {
    background: var(--bg) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}
@media (prefers-contrast: more) {
  :root {
    --border:      #8A8A85;
    --border-soft: #A8A8A2;
    --fg-2:        #3A3A36;
    --fg-3:        #4A4A45;
  }
  .dm-nav {
    background: var(--bg) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  .btn-secondary { border-color: var(--fg); }
  .text-link { border-bottom-color: currentColor; }
}
```

Note on trimming: this omits `.service-card*`, `.faq*`, `.contact*`, `.process-*`, `.why*`, `.about-*`, `.prose-page*`, `.error-page*`, `.admin-auth*`, `.dm-nav__toggle`/`.dm-nav__panel*` (mobile menu — the landing page in Task 2 has only 2 nav links, so no hamburger menu is needed yet; a later plan adds it back if the nav grows) from the source file — those are either consulting-business-specific or not needed until later plans (auth screens, legal pages). Global Constraint above lists exactly what's kept.

- [ ] **Step 11: Verify the scaffold builds**

Run: `npm run build`

Expected: FAILS at this point — there is no `src/app/layout.tsx` or `src/app/page.tsx` yet, so Next.js has no root route. This is the expected "RED" for a scaffold task: confirms the tooling itself (Tailwind config, PostCSS, TypeScript config) is wired correctly enough to reach Next's routing error rather than failing earlier on a config problem. Note the exact error in your report.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json next.config.ts tailwind.config.js postcss.config.mjs tsconfig.json eslint.config.mjs .gitignore src/app/globals.css src/lib/site-config.ts
git commit -m "Scaffold Next.js/Tailwind project and design tokens for Arcana"
```

---

## Task 2: Root layout, nav/footer components, and the landing page

**Files:**
- Create: `src/app/layout.tsx`
- Create: `src/app/not-found.tsx`
- Create: `src/app/page.tsx`
- Create: `src/components/Nav.tsx`
- Create: `src/components/Footer.tsx`
- Create: `public/robots.txt`

**Interfaces:**
- Consumes: `SITE_URL`, `SITE_NAME`, `IS_PRODUCTION` from `src/lib/site-config.ts` (Task 1). Every CSS class from `src/app/globals.css` listed in Task 1's Interfaces section.
- Produces: the root route (`/`) renders a complete, working static page. `Nav`/`Footer` are the shared chrome later pages (signup/login/dashboard, added in later plans) will also import — no other page exists yet to consume them, but their props stay minimal (no props at all) so later reuse doesn't require a rewrite.

- [ ] **Step 1: Write `src/components/Nav.tsx`**

```tsx
import Link from "next/link";
import { SITE_NAME } from "@/lib/site-config";

export default function Nav() {
  return (
    <header className="dm-nav">
      <Link href="/" className="dm-nav__brand">
        {SITE_NAME}
      </Link>
      <nav className="dm-nav__desktop">
        <Link href="/login" className="dm-nav__link">
          Log in
        </Link>
        <Link href="/signup" className="btn btn-primary dm-nav__cta">
          Get started
        </Link>
      </nav>
    </header>
  );
}
```

Note: `/login` and `/signup` don't exist yet (added in the auth plan) — Next's static export does not fail the build over an internal `<Link>` to a not-yet-existing route (it only resolves at click time in the browser), so this is safe to land now and wire up later.

- [ ] **Step 2: Write `src/components/Footer.tsx`**

```tsx
import { SITE_NAME } from "@/lib/site-config";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="dm-footer">
      <div className="dm-footer__top">
        <span className="dm-footer__brand">{SITE_NAME}</span>
        <div className="dm-footer__links">
          <a href="/privacy/" className="dm-footer__link">
            Privacy
          </a>
          <a href="/terms/" className="dm-footer__link">
            Terms
          </a>
          <a href="/impressum/" className="dm-footer__link">
            Impressum
          </a>
        </div>
      </div>
      <div className="dm-footer__bottom">
        <span className="text-tiny">
          © {year} {SITE_NAME}
        </span>
      </div>
    </footer>
  );
}
```

Note: `/privacy/`, `/terms/`, `/impressum/` don't exist yet — these legal pages are a named prerequisite in the spec (§9 item 6, German §5 DDG/§312k BGB requirements) and are their own later task, not this scaffold. Linking to them now from the footer is intentional so they're never forgotten; the links 404 until that task lands.

- [ ] **Step 3: Write `src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import "./globals.css";
import { SITE_URL, SITE_NAME, IS_PRODUCTION } from "@/lib/site-config";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `${SITE_NAME} — A VPN without the noise`,
  description:
    "A fast, private VPN with one plan and no upsells. Sign up, pay, connect.",
  robots: IS_PRODUCTION
    ? { index: true, follow: true }
    : { index: false, follow: false },
  alternates: { canonical: `${SITE_URL}/` },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <a href="#main" className="sr-only">
          Skip to main content
        </a>
        <div id="main">{children}</div>
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Write `src/app/not-found.tsx`**

```tsx
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="dm-section">
        <div className="dm-container">
          <p className="section-eyebrow">404</p>
          <h1 className="section-h2">Page not found</h1>
          <p className="section-sub">
            The page you&apos;re looking for doesn&apos;t exist.
          </p>
          <div style={{ marginTop: "var(--space-8)" }}>
            <Link href="/" className="btn btn-primary">
              Back home
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
```

- [ ] **Step 5: Write `src/app/page.tsx`**

```tsx
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <section className="hero">
          <div className="hero__inner">
            <p className="section-eyebrow">Arcana VPN</p>
            <h1 className="hero__title">A VPN without the noise.</h1>
            <p className="hero__lede">
              One plan. No upsells, no traffic charts, no server maps.
              Sign up, connect, and get on with your day.
            </p>
            <div className="hero__actions">
              <Link href="/signup" className="btn btn-primary">
                Get started
              </Link>
              <a href="#plan" className="btn btn-secondary">
                See the plan
              </a>
            </div>
            <div className="hero__tags">
              <span className="tag">VLESS + REALITY</span>
              <span className="tag">Hysteria2</span>
              <span className="tag">EU-based</span>
            </div>
          </div>
        </section>

        <section id="plan" className="dm-section">
          <div className="section-head">
            <p className="section-eyebrow">Plan</p>
            <h2 className="section-h2">One plan. That&apos;s it.</h2>
            <p className="section-sub">
              A single monthly subscription, usable on a couple of devices
              at once. No tiers to compare.
            </p>
          </div>
          <div className="dm-card" style={{ maxWidth: "26rem" }}>
            <div className="dm-card-header">
              <span className="dm-card-title">Arcana</span>
            </div>
            <div style={{ padding: "var(--space-6)" }}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-3)",
                  marginBottom: "var(--space-6)",
                }}
              >
                <span className="check-row">
                  <span className="check-bullet">✓</span>
                  Unlimited data
                </span>
                <span className="check-row">
                  <span className="check-bullet">✓</span>
                  Works on a couple of devices at once
                </span>
                <span className="check-row">
                  <span className="check-bullet">✓</span>
                  Cancel anytime
                </span>
              </div>
              <Link href="/signup" className="btn btn-primary" style={{ width: "100%" }}>
                Get started
              </Link>
            </div>
          </div>
        </section>

        <section className="dm-section" style={{ borderBottom: "none" }}>
          <div className="section-head">
            <p className="section-eyebrow">Setup</p>
            <h2 className="section-h2">Works with the app you already use.</h2>
            <p className="section-sub">
              After signing up, you get a link and a QR code — import it into
              your VPN client of choice on iOS, Android, Windows, or macOS.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
```

- [ ] **Step 6: Write `public/robots.txt`**

```
User-agent: *
Allow: /
```

- [ ] **Step 7: Verify the build succeeds**

Run: `npm run build`

Expected: PASSES this time — `src/app/page.tsx` and `src/app/layout.tsx` now exist, so Next.js has a root route. Output includes a static export written to `out/`. This is the "GREEN" for Task 1's scaffold-only build failure in Step 11: same command, now succeeding because the missing routes now exist.

- [ ] **Step 8: Run the linter**

Run: `npm run lint`

Expected: no errors, no warnings.

- [ ] **Step 9: Manually verify the page in a browser**

Run: `npm run dev`, open `http://localhost:3000/` in a browser.

Expected: page renders with the Arcana nav, hero, plan card, and setup section, styled per the design tokens (white background, blue accent button, system sans font, thin borders) — no gradients, shields, globes, or stock VPN imagery anywhere. Resize to a narrow (mobile) width and confirm no horizontal scroll and the hero/plan-card content reflows sensibly (the CSS carried over already has the 1024/768/480px breakpoints from the source design system). Stop the dev server afterward (Ctrl+C).

- [ ] **Step 10: Commit**

```bash
git add src/app/layout.tsx src/app/not-found.tsx src/app/page.tsx src/components/Nav.tsx src/components/Footer.tsx public/robots.txt
git commit -m "Add root layout, nav/footer, and the Arcana landing page"
```

---

## Explicitly not in this plan

- Auth (Supabase signup/login), the dashboard, Stripe Checkout, the Cloudflare Pages Functions API surface, the provisioning agent — separate later plans.
- Legal pages (`/privacy`, `/terms`, `/impressum`) — linked from the footer now (so they're not forgotten) but not written; needs the German-law prerequisite work from the spec (§9 item 6) first.
- Actual Cloudflare Pages deployment / `wrangler` config — no Cloudflare account exists yet per the spec's prerequisites (§9 item 4).
- A real `SITE_URL` domain — placeholder until a domain is purchased (§9 item 4).
- Mobile hamburger nav menu — only 2 nav links exist right now; add back `.dm-nav__toggle`/`.dm-nav__panel` styling and the open/close logic when the nav actually grows past what fits on one line at 768px.
