import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "OmniResolve — agents with receipts",
  description:
    "A customer-support agent that refunds, replaces and ships — and can't be talked into it. The LLM proposes; code decides; a human approves what matters; a saga makes it stick.",
  applicationName: "OmniResolve",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#e8703a",
  width: "device-width",
  initialScale: 1,
};

// Every page is rendered per request so the CSP nonce (src/proxy.ts) can be applied.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${archivo.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
