import { defineConfig, loadEnv } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

// All source lives under src/ (see src/hull/zine.md):
//
//   src/                serving layer — router, routes, schema. ABOVE the decks.
//   src/hull/           foundation: db, services, primitives. Load-bearing.
//   src/rigging/        the stdlib: design system, default views & components.
//   src/home/           your sovereign space.
//
// The serving layer pulls views and services in from any deck and wires them
// into one running server. Imports flow src → {home, rigging, hull}, and within
// the decks: home → rigging → hull. Aliases: @/*, @hull/*, @rigging/*, @home/*.
const config = defineConfig(({ mode }) => {
  // The ship's public hostname (e.g. skylark.example.com), written to .env by
  // scripts/setup-tunnel. Vite only trusts localhost Hosts by default (DNS-
  // rebinding protection), so requests arriving through the tunnel are
  // blocked until their hostname is allowed. Per-deployment, so it lives in
  // .env rather than here.
  const publicHost = loadEnv(mode, process.cwd(), '').SKYLARK_PUBLIC_HOST
  return {
    resolve: { tsconfigPaths: true },
    plugins: [
      devtools(),
      nitro({ rollupConfig: { external: [/^@sentry\//] } }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ],
    server: {
      allowedHosts: publicHost ? [publicHost] : [],
      watch: {
        ignored: ['**/.claude/**', '**/.stryker-tmp/**', '**/reports/**'],
      },
    },
  }
})

export default config
