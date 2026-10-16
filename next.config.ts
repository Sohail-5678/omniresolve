import type { NextConfig } from "next";

/**
 * Security headers for every response. The Content-Security-Policy (nonce-based) is set
 * per request in src/proxy.ts because the nonce must change on every page view.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The app build type-checks app code only; `npm run typecheck` covers tests and scripts too.
  typescript: { tsconfigPath: "tsconfig.next.json" },
  reactStrictMode: true,
  serverExternalPackages: ["pg", "@langchain/langgraph-checkpoint-postgres"],
  outputFileTracingIncludes: {
    "/api/results": ["./data/results/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
