import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Whistle — AI Trading Intelligence for World Cup 2026",
  description: "Real-time trading intelligence agent that detects odds-event divergences during live FIFA World Cup matches.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: "#0a0a0a", color: "#e5e5e5" }}>
        {children}
      </body>
    </html>
  );
}
