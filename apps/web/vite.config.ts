import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The proxy is what makes live mode work at all.
 *
 * The session cookie is issued by the API, and the app is served from
 * :5173. Proxying /api and /ws through the dev server keeps both same-origin,
 * so the cookie travels; calling the API on its own origin instead would drop
 * it and every request would look anonymous.
 *
 * The port must match apps/server's PORT (see apps/server/.env.example, 8080).
 * It said 3000 for a while, which is the default nothing in this repo uses, and
 * live mode simply 500'd.
 */
const API_PORT = process.env.RSC_API_PORT ?? '8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${API_PORT}`, ws: true }
    }
  }
});
