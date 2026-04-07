import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "react-markdown",
    "unified",
    "remark-parse",
    "remark-rehype",
    "mdast-util-to-hast",
    "hast-util-to-jsx-runtime",
    "vfile",
    "unist-util-visit",
  ],
  turbopack: {
    root: process.cwd(),
  },
  devIndicators: false,
};

export default nextConfig;
