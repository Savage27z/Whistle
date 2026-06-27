import "dotenv/config";

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  txoddsJwt: process.env.TXODDS_JWT || "",
  txoddsApiToken: process.env.TXODDS_API_TOKEN || "",
  solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY || "",
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
};

export function validateConfig(): void {
  const required: (keyof typeof config)[] = ["telegramBotToken"];
  const missing = required.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
