// One-time operational script: mint ONE real, unfarmed PancakeSwap V3 position on BSC
// testnet, owned by the VEYRA wallet. Architecture doc §6 step 1 ("Setup, once, before any
// job runs"). Deliberately small amounts, deliberately wide/simple range -- this slice
// establishes clean, independently-verifiable on-chain state; strategy quality is a later
// concern (rangeKeeperStrategy), not this script's job.
//
// Sequence: deploy VeyraDemoUSD (test token) -> wrap a small amount of tBNB into WBNB ->
// createAndInitializePoolIfNecessary -> approve both tokens to the NFPM -> mint -> read the
// position AND its owner back independently (never trust the mint call's own return value
// as the only evidence).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  decodeEventLog,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ensureTestnetRpcOverride } from "../src/network.js";
import { PANCAKE_V3_TESTNET, WBNB_TESTNET, TICK_SPACING_BY_FEE } from "../src/testnetAddresses.js";
import { ERC20_ABI, WBNB_ABI, NFPM_ABI, FACTORY_ABI, POOL_ABI } from "../src/abis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname at runtime is dist/scripts/ -- 4 levels up reaches the repo root.
const SMOKETEST_ROOT = resolve(__dirname, "../../../../smoketest");
const ENV_LOCAL_PATH = resolve(SMOKETEST_ROOT, ".studio/.env.local");
const KEYSTORE_PATH = resolve(SMOKETEST_ROOT, ".studio/wallets/0x9429BE71274b9E5fB56EE7C57C58298FFF720f11.json");
const NOTES_PATH = resolve(__dirname, "../../../../docs/VEYRA_POSITION_VERIFICATION.md");
const RECORD_JSON_PATH = resolve(__dirname, "../../../../docs/veyra-position-record.json");

const FEE = 2500; // 0.25% tier
const TICK_SPACING = TICK_SPACING_BY_FEE[FEE];
const HALF_WIDTH_TICKS = 40 * TICK_SPACING; // wide/simple on purpose -- see file header
const WBNB_WRAP_AMOUNT = 20_000_000_000_000_000n; // 0.02 WBNB
const DEMO_TOKEN_SUPPLY = 10_000n * 10n ** 18n; // 10,000 VUSD, all to our own wallet
const DEMO_PRICE_VUSD_PER_WBNB = 300; // arbitrary illustrative price -- VUSD is our own test token, not a real market

function readWalletPassword(): string {
  const content = readFileSync(ENV_LOCAL_PATH, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("WALLET_PASSWORD=")) return trimmed.slice("WALLET_PASSWORD=".length);
  }
  throw new Error(`WALLET_PASSWORD not found in ${ENV_LOCAL_PATH}`);
}

// Keystore V3 (Web3 Secret Storage) decryption: scrypt-derive a key, verify the MAC
// (keccak256(derivedKey[16:32] || ciphertext) must match the stored mac -- a wrong
// password must fail loudly here, not silently produce garbage key bytes), then
// AES-128-CTR-decrypt the ciphertext to recover the raw private key. Kept local to this
// script (one-time operational need), using viem's own keccak256 rather than a second
// hashing dependency.
async function decryptKeystoreToPrivateKey(password: string): Promise<Hex> {
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
  const macKey = derivedKey.subarray(16, 32);
  const computedMac = keccak256(`0x${Buffer.concat([macKey, ciphertextBuf]).toString("hex")}`).slice(2);
  if (computedMac !== mac) {
    throw new Error("Keystore MAC mismatch -- wrong password or corrupted keystore file.");
  }

  const decipher = createDecipheriv(
    cipher,
    derivedKey.subarray(0, 16),
    Buffer.from(cipherparams.iv, "hex"),
  );
  const privateKey = Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]);
  return `0x${privateKey.toString("hex")}` as Hex;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x0 = n / 2n;
  let x1 = (x0 + n / x0) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) / 2n;
  }
  return x0;
}

// sqrtPriceX96 = sqrt(price) * 2^96, where price = token1 raw units per token0 raw unit.
// Both our tokens have 18 decimals, so the human ratio IS the raw ratio.
function sqrtPriceX96For(priceToken1PerToken0Num: bigint, priceToken1PerToken0Den: bigint): bigint {
  const Q192 = 1n << 192n;
  return isqrt((priceToken1PerToken0Num * Q192) / priceToken1PerToken0Den);
}

function tickForPrice(priceToken1PerToken0: number): number {
  return Math.floor(Math.log(priceToken1PerToken0) / Math.log(1.0001));
}

function roundToSpacing(tick: number, spacing: number): number {
  return Math.round(tick / spacing) * spacing;
}

async function main() {
  ensureTestnetRpcOverride();
  const rpcUrl = process.env.RPC_URL_BSC_TESTNET ?? process.env.RPC_URL!;

  const password = readWalletPassword();
  const privateKey = await decryptKeystoreToPrivateKey(password);
  const account = privateKeyToAccount(privateKey);
  console.log(`Loaded signer: ${account.address}`);

  const chain = {
    id: 97,
    name: "bsc-testnet",
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`tBNB balance: ${Number(balance) / 1e18}`);
  if (balance < WBNB_WRAP_AMOUNT + 5_000_000_000_000_000n) {
    throw new Error("Insufficient tBNB for wrap + gas -- fund the wallet before retrying.");
  }

  // 1. Deploy the demo token.
  const { readFileSync: rf } = await import("node:fs");
  const artifact = JSON.parse(rf(resolve(__dirname, "../../contracts/VeyraDemoUSD.json"), "utf-8"));
  console.log("Deploying VeyraDemoUSD...");
  const deployHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    args: [DEMO_TOKEN_SUPPLY],
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const demoTokenAddress = deployReceipt.contractAddress!;
  console.log(`VeyraDemoUSD deployed: ${demoTokenAddress} (tx ${deployHash})`);

  // 2. Wrap a small amount of tBNB into WBNB.
  console.log(`Wrapping ${Number(WBNB_WRAP_AMOUNT) / 1e18} tBNB into WBNB...`);
  const wrapHash = await walletClient.writeContract({
    address: WBNB_TESTNET as Hex,
    abi: WBNB_ABI,
    functionName: "deposit",
    value: WBNB_WRAP_AMOUNT,
  });
  await publicClient.waitForTransactionReceipt({ hash: wrapHash });
  console.log(`Wrapped (tx ${wrapHash})`);

  // 3. Determine token0/token1 ordering (V3 requires token0 < token1 by address) and the
  // corresponding sqrtPriceX96 for our chosen illustrative price.
  const wbnbLower = WBNB_TESTNET.toLowerCase();
  const demoLower = demoTokenAddress.toLowerCase();
  const wbnbIsToken0 = wbnbLower < demoLower;
  const token0 = wbnbIsToken0 ? WBNB_TESTNET : demoTokenAddress;
  const token1 = wbnbIsToken0 ? demoTokenAddress : WBNB_TESTNET;

  const priceToken1PerToken0 = wbnbIsToken0 ? DEMO_PRICE_VUSD_PER_WBNB : 1 / DEMO_PRICE_VUSD_PER_WBNB;
  const sqrtPriceX96 = wbnbIsToken0
    ? sqrtPriceX96For(BigInt(DEMO_PRICE_VUSD_PER_WBNB), 1n)
    : sqrtPriceX96For(1n, BigInt(DEMO_PRICE_VUSD_PER_WBNB));

  const currentTick = roundToSpacing(tickForPrice(priceToken1PerToken0), TICK_SPACING);
  const tickLower = currentTick - HALF_WIDTH_TICKS;
  const tickUpper = currentTick + HALF_WIDTH_TICKS;

  console.log(`token0=${token0} token1=${token1} fee=${FEE} sqrtPriceX96=${sqrtPriceX96}`);
  console.log(`tickLower=${tickLower} tickUpper=${tickUpper} (spacing ${TICK_SPACING})`);

  // 4. Create + initialize the pool.
  console.log("Creating and initializing pool...");
  const createPoolHash = await walletClient.writeContract({
    address: PANCAKE_V3_TESTNET.nonfungiblePositionManager as Hex,
    abi: NFPM_ABI,
    functionName: "createAndInitializePoolIfNecessary",
    args: [token0 as Hex, token1 as Hex, FEE, sqrtPriceX96],
  });
  await publicClient.waitForTransactionReceipt({ hash: createPoolHash });
  console.log(`Pool created/initialized (tx ${createPoolHash})`);

  const poolAddress = await publicClient.readContract({
    address: PANCAKE_V3_TESTNET.factory as Hex,
    abi: FACTORY_ABI,
    functionName: "getPool",
    args: [token0 as Hex, token1 as Hex, FEE],
  });
  console.log(`Pool address: ${poolAddress}`);

  // 5. Approve both tokens to the NFPM.
  const amount0Desired = wbnbIsToken0 ? WBNB_WRAP_AMOUNT : 3_000n * 10n ** 18n; // 3000 VUSD ceiling (price*wrap)
  const amount1Desired = wbnbIsToken0 ? 3_000n * 10n ** 18n : WBNB_WRAP_AMOUNT;

  for (const [addr, amt] of [
    [token0, amount0Desired] as const,
    [token1, amount1Desired] as const,
  ]) {
    const approveHash = await walletClient.writeContract({
      address: addr as Hex,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [PANCAKE_V3_TESTNET.nonfungiblePositionManager as Hex, amt],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`Approved ${addr} for ${amt} (tx ${approveHash})`);
  }

  // 6. Mint.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  console.log("Minting position...");
  const mintHash = await walletClient.writeContract({
    address: PANCAKE_V3_TESTNET.nonfungiblePositionManager as Hex,
    abi: NFPM_ABI,
    functionName: "mint",
    args: [
      {
        token0: token0 as Hex,
        token1: token1 as Hex,
        fee: FEE,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: account.address,
        deadline,
      },
    ],
  });
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
  console.log(`Mint tx: ${mintHash}, status ${mintReceipt.status}`);

  // Parse the Transfer event (ERC-721 mint) to get the tokenId, rather than trusting only the
  // simulated return value -- same discipline as the ERC-8004 registration script.
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const mintLog = mintReceipt.logs.find(
    (l) => l.address.toLowerCase() === PANCAKE_V3_TESTNET.nonfungiblePositionManager.toLowerCase() &&
      l.topics[0] === transferTopic,
  );
  if (!mintLog) throw new Error("Could not find NFPM Transfer (mint) log in receipt");
  const tokenId = BigInt(mintLog.topics[3]!);
  console.log(`Position tokenId: ${tokenId}`);

  // 7. Independently verify: read positions() and ownerOf() back from chain -- do not trust
  // the mint call's own return value as the only evidence.
  const position = await publicClient.readContract({
    address: PANCAKE_V3_TESTNET.nonfungiblePositionManager as Hex,
    abi: NFPM_ABI,
    functionName: "positions",
    args: [tokenId],
  });
  const owner = await publicClient.readContract({
    address: PANCAKE_V3_TESTNET.nonfungiblePositionManager as Hex,
    abi: NFPM_ABI,
    functionName: "ownerOf",
    args: [tokenId],
  });

  const slot0 = await publicClient.readContract({
    address: poolAddress as Hex,
    abi: POOL_ABI,
    functionName: "slot0",
  });

  console.log(`Independently verified owner: ${owner}`);
  console.log(`Independently verified position:`, position);
  console.log(`Pool slot0 (post-mint):`, slot0);

  const increaseLiquidityLog = mintReceipt.logs
    .filter((l) => l.address.toLowerCase() === PANCAKE_V3_TESTNET.nonfungiblePositionManager.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: NFPM_ABI, data: l.data, topics: l.topics, eventName: "IncreaseLiquidity" });
      } catch {
        return null;
      }
    })
    .find((decoded) => decoded !== null);
  if (!increaseLiquidityLog) throw new Error("Could not find NFPM IncreaseLiquidity log in mint receipt");
  const { amount0: mintedAmount0, amount1: mintedAmount1 } = increaseLiquidityLog.args;

  const record = {
    network: "bsc-testnet",
    chainId: 97,
    veyraAgentId: 1890,
    signerWallet: account.address,
    demoTokenAddress,
    demoTokenSymbol: "VUSD",
    wbnbAddress: WBNB_TESTNET,
    poolAddress,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    token0,
    token1,
    tickLower,
    tickUpper,
    positionTokenId: tokenId.toString(),
    liquidity: position[7].toString(),
    amount0Deposited: mintedAmount0.toString(),
    amount1Deposited: mintedAmount1.toString(),
    verifiedOwner: owner,
    transactions: {
      deployDemoToken: deployHash,
      wrapWbnb: wrapHash,
      createAndInitializePool: createPoolHash,
      mint: mintHash,
    },
    slot0AfterMint: {
      sqrtPriceX96: slot0[0].toString(),
      tick: slot0[1],
    },
    verifiedAt: new Date().toISOString(),
  };

  const jsonBody = JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(RECORD_JSON_PATH, jsonBody);
  console.log("\nWrote docs/veyra-position-record.json");

  const notes = `# VEYRA Position Verification Notes

Audit trail for the one real, unfarmed PancakeSwap V3 position minted for VEYRA Agent
(ERC-8004 agentId ${record.veyraAgentId}) on BSC testnet, per
docs/AGENT_ARENA_ARCHITECTURE.md §6 step 1. Every value below was independently read back
from chain after minting -- none of it is trusted solely from the mint transaction's own
return value.

## Identity
- VEYRA Agent ERC-8004 agentId: **${record.veyraAgentId}**
- Signer / owner wallet: \`${record.signerWallet}\`

## Tokens
- WBNB (real, confirmed via \`SwapRouter.WETH9()\` / \`V2Router.WETH()\` cross-check): \`${record.wbnbAddress}\`
- VeyraDemoUSD (VUSD) -- our own minimal test ERC-20, deployed this session, NOT a stand-in for real USDT/BUSD: \`${record.demoTokenAddress}\`

## Pool
- Address: \`${record.poolAddress}\`
- Fee tier: ${record.fee} (tick spacing ${record.tickSpacing})
- token0: \`${record.token0}\`
- token1: \`${record.token1}\`
- slot0 immediately after mint: sqrtPriceX96=${record.slot0AfterMint.sqrtPriceX96}, tick=${record.slot0AfterMint.tick}

## Position
- **Position tokenId: ${record.positionTokenId}**
- Range: tickLower=${record.tickLower}, tickUpper=${record.tickUpper}
- Liquidity (read back via \`positions(tokenId)\`): ${record.liquidity}
- Amounts deposited (from the \`IncreaseLiquidity\` event, not assumed): amount0=${record.amount0Deposited}, amount1=${record.amount1Deposited}
- Ownership independently verified via \`ownerOf(${record.positionTokenId})\`: \`${record.verifiedOwner}\`
- Unfarmed: yes -- no MasterChefV3 interaction of any kind in this slice.

## Transactions (BSC testnet)
- Deploy VeyraDemoUSD: \`${record.transactions.deployDemoToken}\`
- Wrap tBNB -> WBNB: \`${record.transactions.wrapWbnb}\`
- Create + initialize pool: \`${record.transactions.createAndInitializePool}\`
- Mint position: \`${record.transactions.mint}\`

Verified at: ${record.verifiedAt}

Full machine-readable record: \`docs/veyra-position-record.json\`.
`;
  writeFileSync(NOTES_PATH, notes);
  console.log("Wrote docs/VEYRA_POSITION_VERIFICATION.md");
}

main().catch((err) => {
  console.error("Mint failed:", err);
  process.exitCode = 1;
});
