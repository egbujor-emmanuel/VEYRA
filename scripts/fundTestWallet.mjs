// Operational onboarding aid: send a small amount of testnet BNB from VEYRA's operator wallet to
// a visitor's freshly created passkey wallet, so they can get past the mandatory KeyStore
// registration fee on their first admin action.
//
// Why this exists: Altana's SDK prepends a fee-bearing initialRegisterKey(admin) call to a new
// wallet's FIRST admin action, and the relay's own wallet_addFaucetFunds is a no-op for native
// BNB on BSC testnet (it returns success with a tx hash that moves 0 value). So a new wallet
// cannot self-fund, and someone has to send it BNB.
//
// Usage:  node scripts/fundTestWallet.mjs <0xaddress> [amountBNB]
//         node scripts/fundTestWallet.mjs <0xaddress> --dry-run
//
// The keystore and password live under smoketest/.studio, which is gitignored and must stay so.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, formatEther, parseEther, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(__dirname, "../smoketest/.studio");
const ENV_LOCAL_PATH = resolve(STUDIO, ".env.local");
const OPERATOR = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11";
const KEYSTORE_PATH = resolve(STUDIO, `wallets/${OPERATOR}.json`);
const RPC = "https://bsc-testnet-rpc.publicnode.com";

/** Default top-up: comfortably over the live registration fee (~0.00072) plus gas. */
const DEFAULT_AMOUNT = "0.003";

function readWalletPassword() {
  for (const line of readFileSync(ENV_LOCAL_PATH, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("WALLET_PASSWORD=")) return t.slice("WALLET_PASSWORD=".length);
  }
  throw new Error(`WALLET_PASSWORD not found in ${ENV_LOCAL_PATH}`);
}

// Keystore V3: scrypt-derive, verify the MAC (a wrong password must fail loudly rather than
// silently yield garbage key bytes), then AES-128-CTR-decrypt to recover the private key.
async function decryptKeystoreToPrivateKey(password) {
  const { scryptSync, createDecipheriv } = await import("node:crypto");
  const keystore = JSON.parse(readFileSync(KEYSTORE_PATH, "utf-8"));
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

const [, , target, arg2] = process.argv;
const dryRun = arg2 === "--dry-run";
const amount = !arg2 || dryRun ? DEFAULT_AMOUNT : arg2;

const pub = createPublicClient({ chain: bscTestnet, transport: http(RPC) });
const account = privateKeyToAccount(await decryptKeystoreToPrivateKey(readWalletPassword()));

if (account.address.toLowerCase() !== OPERATOR.toLowerCase()) {
  throw new Error(`Decrypted key is ${account.address}, expected ${OPERATOR}.`);
}
console.log(`operator          : ${account.address} (keystore decrypted, address matches)`);
console.log(`operator balance  : ${formatEther(await pub.getBalance({ address: account.address }))} tBNB`);

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
