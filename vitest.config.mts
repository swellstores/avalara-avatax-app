import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2023-05-18",
        // Reports a rejection as unhandled only if nothing has handled it by the end of the
        // microtask queue. Without it, a rejection handled one step later fails the run
        compatibilityFlags: ["unhandled_rejection_after_microtask_checkpoint"],
      },
    }),
  ],
  test: {
    globals: true,
    // The Workers runtime cannot read Vitest's module cache from disk
    fsModuleCache: false,
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "docs"],
    setupFiles: ["./test/setup-globals.ts"],
  },
});
