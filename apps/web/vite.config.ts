import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base must match the GitHub Pages project-site path (repo is egbujor-emmanuel/VEYRA,
// a project repo, not a user/org root repo, so the deployed path is /VEYRA/, not /).
export default defineConfig({
  base: "/VEYRA/",
  plugins: [react()],
});
