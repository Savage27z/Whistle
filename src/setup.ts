/**
 * Whistle Setup Script
 *
 * Run with: npm run setup
 *
 * This script:
 * 1. Loads or generates a Solana keypair
 * 2. Gets a guest JWT from TxODDS
 * 3. Subscribes on-chain (free World Cup tier)
 * 4. Signs and activates the API token
 * 5. Writes everything to .env
 */

import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";

// ── Constants ──────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const SERVICE_LEVEL_ID = 1; // World Cup free tier (devnet only has 60s delay)
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES: number[] = [];
const ENV_PATH = path.join(process.cwd(), ".env");
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const TXLINE_API_BASE = "https://txline-dev.txodds.com";

// ── Minimal IDL for subscribe instruction ──────────────────
const IDL = {
  version: "1.5.2",
  name: "txline",
  address: PROGRAM_ID.toBase58(),
  metadata: { name: "txline", version: "1.5.2", spec: "0.1.0" },
  instructions: [
    {
      name: "subscribe",
      discriminator: [254, 28, 191, 138, 156, 179, 183, 53],
      accounts: [
        { name: "user", writable: true, signer: true },
        { name: "pricingMatrix" },
        { name: "tokenMint" },
        { name: "userTokenAccount", writable: true },
        { name: "tokenTreasuryVault", writable: true },
        { name: "tokenTreasuryPda" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
        { name: "associatedTokenProgram" },
      ],
      args: [
        { name: "serviceLevelId", type: "u16" },
        { name: "weeks", type: "u8" },
      ],
    },
  ],
} as any;

// ── Helpers ────────────────────────────────────────────────

function loadOrCreateKeypair(): Keypair {
  const envKey = process.env.SOLANA_PRIVATE_KEY;
  if (envKey) {
    try {
      const bytes = anchor.utils.bytes.bs58.decode(envKey);
      const kp = Keypair.fromSecretKey(bytes);
      console.log(`✅ Loaded existing wallet: ${kp.publicKey.toBase58()}`);
      return kp;
    } catch {
      console.log("⚠️  SOLANA_PRIVATE_KEY in .env is invalid, generating new keypair...");
    }
  }

  const kp = Keypair.generate();
  console.log(`🔑 Generated new wallet: ${kp.publicKey.toBase58()}`);
  console.log(`   Save this private key somewhere safe!`);
  return kp;
}

function updateEnv(updates: Record<string, string>): void {
  let content = "";
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(ENV_PATH, content.trim() + "\n");
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log("\n⚽ Whistle Setup — TxODDS API Access\n");
  console.log("═".repeat(50));

  // Step 1: Wallet
  console.log("\n📋 Step 1: Solana Wallet\n");
  const keypair = loadOrCreateKeypair();
  const privateKeyBs58 = anchor.utils.bytes.bs58.encode(keypair.secretKey);

  // Step 2: Check SOL balance
  console.log("\n📋 Step 2: Checking SOL balance\n");
  const connection = new Connection(RPC_URL, "confirmed");
  const balance = await connection.getBalance(keypair.publicKey);
  const solBalance = balance / 1e9;
  console.log(`   Balance: ${solBalance} SOL`);

  if (solBalance < 0.005) {
    console.log(`\n⚠️  You need a tiny amount of SOL for the transaction fee (~0.005 SOL).`);
    console.log(`   Requesting devnet airdrop...`);
    try {
      const airdropSig = await connection.requestAirdrop(keypair.publicKey, 1e9);
      await connection.confirmTransaction(airdropSig, "confirmed");
      const newBalance = await connection.getBalance(keypair.publicKey);
      console.log(`   ✅ Airdrop received! New balance: ${newBalance / 1e9} SOL`);
    } catch (err: any) {
      console.log(`   ❌ Airdrop failed: ${err.message}`);
      console.log(`   Go to https://faucet.solana.com and airdrop to: ${keypair.publicKey.toBase58()}`);
      console.log(`   Then run this script again.\n`);
      updateEnv({
        SOLANA_PRIVATE_KEY: privateKeyBs58,
        SOLANA_RPC_URL: RPC_URL,
      });
      console.log(`   ✅ Wallet saved to .env`);
      process.exit(0);
    }
  }

  // Step 3: Get guest JWT
  console.log("\n📋 Step 3: Getting guest JWT from TxODDS\n");
  const authRes = await fetch("${TXLINE_API_BASE}/auth/guest/start", { method: "POST" });
  if (!authRes.ok) {
    throw new Error(`Auth failed: ${authRes.status} ${authRes.statusText}`);
  }
  const authData = (await authRes.json()) as { token: string };
  const jwt = authData.token;
  console.log(`   ✅ Got JWT: ${jwt.slice(0, 20)}...`);

  // Step 4: Subscribe on-chain
  console.log("\n📋 Step 4: Subscribing on-chain (Free World Cup tier)\n");

  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(IDL, provider);

  // Derive PDAs
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    PROGRAM_ID
  );

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury")],
    PROGRAM_ID
  );

  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    TXL_MINT,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  const userTokenAccount = getAssociatedTokenAddressSync(
    TXL_MINT,
    keypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  console.log(`   Program ID:     ${PROGRAM_ID.toBase58()}`);
  console.log(`   Pricing Matrix: ${pricingMatrixPda.toBase58()}`);
  console.log(`   Treasury PDA:   ${tokenTreasuryPda.toBase58()}`);
  console.log(`   Service Level:  ${SERVICE_LEVEL_ID} (Real-time)`);
  console.log(`   Duration:       ${DURATION_WEEKS} weeks`);

  let txSig: string;
  try {
    // @ts-ignore — Anchor generic depth exceeds TS limit
    txSig = await program.methods
      .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
      .accounts({
        user: keypair.publicKey,
        pricingMatrix: pricingMatrixPda,
        tokenMint: TXL_MINT,
        userTokenAccount: userTokenAccount,
        tokenTreasuryVault: tokenTreasuryVault,
        tokenTreasuryPda: tokenTreasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`   ✅ Subscription tx: ${txSig}`);
  } catch (err: any) {
    console.error(`   ❌ Subscription failed: ${err.message}`);
    console.log(`\n   Common issues:`);
    console.log(`   - Not enough SOL for fees`);
    console.log(`   - PDA seeds might be slightly different`);
    console.log(`   - Network congestion — try again\n`);
    updateEnv({
      SOLANA_PRIVATE_KEY: privateKeyBs58,
      SOLANA_RPC_URL: RPC_URL,
      TXODDS_JWT: jwt,
    });
    console.log(`   Partial progress saved to .env`);
    process.exit(1);
  }

  // Step 5: Activate API token
  console.log("\n📋 Step 5: Activating API token\n");

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, keypair.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  const activateRes = await fetch("${TXLINE_API_BASE}/api/token/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      txSig,
      walletSignature,
      leagues: SELECTED_LEAGUES,
    }),
  });

  if (!activateRes.ok) {
    const errorText = await activateRes.text();
    throw new Error(`Token activation failed: ${activateRes.status} — ${errorText}`);
  }

  const activateData = await activateRes.json();
  const apiToken = (activateData as any).token || (activateData as any).apiToken || String(activateData);
  console.log(`   ✅ API token: ${String(apiToken).slice(0, 20)}...`);

  // Step 6: Save everything
  console.log("\n📋 Step 6: Saving credentials to .env\n");
  updateEnv({
    SOLANA_PRIVATE_KEY: privateKeyBs58,
    SOLANA_RPC_URL: RPC_URL,
    TXODDS_JWT: jwt,
    TXODDS_API_TOKEN: String(apiToken),
  });

  console.log("   ✅ All credentials saved to .env");
  console.log("\n" + "═".repeat(50));
  console.log("\n🎉 Setup complete! Now run:\n");
  console.log("   npm run build && npm start\n");
  console.log("   Then open your Telegram bot and send /start\n");
}

main().catch((err) => {
  console.error(`\n❌ Setup failed: ${err.message}\n`);
  process.exit(1);
});
