import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
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
