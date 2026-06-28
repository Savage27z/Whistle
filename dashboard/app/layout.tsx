import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Whistle — AI Trading Intelligence for World Cup 2026",
  description: "Real-time trading intelligence agent that detects odds-event divergences during live FIFA World Cup matches.",
  icons: { icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚽</text></svg>" },
  openGraph: {
    title: "Whistle — AI Trading Intelligence for World Cup 2026",
    description: "Detects what you miss. Alerts you before the market catches up. Dual-stream divergence detection powered by TxODDS.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Whistle — AI Trading Intelligence",
    description: "Real-time odds-event divergence detection for FIFA World Cup 2026.",
  },
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
