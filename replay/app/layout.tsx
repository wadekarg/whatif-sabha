import type { Metadata } from "next";
import "./globals.css";
import TopNav from "./components/TopNav";

export const metadata: Metadata = {
  title: "WhatIfSabha — Demo",
  description: "Bundled demo of WhatIfSabha — upload a book, watch the characters argue an alternate ending.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#faf7f2] text-[#1c1410]">
        <TopNav />
        {children}
      </body>
    </html>
  );
}
