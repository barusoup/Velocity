import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  clearScreen: false,
  server: {
    strictPort: true,
    port: 1420,
    // Cargo's incremental builds lock velocity.exe on Windows and trip
    // chokidar's EBUSY. cargo watches src-tauri on its own.
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          tauri: ["@tauri-apps/api", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-process", "@tauri-apps/plugin-updater", "@tauri-apps/plugin-autostart"],
          lucide: ["lucide-react"],
          icons: ["react-icons"],
        },
      },
    },
  },
});
