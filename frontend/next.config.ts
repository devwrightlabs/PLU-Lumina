/**
 * next.config.ts — Production-grade Next.js configuration for Lumina.
 *
 * Key decisions:
 *  - `output: "standalone"` produces a self-contained bundle for Docker /
 *    serverless deployments without requiring node_modules to be copied.
 *  - `reactStrictMode: true` surfaces potential hydration issues during
 *    development (double-invocation of render functions in dev mode).
 *  - `poweredByHeader: false` removes the "X-Powered-By: Next.js" response
 *    header, reducing the attack surface for fingerprinting.
 *  - Security headers are set here rather than in middleware so they apply
 *    to every route including static assets.
 *
 * Environment variables consumed by this config are defined in .env.example.
 */

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Prevent the Pi Browser's WebView from rendering Lumina inside an
          // iframe on a different origin (clickjacking protection).
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            // Restrict camera/mic/geolocation — Lumina does not require them.
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
