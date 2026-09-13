// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IProofmarkRegistry {
    function isVerified(address subject, uint256 policyId) external view returns (bool);
    function policyFrozen(uint256 policyId) external view returns (bool);
    function policyRequiresRoster(uint256 policyId) external view returns (bool);
    function ROSTER_WITNESS_VERSION() external view returns (uint256);
}

/// @title GatedRwaNote
/// @notice A demo RWA token, a credit note, transferable only between wallets that pass a policy.
/// @dev This contract makes the USC dependency visible at the asset boundary: the gate reads
///      compliance state that only a verified source event can change.
///
/// Tokenised assets carry a legal requirement to screen holders. This contract enforces that at
/// transfer time. New deployments require a frozen fresh-roster policy and a verified current
/// roster witness for each holder. Source issuer approvals are proved through USC; the
/// roster's completeness and screening quality remain issuer/publisher trust assumptions.
///
/// The policy is fixed in the constructor because which policy gates the token is a property of the
/// token. Deploy one instance under a KR policy and another under an EU policy and the same mark
/// gets two different answers.
contract GatedRwaNote is ERC20, Ownable2Step {
    uint256 public constant RECOVERY_GOVERNANCE_VERSION = 1;
    uint40 public constant MIN_RECOVERY_DELAY = 1 hours;

    IProofmarkRegistry public immutable REGISTRY;

    /// @notice The compliance policy this token requires. Immutable.
    uint256 public immutable POLICY_ID;

    bool private complianceBypass;

    enum RecoveryKind {
        Transfer,
        Burn
    }

    struct RecoveryRequest {
        address from;
        address to;
        uint256 amount;
        bytes32 reasonHash;
        address proposer;
        address approver;
        uint40 executeAfter;
        RecoveryKind kind;
        bool executed;
    }

    address public recoveryProposer;
    address public recoveryApprover;
    uint256 public nextRecoveryId = 1;
    mapping(uint256 => RecoveryRequest) public recoveryRequests;

    error SenderNotVerified(address from, uint256 policyId);
    error RecipientNotVerified(address to, uint256 policyId);
    error PolicyMustBeFrozen(uint256 policyId);
    error PolicyMustRequireRoster(uint256 policyId);
    error RecoveryGovernanceAlreadyConfigured();
    error InvalidRecoveryGovernance();
    error NotRecoveryProposer(address caller);
    error NotRecoveryApprover(address caller);
    error InvalidRecoveryRequest();
    error RecoveryNotApproved(uint256 recoveryId);
    error RecoveryDelayActive(uint256 recoveryId, uint40 executeAfter);

    event RecoveryGovernanceConfigured(address indexed proposer, address indexed approver, uint40 minimumDelay);
    event RecoveryProposed(
        uint256 indexed recoveryId,
        RecoveryKind indexed kind,
        address indexed from,
        address to,
        uint256 amount,
        bytes32 reasonHash,
        address proposer,
        uint40 executeAfter
    );
    event RecoveryApproved(uint256 indexed recoveryId, address indexed approver, bytes32 indexed reasonHash);
    event RecoveryExecuted(
        uint256 indexed recoveryId,
        RecoveryKind indexed kind,
        address indexed from,
        address to,
        uint256 amount,
        bytes32 reasonHash,
        address proposer,
        address approver
    );

    constructor(string memory name_, string memory symbol_, address registry, uint256 policyId, address initialOwner)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    {
        require(registry != address(0), "zero registry");
        if (!IProofmarkRegistry(registry).policyFrozen(policyId)) revert PolicyMustBeFrozen(policyId);
        require(IProofmarkRegistry(registry).ROSTER_WITNESS_VERSION() == 1, "unsupported roster witness");
        if (!IProofmarkRegistry(registry).policyRequiresRoster(policyId)) revert PolicyMustRequireRoster(policyId);
        REGISTRY = IProofmarkRegistry(registry);
        POLICY_ID = policyId;
    }

    /// @notice Mint. The recipient must pass the policy; _update below enforces it.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Redeem and burn.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Configures distinct proposal and approval authorities exactly once. The owner may
    ///         nominate itself as one side, but can never satisfy both sides of a recovery alone.
    /// @dev The one-hour floor is a technical review window, not a claim that it satisfies any
    ///      asset, customer or jurisdiction-specific notice requirement.
    function configureRecoveryGovernance(address proposer, address approver) external onlyOwner {
        if (recoveryProposer != address(0)) revert RecoveryGovernanceAlreadyConfigured();
        if (proposer == address(0) || approver == address(0) || proposer == approver) {
            revert InvalidRecoveryGovernance();
        }
        recoveryProposer = proposer;
        recoveryApprover = approver;
        emit RecoveryGovernanceConfigured(proposer, approver, MIN_RECOVERY_DELAY);
    }

    /// @notice Proposes an exact forced transfer or burn with an opaque case/reason commitment.
    ///         Cleartext case material must remain off chain.
    function proposeRecovery(RecoveryKind kind, address from, address to, uint256 amount, bytes32 reasonHash)
        external
        returns (uint256 recoveryId)
    {
        if (msg.sender != recoveryProposer) revert NotRecoveryProposer(msg.sender);
        if (
            from == address(0) || amount == 0 || reasonHash == bytes32(0)
                || (kind == RecoveryKind.Transfer && to == address(0))
                || (kind == RecoveryKind.Burn && to != address(0))
        ) revert InvalidRecoveryRequest();
        if (kind == RecoveryKind.Transfer && !REGISTRY.isVerified(to, POLICY_ID)) {
            revert RecipientNotVerified(to, POLICY_ID);
        }
        recoveryId = nextRecoveryId++;
        uint40 executeAfter = uint40(block.timestamp + MIN_RECOVERY_DELAY);
        recoveryRequests[recoveryId] = RecoveryRequest({
            from: from,
            to: to,
            amount: amount,
            reasonHash: reasonHash,
            proposer: msg.sender,
            approver: address(0),
            executeAfter: executeAfter,
            kind: kind,
            executed: false
        });
        emit RecoveryProposed(recoveryId, kind, from, to, amount, reasonHash, msg.sender, executeAfter);
    }

    function approveRecovery(uint256 recoveryId) external {
        if (msg.sender != recoveryApprover) revert NotRecoveryApprover(msg.sender);
        RecoveryRequest storage request = recoveryRequests[recoveryId];
        if (request.proposer == address(0) || request.approver != address(0) || request.executed) {
            revert InvalidRecoveryRequest();
        }
        request.approver = msg.sender;
        emit RecoveryApproved(recoveryId, msg.sender, request.reasonHash);
    }

    /// @notice Executes a sealed, independently approved request after the review window.
    ///         Anyone may submit execution; authority is carried by the stored proposal/approval.
    function executeRecovery(uint256 recoveryId) external {
        RecoveryRequest storage request = recoveryRequests[recoveryId];
        if (request.proposer == address(0) || request.executed) revert InvalidRecoveryRequest();
        if (request.approver == address(0)) revert RecoveryNotApproved(recoveryId);
        if (block.timestamp < request.executeAfter) revert RecoveryDelayActive(recoveryId, request.executeAfter);
        if (request.kind == RecoveryKind.Transfer && !REGISTRY.isVerified(request.to, POLICY_ID)) {
            revert RecipientNotVerified(request.to, POLICY_ID);
        }

        request.executed = true;
        complianceBypass = true;
        if (request.kind == RecoveryKind.Transfer) _transfer(request.from, request.to, request.amount);
        else _burn(request.from, request.amount);
        complianceBypass = false;
        emit RecoveryExecuted(
            recoveryId,
            request.kind,
            request.from,
            request.to,
            request.amount,
            request.reasonHash,
            request.proposer,
            request.approver
        );
    }

    /// @dev OpenZeppelin 5.x routes mint (from == 0), burn (to == 0) and transfer through this hook.
    ///
    ///      Both sides are checked. Gate only the sender and a sanctioned wallet can still receive.
    ///
    ///      The zero address is exempt. Calling isVerified(address(0)) here would block every mint
    ///      and every burn.
    function _update(address from, address to, uint256 value) internal override {
        if (!complianceBypass && from != address(0) && !REGISTRY.isVerified(from, POLICY_ID)) {
            revert SenderNotVerified(from, POLICY_ID);
        }
        if (to != address(0) && !REGISTRY.isVerified(to, POLICY_ID)) {
            revert RecipientNotVerified(to, POLICY_ID);
        }
        super._update(from, to, value);
    }

    /// @notice Preflight check a frontend can use to disable the transfer button.
    function canTransfer(address from, address to) external view returns (bool) {
        return REGISTRY.isVerified(from, POLICY_ID) && REGISTRY.isVerified(to, POLICY_ID);
    }
}
