"use client";

import { useState, useEffect } from "react";

interface Alert {
  id: number;
  fixture_id: number;
  type: string;
  severity: string;
  title: string;
  message: string;
  created_at: number;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#a3a3a3",
};

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪",
};

export default function LiveDashboard() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    async function fetchAlerts() {
      try {
        const res = await fetch("/api/alerts");
        if (res.ok) {
          const data = await res.json();
          setAlerts(data);
          setConnected(true);
        }
      } catch {
        setConnected(false);
      }
    }

    fetchAlerts();
    const interval = setInterval(fetchAlerts, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ minHeight: "100vh", padding: 24, maxWidth: 1000, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/" style={{ fontSize: 28, textDecoration: "none" }}>⚽</a>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "#fff" }}>Whistle Live</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: connected ? "#22c55e" : "#ef4444",
            }}
          />
          <span style={{ fontSize: 14, color: "#737373" }}>
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </header>

      {alerts.length === 0 ? (
        <div style={{ textAlign: "center", padding: "80px 0", color: "#525252" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📡</div>
          <p style={{ fontSize: 18 }}>No alerts yet. Watch a live match via the Telegram bot to see alerts here.</p>
          <p style={{ fontSize: 14, marginTop: 8 }}>Alerts will appear here in real-time when divergences are detected.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {alerts.map((alert) => (
            <div
              key={alert.id}
              style={{
                background: "#111",
                borderRadius: 12,
                padding: 20,
                border: "1px solid #222",
                borderLeft: `4px solid ${SEVERITY_COLORS[alert.severity] || "#333"}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span>{SEVERITY_EMOJI[alert.severity] || "⚪"}</span>
                  <span style={{ fontWeight: 700, color: "#fff", fontSize: 16 }}>{alert.title}</span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 6,
                      background: "#1a1a1a",
                      color: SEVERITY_COLORS[alert.severity] || "#666",
                      textTransform: "uppercase",
                      fontWeight: 600,
                    }}
                  >
                    {alert.severity}
                  </span>
                </div>
                <span style={{ fontSize: 12, color: "#525252" }}>
                  {new Date(alert.created_at * 1000).toLocaleTimeString()}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 14, color: "#a3a3a3", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {alert.message}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
