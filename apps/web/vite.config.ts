import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev-server port and API origin default to the standard :5173 → :3000
// setup; override with VITE_PORT / CLD_API_ORIGIN to run a second stack
// side by side (e.g. VITE_PORT=5273 CLD_API_ORIGIN=http://localhost:3100).
// The same go for `vite preview` (the production build), on :4173 by default.
const apiOrigin = process.env.CLD_API_ORIGIN ?? 'http://localhost:3000';
const wsOrigin = apiOrigin.replace(/^http/, 'ws');
const proxy = {
  '/api': apiOrigin,
  '/ws': { target: wsOrigin, ws: true },
  '/parts': apiOrigin,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The model importer's worker (src/import/client/worker.ts) imports the
  // shared packages: an ES module worker, so the build can split it.
  worker: { format: 'es' },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy,
  },
  // `vite preview` serves the production build the same way, so the e2e
  // specs can run against it too (the Journeys' production-build job).
  preview: {
    port: Number(process.env.VITE_PORT ?? 4173),
    strictPort: true,
    proxy,
  },
});
