import "dotenv/config";

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  txoddsJwt: process.env.TXODDS_JWT || "",
  txoddsApiToken: process.env.TXODDS_API_TOKEN || "",
  solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY || "",
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  aiModel: process.env.AI_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
};

export function validateConfig(): void {
  const required: (keyof typeof config)[] = ["telegramBotToken"];
  const missing = required.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
