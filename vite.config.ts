import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Tauri は固定ポートを要求するため strictPort: true
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome110",
    rollupOptions: {
      input: {
        manage: resolve(__dirname, "index.html"),
        focus: resolve(__dirname, "focus.html"),
        capture: resolve(__dirname, "capture.html"),
      },
    },
  },
});
