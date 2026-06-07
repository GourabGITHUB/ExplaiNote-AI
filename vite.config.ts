import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { viteStaticCopy } from 'vite-plugin-static-copy';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  optimizeDeps: {
      exclude: ['pdfjs-dist'], // ✅ Prevent Vite from breaking pdf.js internals
    },
    worker: {
      format: 'es', // ✅ Required for pdf.js ESM worker
    },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
