// BSC testnet (chainId 97) addresses. PancakeSwap V3 core/periphery addresses are the ones
// live-verified via eth_getCode in RECON_REPORT.md §22 -- not re-derived here. WBNB was
// ambiguous between two candidates surfaced by search (see chat record for this slice); it was
// resolved authoritatively by calling `WETH9()` on the verified SwapRouter and `WETH()` on the
// verified V2 Router -- both independently returned the same address, which is the one used below.

export const PANCAKE_V3_TESTNET = {
  factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  poolDeployer: "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9",
  nonfungiblePositionManager: "0x427bF5b37357632377eCbEC9de3626C71A5396c1",
  swapRouter: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
  smartRouter: "0x9a489505a00cE272eAa5e07Dba6491314CaE3796",
  masterChefV3: "0x4c650FB471fe4e0f476fD3437C3411B1122c4e3B",
  quoterV2: "0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2",
  tickLens: "0xac1cE734566f390A94b00eb9bf561c2625BF44ea",
} as const;

// Confirmed on-chain via SwapRouter.WETH9() and V2Router.WETH(), both returning this address.
export const WBNB_TESTNET = "0xae13d989dac2f0debff460ac112a837c89baa7cd";

export const TICK_SPACING_BY_FEE: Record<number, number> = {
  100: 1,
  500: 10,
  2500: 50,
  10000: 200,
};
