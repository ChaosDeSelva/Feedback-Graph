import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { inlineAsset } from './build/assets.ts';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Fonts as files: the CSP refuses data: fonts (build/assets.ts).
  build: { assetsInlineLimit: inlineAsset },
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { name: 'ui', environment: 'jsdom', include: ['src/**/*.test.tsx'] },
});
