import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The canvas talks to one origin. In development Vite proxies /api to the orchestrator;
// `changeOrigin` rewrites the Host header so the orchestrator's DNS-rebinding guard accepts it,
// while the browser's Origin (127.0.0.1:5173 / localhost:5173) is checked against AWWO_WEB_ORIGINS.
const orchestrator = process.env.AWWO_ORCHESTRATOR_URL || 'http://127.0.0.1:8787';
const proxy = { '/api': { target: orchestrator, changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
