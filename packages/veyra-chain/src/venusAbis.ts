// Minimal Venus Protocol (Compound-fork) ABI fragments -- only what Health Factor Monitoring
// reads. Real, standard Compound-fork interfaces, verified live against BSC testnet this session
// (Comptroller 0x94d1820b2D1c7c7452A163983Dc888CEC546b77D; vUSDT
// 0xb7526572FFE56AB9D7489838Bf2E18e3323b441A; vBNB 0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c).

export const VENUS_COMPTROLLER_ABI = [
  {
    type: "function",
    name: "getAccountLiquidity",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  },
] as const;

// Split into two single-function ABIs, not one combined array -- avoids a viem/TS overload
// resolution quirk seen when reading two differently-shaped functions off the same `as const`
// ABI constant back-to-back against the same address type.
export const VTOKEN_BORROW_BALANCE_ABI = [
  // Real-time borrow balance (principal + accrued interest) -- nonpayable in the standard
  // Compound-fork ABI because it can trigger an interest-accrual state update; still a pure read
  // from the caller's perspective when invoked via readContract/simulateContract.
  { type: "function", name: "borrowBalanceCurrent", stateMutability: "nonpayable", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const VTOKEN_UNDERLYING_ABI = [
  { type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const ERC20_META_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/**
 * Venus write calls. Kept separate from the read ABIs above because these MOVE FUNDS.
 *
 * Venus is a Compound fork, so these return a uint256 error code instead of reverting on
 * business-logic failure -- 0 means success, anything else means the transaction was mined but
 * did nothing. A receipt with status "success" is therefore NOT proof the repayment happened;
 * the borrow balance has to be independently re-read afterwards, which is what the health-factor
 * executor does before it will report an execution as real.
 */
export const VTOKEN_WRITE_ABI = [
  { type: "function", name: "repayBorrow", stateMutability: "nonpayable", inputs: [{ name: "repayAmount", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrow", stateMutability: "nonpayable", inputs: [{ name: "borrowAmount", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrowBalanceStored", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * The native (vBNB) market's repay entrypoint. Unlike an ERC-20 market it takes no amount
 * argument -- the amount IS msg.value -- and there is nothing to approve first.
 */
export const VTOKEN_NATIVE_REPAY_ABI = [
  { type: "function", name: "repayBorrow", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "borrow", stateMutability: "nonpayable", inputs: [{ name: "borrowAmount", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;
