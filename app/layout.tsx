import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Streamwise AI",
  description: "A Gemini learning project for streaming chat, structured output, tool calling, and multimodal task intake",
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
