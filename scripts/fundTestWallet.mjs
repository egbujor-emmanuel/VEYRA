// Operational onboarding aid: send a small amount of testnet BNB from VEYRA's operator wallet to
// a visitor's freshly created passkey wallet, so they can get past the mandatory KeyStore
// registration fee on their first admin action.
//
// Why this exists: Altana's SDK prepends a fee-bearing initialRegisterKey(admin) call to a new
// wallet's FIRST admin action, and the relay's own wallet_addFaucetFunds is a no-op for native
// BNB on BSC testnet (it returns success with a tx hash that moves 0 value). So a new wallet
// cannot self-fund, and someone has to send it BNB.
//
// Usage:  node scripts/fundTestWallet.mjs <0xaddress> [amountBNB] [--from=operator|ambient] [--dry-run]
//
// --from selects which of our two testnet wallets signs. The operator wallet is VEYRA's own
// identity; the ambient wallet was funded for liquidity seeding and generally holds more.
//
// The keystores and passwords live under smoketest/.studio, which is gitignored and must stay so.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, formatEther, parseEther, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(__dirname, "../smoketest/.studio");
const ENV_LOCAL_PATH = resolve(STUDIO, ".env.local");
const RPC = "https://bsc-testnet-rpc.publicnode.com";

/** Our two testnet wallets, each with its own password entry in .env.local. */
const SIGNERS = {
  operator: { address: "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11", passwordKey: "WALLET_PASSWORD" },
  ambient: { address: "0x62472499C7390ee1dbfb45E782847b35c754C5f0", passwordKey: "AMBIENT_WALLET_PASSWORD" },
};

/** Default top-up: comfortably over the live registration fee (~0.00072) plus gas. */
const DEFAULT_AMOUNT = "0.003";

function readSecret(key) {
  for (const line of readFileSync(ENV_LOCAL_PATH, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1);
  }
  throw new Error(`${key} not found in ${ENV_LOCAL_PATH}`);
}

// Keystore V3: scrypt-derive, verify the MAC (a wrong password must fail loudly rather than
// silently yield garbage key bytes), then AES-128-CTR-decrypt to recover the private key.
async function decryptKeystoreToPrivateKey(address, password) {
  const { scryptSync, createDecipheriv } = await import("node:crypto");
  const keystore = JSON.parse(readFileSync(resolve(STUDIO, `wallets/${address}.json`), "utf-8"));
  const { kdfparams, ciphertext, cipher, cipherparams, mac } = keystore.crypto;
  const derivedKey = scryptSync(
    Buffer.from(password, "utf-8"),
    Buffer.from(kdfparams.salt, "hex"),
    kdfparams.dklen,
    { N: kdfparams.n, r: kdfparams.r, p: kdfparams.p, maxmem: 512 * 1024 * 1024 },
  );
  const ciphertextBuf = Buffer.from(ciphertext, "hex");
  const computedMac = keccak256(
    `0x${Buffer.concat([derivedKey.subarray(16, 32), ciphertextBuf]).toString("hex")}`,
  ).slice(2);
  if (computedMac !== mac) throw new Error("Keystore MAC mismatch -- wrong password or corrupted keystore.");
  const decipher = createDecipheriv(cipher, derivedKey.subarray(0, 16), Buffer.from(cipherparams.iv, "hex"));
  return `0x${Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]).toString("hex")}`;
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));
const [target, amountArg] = positional;
const dryRun = flags.includes("--dry-run");
const fromKey = (flags.find((f) => f.startsWith("--from="))?.split("=")[1] ?? "operator");
const signer = SIGNERS[fromKey];
if (!signer) throw new Error(`Unknown --from=${fromKey}. Use one of: ${Object.keys(SIGNERS).join(", ")}`);
const amount = amountArg ?? DEFAULT_AMOUNT;

const pub = createPublicClient({ chain: bscTestnet, transport: http(RPC) });
const account = privateKeyToAccount(
  await decryptKeystoreToPrivateKey(signer.address, readSecret(signer.passwordKey)),
);

// A mismatch here means we decrypted a different key than intended -- never send on that basis.
if (account.address.toLowerCase() !== signer.address.toLowerCase()) {
  throw new Error(`Decrypted key is ${account.address}, expected ${signer.address}.`);
}
console.log(`from (${fromKey})`.padEnd(18) + `: ${account.address} (keystore decrypted, address matches)`);
console.log(`from balance      : ${formatEther(await pub.getBalance({ address: account.address }))} tBNB`);

if (!target) {
  console.log("\nNo target address given. Pass one to fund it:");
  console.log("  node scripts/fundTestWallet.mjs 0x<address>");
  process.exit(0);
}
if (!isAddress(target)) throw new Error(`Not a valid address: ${target}`);

console.log(`target            : ${target}`);
console.log(`target balance    : ${formatEther(await pub.getBalance({ address: target }))} tBNB`);
console.log(`amount to send    : ${amount} tBNB`);

if (dryRun) {
  console.log("\n--dry-run: nothing sent.");
  process.exit(0);
}

const wallet = createWalletClient({ account, chain: bscTestnet, transport: http(RPC) });
const hash = await wallet.sendTransaction({ to: target, value: parseEther(amount) });
console.log(`\nsent tx           : ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`receipt status    : ${receipt.status}  block ${receipt.blockNumber}`);
console.log(`target balance now: ${formatEther(await pub.getBalance({ address: target }))} tBNB`);
console.log(`explorer          : https://testnet.bscscan.com/tx/${hash}`);
