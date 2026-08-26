// Browser-side viem client. Deliberately NOT importing @veyra/chain's network.ts --
// ensureTestnetRpcOverride() mutates process.env, which is meaningless in a browser bundle.
// Same RPC URL that function resolves to (verified working throughout this project's live
// scripts, since the SDK's own default testnet RPC is dead -- see docs/RECON_REPORT.md §22),
// checked in here as an explicit constant with a Vite env var escape hatch.

import { createPublicClient, http, type Chain } from "viem";

const DEFAULT_RPC_URL = "https://bsc-testnet-rpc.publicnode.com";

export const RPC_URL: string = (import.meta.env.VITE_RPC_URL as string | undefined) ?? DEFAULT_RPC_URL;

export const bscTestnet: Chain = {
  id: 97,
  name: "BSC Testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

export const publicClient = createPublicClient({
  chain: bscTestnet,
  transport: http(RPC_URL),
});
