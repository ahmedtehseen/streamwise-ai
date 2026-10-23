import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Streamwise AI",
  description: "A streaming Gemini chat built during Week 1 of AI integration practice",
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
