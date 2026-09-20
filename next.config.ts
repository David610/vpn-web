import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for Cloudflare Pages — unconditional, so a plain local
  // `next build` produces the same artifact CI and Cloudflare produce.
  // `next dev` ignores this setting, so local development is unaffected.
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
