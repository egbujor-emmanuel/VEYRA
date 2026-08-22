// BSC testnet network wiring for @bnbagent/sdk.
//
// RECON_REPORT.md §22 found the SDK's hardcoded default bsc-testnet RPC
// (data-seed-prebsc-2-s2.binance.org) dead (DNS does not resolve). The SDK's
// own resolveNetwork() reads RPC_URL_BSC_TESTNET / RPC_URL as an override --
// this must be set before any @bnbagent/sdk class touches bsc-testnet, or
// construction fails with a ConnectionError.
const WORKING_TESTNET_RPC = "https://bsc-testnet-rpc.publicnode.com";

export function ensureTestnetRpcOverride(): void {
  if (!process.env.RPC_URL_BSC_TESTNET && !process.env.RPC_URL) {
    process.env.RPC_URL_BSC_TESTNET = WORKING_TESTNET_RPC;
  }
}
