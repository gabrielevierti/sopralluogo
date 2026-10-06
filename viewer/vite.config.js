import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built viewer works from any folder or from `sopralluogo serve`
export default defineConfig({ plugins: [react()], base: "./" });
