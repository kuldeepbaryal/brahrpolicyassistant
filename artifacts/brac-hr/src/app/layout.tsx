import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BRAC HR Assistant",
  description: "Ask questions about BRAC HR policies — answers grounded in official HR documents.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#d10074",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
