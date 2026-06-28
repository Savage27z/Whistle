import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  // Try backend API first (production), fall back to local file (dev)
  const backendUrl = process.env.BACKEND_URL;
  if (backendUrl) {
    try {
      const res = await fetch(`${backendUrl}/api/alerts`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        return NextResponse.json(data);
      }
    } catch {}
  }

  // Fallback: read local file
  const dataPath = path.join(process.cwd(), "..", "whistle-data.json");
  try {
    if (!fs.existsSync(dataPath)) {
      return NextResponse.json([]);
    }
    const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
    const alerts = (data.alerts || []).slice(-50).reverse();
    return NextResponse.json(alerts);
  } catch {
    return NextResponse.json([]);
  }
}
