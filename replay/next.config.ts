import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  // Hide the Next.js dev-mode indicator badge (the floating "N"/DevTools pill).
  // No effect on production builds — it only existed in dev.
  devIndicators: false,
};

export default config;
