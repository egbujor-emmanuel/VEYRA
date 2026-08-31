import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// base must match the GitHub Pages project-site path (repo is egbujor-emmanuel/VEYRA,
// a project repo, not a user/org root repo, so the deployed path is /VEYRA/, not /).
export default defineConfig({
  base: "/VEYRA/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
