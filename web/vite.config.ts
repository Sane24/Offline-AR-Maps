/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Injects the built asset list into the service worker so the app shell is
 * fully available offline. Region packs are intentionally NOT precached:
 * they go through the in-app download manager (explicit, per-region).
 */
function swPrecache(): Plugin {
  let outDir = 'dist'
  return {
    name: 'sw-precache',
    apply: 'build',
    configResolved(cfg) {
      outDir = cfg.build.outDir
    },
    closeBundle() {
      const files: string[] = []
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name)
          if (statSync(p).isDirectory()) {
            walk(p)
            continue
          }
          const rel = relative(outDir, p).split('\\').join('/')
          if (rel === 'sw.js') continue
          if (rel.startsWith('data/regions/')) continue
          files.push('./' + rel)
        }
      }
      walk(outDir)
      const swPath = join(outDir, 'sw.js')
      const src = readFileSync(swPath, 'utf8')
      writeFileSync(swPath, src.replace('"__PRECACHE_MANIFEST__"', JSON.stringify(files)))
      console.log(`sw-precache: injected ${files.length} assets into sw.js`)
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), ...(process.env.HTTPS === '1' ? [basicSsl()] : []), swPrecache()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // keep the two heavy engines in their own long-cached chunks
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          maplibre: ['maplibre-gl', 'pmtiles'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
