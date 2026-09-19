import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const port = Number(process.env.VITE_PORT || 5173);
const apiUrl = process.env.VITE_API_URL || 'http://127.0.0.1:4310';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: { '/api': apiUrl, '/auth': apiUrl },
  },
});
