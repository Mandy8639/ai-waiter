import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The iOS app's local build loads the dev server from 127.0.0.1 (see
  // capacitor.config.ts). Dev only: production ignores this.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
