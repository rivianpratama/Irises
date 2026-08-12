import type { NextConfig } from "next";

// The web app is a thin debug client that is built to a static bundle and
// served by the Irises brain (Express) behind Caddy. Security headers
// (CSP, X-Frame-Options, etc.) are now set by the server / Caddy, not here —
// `output: 'export'` does not support Next's `headers()` config.
const nextConfig: NextConfig = {
  output: "export",
  images: {
    // The static export has no Image Optimization server; serve images as-is.
    unoptimized: true
  },
  turbopack: {
    root: process.cwd()
  }
};

export default nextConfig;
