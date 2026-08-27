// Gate 1 integration: the pre-broadcast boundary between "Altana's on-chain permission scope
// allows this class of call" and "VEYRA actually lets it proceed." Altana's own session
// permissions are (target contract, function selector) only -- see altanaCallPolicy.ts's header
// comment and the published threat-model review -- so this module exists to make one thing
// structurally true: authorizeAltanaCall() runs BEFORE anything that could sign or broadcast, and
// a rejection never reaches that code at all. There is no other path to the executor in this
// module; buildCall() is only ever invoked after authorization has already passed, by the same
// function that reads its result.
//
// AltanaSessionExecutor is decoupled from @bnbagent/sdk's concrete AltanaIntentExecutor the same
// way txSigner.ts's SigningWallet is decoupled from EVMWalletProvider -- this module never
// imports the SDK, so a plain spy object is enough to test the boundary deterministically, with
// no relay, no session, and no network call involved.

import { authorizeAltanaCall, type AltanaOperation, type AltanaAuthorizedContext, type AltanaCallAuthorizationResult } from "@veyra/core";

export interface AltanaContractCall {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}

export interface AltanaIntent {
  description?: string;
  call: AltanaContractCall;
}

export interface AltanaExecuteResult {
  transactionHash?: `0x${string}`;
  status: string;
  [key: string]: unknown;
}

/** Minimal shape this module needs from an Altana session executor -- see header comment. */
export interface AltanaSessionExecutor {
  execute(intent: AltanaIntent): Promise<AltanaExecuteResult>;
}

export class AltanaCallRejectedError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`Altana call rejected by VEYRA argument policy -- refusing to build or send it: ${reasons.join("; ")}`);
    this.name = "AltanaCallRejectedError";
    this.reasons = reasons;
  }
}

export interface AltanaOperationAbis {
  nfpmAbi: readonly unknown[];
  swapRouterAbi: readonly unknown[];
}

export interface AltanaOperationAddresses {
  nfpmAddress: `0x${string}`;
  swapRouterAddress: `0x${string}`;
}

/**
 * Builds the ContractCall for one AltanaOperation. Deliberately takes no policy context and makes
 * no decision -- it is pure encoding, reachable ONLY from executeAltanaOperation below, and only
 * ever called after authorizeAltanaCall has already returned authorized:true for this exact
 * operation. It must never be called directly from anywhere else.
 */
function buildCall(op: AltanaOperation, abis: AltanaOperationAbis, addresses: AltanaOperationAddresses): AltanaContractCall {
  switch (op.kind) {
    case "collect":
      return {
        address: addresses.nfpmAddress,
        abi: abis.nfpmAbi,
        functionName: "collect",
        args: [{ tokenId: op.tokenId, recipient: op.recipient, amount0Max: op.amount0Max, amount1Max: op.amount1Max }],
      };
    case "decreaseLiquidity":
      return {
        address: addresses.nfpmAddress,
        abi: abis.nfpmAbi,
        functionName: "decreaseLiquidity",
        args: [{ tokenId: op.tokenId, liquidity: op.liquidity, amount0Min: op.amount0Min, amount1Min: op.amount1Min, deadline: op.deadline }],
      };
    case "mint":
      return {
        address: addresses.nfpmAddress,
        abi: abis.nfpmAbi,
        functionName: "mint",
        args: [
          {
            token0: op.token0, token1: op.token1, fee: op.fee, tickLower: op.tickLower, tickUpper: op.tickUpper,
            amount0Desired: op.amount0Desired, amount1Desired: op.amount1Desired, amount0Min: op.amount0Min, amount1Min: op.amount1Min,
            recipient: op.recipient, deadline: op.deadline,
          },
        ],
      };
    case "swap":
      return {
        address: addresses.swapRouterAddress,
        abi: abis.swapRouterAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: op.tokenIn, tokenOut: op.tokenOut, fee: op.fee, recipient: op.recipient, deadline: op.deadline,
            amountIn: op.amountIn, amountOutMinimum: op.amountOutMinimum, sqrtPriceLimitX96: 0n,
          },
        ],
      };
  }
}

export interface ExecuteAltanaOperationOpts {
  operation: AltanaOperation;
  context: AltanaAuthorizedContext;
  executor: AltanaSessionExecutor;
  abis: AltanaOperationAbis;
  addresses: AltanaOperationAddresses;
}

export interface ExecuteAltanaOperationResult {
  authorization: AltanaCallAuthorizationResult;
  executorResult: AltanaExecuteResult;
}

/**
 * THE pre-broadcast security boundary. authorizeAltanaCall() is called first and is the only
 * thing that decides whether execution continues -- on rejection this throws immediately,
 * before buildCall() runs and before opts.executor is touched at all, so a rejected operation
 * never reaches anything capable of signing or broadcasting. On authorization, the call is built
 * from the SAME validated operation (never re-derived from anything the caller could have
 * mutated after the check) and handed to the executor exactly once.
 */
export async function executeAltanaOperation(opts: ExecuteAltanaOperationOpts): Promise<ExecuteAltanaOperationResult> {
  const authorization = authorizeAltanaCall(opts.operation, opts.context);
  if (!authorization.authorized) {
    throw new AltanaCallRejectedError(authorization.reasons);
  }
  const call = buildCall(opts.operation, opts.abis, opts.addresses);
  const executorResult = await opts.executor.execute({ description: `VEYRA-authorized ${opts.operation.kind}`, call });
  return { authorization, executorResult };
}
