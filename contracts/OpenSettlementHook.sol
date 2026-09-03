// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title OpenSettlementHook
 * @notice A deliberately permissive ERC-8183 settlement hook, so that the CLIENT of a job can be
 *         its own evaluator.
 *
 * Why this exists
 * ---------------
 * BNB's AgenticCommerce deployment requires every job to name a hook implementing this interface
 * (a job with hook = address(0) reverts HookRequired). The only hook available was the
 * EvaluatorRouter, and the Router's hook rejects fund() with PolicyNotSet() unless a dispute
 * policy has been registered -- while registerJob() itself reverts RouterNotEvaluator() unless
 * the Router is also the evaluator. Those two constraints together force every job to be
 * evaluated by the Router, which resolves disputes through OptimisticPolicy.voteReject().
 *
 * voteReject() is restricted to operator-granted voters. On BSC testnet that set has 2 members,
 * is administered by 0x1001b2C085345f388778A975648aA50bcfd0D134, and addVoter() is admin-only.
 * The practical consequence: a client could raise a dispute but could never resolve one, and a
 * dissatisfied user had no way to get their money back before expiry.
 *
 * This hook breaks that deadlock by imposing no policy of its own. It lets a job name the client
 * as evaluator, which under ERC-8183 makes the client the sole authority on complete() and
 * reject() -- so the person who paid decides whether the work was acceptable, and a rejection
 * refunds them immediately rather than waiting out an expiry.
 *
 * What this deliberately does NOT do
 * ----------------------------------
 * It holds no funds, has no owner, no upgrade path, and no privileged caller. It cannot move
 * tokens, cannot alter a job, and cannot block settlement -- both hook methods are empty. All
 * escrow logic stays in AgenticCommerce, which is unchanged and not ours.
 *
 * The trade-off, stated plainly: a client-evaluated job trusts the client. A dishonest client can
 * reject good work and reclaim the budget. That is the mirror image of the Router flow, where the
 * provider is protected but the client cannot act. Neither is universally correct, so VEYRA offers
 * both and labels which one a job uses.
 */
contract OpenSettlementHook {
    /// @dev beforeAction.selector ^ afterAction.selector -- the id AgenticCommerce checks for.
    bytes4 private constant HOOK_INTERFACE_ID = 0x7ff6bc9e;
    bytes4 private constant ERC165_INTERFACE_ID = 0x01ffc9a7;

    /// @notice No-op. This hook imposes no preconditions on any job action.
    function beforeAction(uint256, bytes4, bytes calldata) external pure {}

    /// @notice No-op. This hook observes no job action.
    function afterAction(uint256, bytes4, bytes calldata) external pure {}

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == HOOK_INTERFACE_ID || interfaceId == ERC165_INTERFACE_ID;
    }
}
