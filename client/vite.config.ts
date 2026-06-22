import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API and Socket.io requests to the running nginx/backend at :80.
    // WHY proxy instead of connecting directly?
    // The browser would see requests from localhost:5173 going to localhost:80 —
    // a cross-origin request. With changeOrigin:true Vite rewrites the Origin header
    // to match the target, so the backend's CORS check (CLIENT_ORIGIN=http://localhost)
    // sees the expected origin and allows the connection.
    proxy: {
      '/socket.io': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost',
        ws: true,           // enable WebSocket proxying
        changeOrigin: true,
      },
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost',
        changeOrigin: true,
      },
    },
  },
});
