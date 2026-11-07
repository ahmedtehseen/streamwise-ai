import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Streamwise AI",
  description: "Public AI workflows and a source-grounded Portfolio Assistant backed by a Portfolio Owner-managed Knowledge Base",
  icons: {
    icon: "/icon.svg"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
