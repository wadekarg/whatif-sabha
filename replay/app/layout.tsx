import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WhatIfSabha — Debate Replay",
  description: "Watch an AI-agent debate replay an alternate ending to a classic story.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
