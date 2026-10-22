import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Streaming AI Chat",
  description: "Week 1 AI integration practice"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
