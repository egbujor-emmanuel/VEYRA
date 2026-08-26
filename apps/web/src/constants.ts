// The one thing genuinely hardcoded in this app: WHICH position is "the current one" to watch
// live. Everything about its STATE (owner, tick, range, liquidity, in-range) is a live read --
// only the tokenId itself is a constant, updated by hand whenever a real rebalance mints a new
// position. Currently #37079, minted by the real, independently-verified execution documented
// in docs/agent-arena-runs-v2/run-0004-resumed-mint.json.
export const VEYRA_POSITION_TOKEN_ID = 37079n;

export const VEYRA_WALLET = "0x9429BE71274b9E5fB56EE7C57C58298FFF720f11" as const;

// ERC-8004 identity -- shown as a documented, already-verified fact (not re-checked live every
// page load, per the locked product decision). Source: docs/RECON_REPORT.md §22 /
// docs/VEYRA_POSITION_VERIFICATION.md.
export const VEYRA_AGENT_ID = 1890;
export const ERC8004_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

export const BSCSCAN_TESTNET_TX_BASE = "https://testnet.bscscan.com/tx/";
