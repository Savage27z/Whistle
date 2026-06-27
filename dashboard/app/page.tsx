import "./globals.css";

export default function LandingPage() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Hero */}
      <header style={{ padding: "80px 24px 60px", textAlign: "center", maxWidth: 800, margin: "0 auto" }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>⚽</div>
        <h1 style={{ fontSize: 56, fontWeight: 800, margin: "0 0 16px", letterSpacing: "-2px", color: "#fff" }}>
          Whistle
        </h1>
        <p style={{ fontSize: 22, color: "#a3a3a3", lineHeight: 1.5, margin: "0 0 40px" }}>
          AI-powered real-time trading intelligence for live FIFA World Cup 2026 matches.
          <br />
          Detects what you miss. Alerts you before the market catches up.
        </p>
        <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
          <a
            href="https://t.me/WhistleAlertBot"
            target="_blank"
            rel="noopener"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "14px 32px",
              background: "#0088cc",
              color: "#fff",
              borderRadius: 12,
              fontSize: 18,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Open in Telegram
          </a>
          <a
            href="/live"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "14px 32px",
              background: "#1a1a1a",
              color: "#e5e5e5",
              borderRadius: 12,
              fontSize: 18,
              fontWeight: 600,
              border: "1px solid #333",
              textDecoration: "none",
            }}
          >
            Live Dashboard
          </a>
        </div>
      </header>

      {/* How it works */}
      <section style={{ padding: "60px 24px", maxWidth: 900, margin: "0 auto", width: "100%" }}>
        <h2 style={{ fontSize: 32, fontWeight: 700, textAlign: "center", margin: "0 0 48px", color: "#fff" }}>
          How Whistle Sees the Gap
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 24 }}>
          <Card
            emoji="🔴"
            title="Silent Odds Shift"
            desc="Odds move sharply across bookmakers but no match event happened. Something is happening off-camera — injury, tactical change, or insider information."
          />
          <Card
            emoji="🟠"
            title="Delayed Market Reaction"
            desc="A goal or red card just happened but odds are flat. The market hasn't priced it in yet. Window is closing fast."
          />
          <Card
            emoji="🟡"
            title="Momentum Mispricing"
            desc="One team has sustained high-danger pressure but odds don't reflect it. Goal probability is higher than the market implies."
          />
          <Card
            emoji="⚪"
            title="Bookmaker Disagreement"
            desc="Bookmakers disagree on an outcome by 15%+. Some books know something others don't."
          />
        </div>
      </section>

      {/* Architecture */}
      <section style={{ padding: "60px 24px", maxWidth: 800, margin: "0 auto", width: "100%" }}>
        <h2 style={{ fontSize: 32, fontWeight: 700, textAlign: "center", margin: "0 0 32px", color: "#fff" }}>
          Dual-Stream Intelligence
        </h2>
        <div
          style={{
            background: "#111",
            borderRadius: 16,
            padding: 32,
            fontFamily: "monospace",
            fontSize: 14,
            lineHeight: 1.8,
            border: "1px solid #222",
            color: "#a3a3a3",
          }}
        >
          <div>TxODDS Scores Stream ──→ Event Tracker ──┐</div>
          <div>
            {"                                          "}├──→ Divergence Detector ──→ AI Narrator ──→ Telegram
          </div>
          <div>TxODDS Odds Stream ────→ Odds Tracker ──┘</div>
        </div>
        <p style={{ textAlign: "center", color: "#737373", marginTop: 16, fontSize: 14 }}>
          Two SSE streams. Two independent trackers. One brain that finds the gaps between them.
        </p>
      </section>

      {/* Footer */}
      <footer style={{ padding: "40px 24px", textAlign: "center", color: "#525252", marginTop: "auto" }}>
        <p>Built for the TxODDS World Cup Hackathon — Track 2: Trading Tools & Agents</p>
      </footer>
    </div>
  );
}

function Card({ emoji, title, desc }: { emoji: string; title: string; desc: string }) {
  return (
    <div
      style={{
        background: "#111",
        borderRadius: 16,
        padding: 24,
        border: "1px solid #222",
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 12 }}>{emoji}</div>
      <h3 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px", color: "#fff" }}>{title}</h3>
      <p style={{ fontSize: 14, color: "#a3a3a3", lineHeight: 1.6, margin: 0 }}>{desc}</p>
    </div>
  );
}
