import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Lokaler Dev-Server OHNE Docker.
// Der Proxy bildet exakt das Verhalten von nginx/Traefik nach:
//   Frontend ruft  /api/items  ->  Proxy strippt /api  ->  Backend bekommt /items
// Damit gelten die Bayer-Template-Regeln (Backend-Routen OHNE /api-Praefix) auch lokal 1:1.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    port: 8080,
    strictPort: true,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
});
