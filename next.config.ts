import type { NextConfig } from "next";

/**
 * Sent with every response. Vercel already adds Strict-Transport-Security
 * (deliberately without includeSubDomains: beacondigitalconsulting.org has
 * other sites under it). The policy has no script-src: a strict one needs a
 * per-request nonce, which would force every page to render dynamically.
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      // 'self', not 'none': the kitchen ticket printer prints from a
      // same-origin iframe (src/components/kitchen/ticket-printer.ts).
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "upgrade-insecure-requests",
    ].join("; "),
  },
  // For browsers that predate frame-ancestors.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // The microphone stays on for the AI waiter's voice dictation
    // (src/lib/voice/dictation.ts); the camera for menu photo capture.
    key: "Permissions-Policy",
    value:
      "microphone=(self), camera=(self), geolocation=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  // The iOS app's local build loads the dev server from 127.0.0.1 (see
  // capacitor.config.ts). Dev only: production ignores this.
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
