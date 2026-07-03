import { defineConfig } from 'vite'
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
const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    nitro({ rollupConfig: { external: [/^@sentry\//] } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  watch: {
    ignored: ['**/.claude/**', '**/.stryker-tmp/**', '**/reports/**'],
  },
})

export default config
