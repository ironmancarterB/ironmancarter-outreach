import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiPort = Number(process.env.OUTREACH_API_PORT ?? 5181)

export default defineConfig({
  root: 'apps/web',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.OUTREACH_WEB_PORT ?? 5180),
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
  build: { outDir: '../../dist', emptyOutDir: true },
})
