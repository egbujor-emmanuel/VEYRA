# VEYRA Position Verification Notes

Audit trail for the one real, unfarmed PancakeSwap V3 position minted for VEYRA Agent
(ERC-8004 agentId 1890) on BSC testnet, per
docs/AGENT_ARENA_ARCHITECTURE.md §6 step 1. Every value below was independently read back
from chain after minting -- none of it is trusted solely from the mint transaction's own
return value.

## Identity
- VEYRA Agent ERC-8004 agentId: **1890**
- Signer / owner wallet: `0x9429BE71274b9E5fB56EE7C57C58298FFF720f11`

## Tokens
- WBNB (real, confirmed via `SwapRouter.WETH9()` / `V2Router.WETH()` cross-check): `0xae13d989dac2f0debff460ac112a837c89baa7cd`
- VeyraDemoUSD (VUSD) -- our own minimal test ERC-20, deployed this session, NOT a stand-in for real USDT/BUSD: `0x00efbcce2ff935332fc66851cfd34a000f6c7b8d`

## Pool
- Address: `0x61c17A2C050facFdf8651b576Bc898596f5223b9`
- Fee tier: 2500 (tick spacing 50)
- token0: `0x00efbcce2ff935332fc66851cfd34a000f6c7b8d`
- token1: `0xae13d989dac2f0debff460ac112a837c89baa7cd`
- slot0 immediately after mint: sqrtPriceX96=4574240095500993253416187062, tick=-57041

## Position
- **Position tokenId: 37058**
- Range: tickLower=-59050, tickUpper=-55050
- Liquidity (read back via `positions(tokenId)`): 3624304981691222991
- Amounts deposited (from the `IncreaseLiquidity` event, not assumed): amount0=5947044489544840473, amount1=20000000000000000
- Ownership independently verified via `ownerOf(37058)`: `0x9429BE71274b9E5fB56EE7C57C58298FFF720f11`
- Unfarmed: yes -- no MasterChefV3 interaction of any kind in this slice.

## Transactions (BSC testnet)
- Deploy VeyraDemoUSD: `0x3765ff7c2dd3b8ca1452f6dfd8a3b3879586df18ff8ed1d451bd800547424488`
- Wrap tBNB -> WBNB: `0x6362f70eca42a0c3c1f78ccc5ed6c6910c1f69d8f50eb2b51ab2ec71b5679ca1`
- Create + initialize pool: `0x2206e79fd37a7012e08d97805ec55603d4f89af810fb252480a977eb41fcadf8`
- Mint position: `0x5c47fdf950bf5d84df4791eccf70a5d2db251df4f002b1f40f3fa75d62f3ee75`

Verified at: 2026-08-22T12:30:15.876Z

Full machine-readable record: `docs/veyra-position-record.json`.
