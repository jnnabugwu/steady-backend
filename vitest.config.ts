import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // No test may reach the network: the Anthropic client and Redis are
    // always injected fakes (see test/helpers).
    unstubEnvs: true,
  },
});
