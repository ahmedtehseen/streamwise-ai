import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Streamwise AI",
  description: "Public AI workflows and a Portfolio Assistant powered by hybrid retrieval-augmented generation (RAG) over owner-managed evidence",
  icons: {
    icon: "/icon.svg"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script id="restore-color-theme" dangerouslySetInnerHTML={{ __html: `var theme=null;try{theme=localStorage.getItem("streamwise-color-theme")}catch{}if(theme!=="light"&&theme!=="dark")theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=theme;` }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
