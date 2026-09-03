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

// ---- Grid Trading: real testnet grid-slot positions, minted this session ----
// Slot 0 (#37091) held at the ladder's own target; slot 1 was #37092, real-executed a recenter,
// and is now #37093 -- see docs/grid-runs/run-0002.json + run-0002-resumed-mint.json.
export const GRID_TRADING_POOL_ADDRESS = "0x61c17A2C050facFdf8651b576Bc898596f5223b9" as const;
export const GRID_POSITION_TOKEN_IDS = [37091n, 37093n] as const;

// ---- Yield Optimisation: the real pool VEYRA's capital sits in, plus a real, freshly
// initialized 0.05% sibling pool minted this session as a genuine second candidate ----
export const YIELD_CURRENT_POOL = { poolAddress: "0x61c17A2C050facFdf8651b576Bc898596f5223b9" as const, label: "VUSD/WBNB 0.25%", fee: 2500 };
export const YIELD_CANDIDATE_POOLS = [{ poolAddress: "0x8523c332b034b6D7586116b7739D0048fF1B7888" as const, label: "VUSD/WBNB 0.05%", fee: 500 }];

// ---- ERC-8183 job escrow (the paid-hire rail) ----
// Addresses come from @bnbagent/sdk's own bsc-testnet network config and were each independently
// confirmed live on-chain (contract code present) before being wired up here.
export const ERC8183_TESTNET = {
  commerce: "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de" as const,
  router: "0xd7d36d66d2f1b608a0f943f722d27e3744f66f25" as const,
  policy: "0xd6a4217588f6b1f5657a92a3e94e6422ad771cea" as const,
};
/** The $U payment token, read live from the Commerce kernel's own paymentToken(). 18 decimals. */
export const U_TOKEN_TESTNET = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565" as const;
export const U_TOKEN_FAUCET_TESTNET = "0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3" as const;

/**
 * VEYRA's own ERC-8183 settlement hook (contracts/OpenSettlementHook.sol), deployed so that the
 * CLIENT can be their own evaluator.
 *
 * Without it, every job had to name the EvaluatorRouter as evaluator: the Router's hook rejects
 * fund() with PolicyNotSet() on any job it does not evaluate, and registerJob() (which sets that
 * policy) reverts RouterNotEvaluator() otherwise. That forced disputes through
 * OptimisticPolicy.voteReject(), restricted to operator-granted voters -- so a user could raise a
 * dispute but never resolve one. This hook imposes no policy, holds no funds, has no owner and no
 * upgrade path; both of its methods are empty.
 */
export const VEYRA_SETTLEMENT_HOOK = "0xb9a689d455b8dcf91698766bc43aee4f1d7b8b71" as const;

// ---- Health Factor Monitoring: real Venus Protocol testnet infrastructure ----
export const VENUS_COMPTROLLER_TESTNET = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D" as const;
export const VENUS_VUSDT_TESTNET = "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A" as const;
