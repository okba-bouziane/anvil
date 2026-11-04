import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: { index: 'src/main/index.ts', 'intel-worker': 'src/main/intel-worker.ts' } } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } } } },
  renderer: {
    plugins: [
      react(),
      // The strict page policy blocks Vite's dev-only inline script, so it applies to built apps only.
      { name: 'dev-csp', apply: 'serve', transformIndexHtml: (html: string) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '') }
    ]
  }
})
