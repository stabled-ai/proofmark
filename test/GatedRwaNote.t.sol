// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

import {ProofmarkASC} from "../src/ProofmarkASC.sol";
import {ProofmarkRegistry, RosterMark} from "../src/ProofmarkRegistry.sol";
import {RosterProof} from "../src/lib/RosterProof.sol";
import {RosterWitnessFixture} from "./RosterWitnessFixture.sol";
import {ComplianceSource} from "../src/ComplianceSource.sol";
import {GatedRwaNote} from "../src/GatedRwaNote.sol";
import {INativeQueryVerifier} from "../src/lib/VerifierInterface.sol";
import {MarkAttrs} from "../src/lib/MarkAttrs.sol";
import {Action, Policy, Methods} from "../src/lib/ProofmarkTypes.sol";
import {MockBlockProver} from "./mocks/MockBlockProver.sol";
import {ReceiptFixture} from "./ReceiptFixture.sol";

/// @notice Exercises the policy-gated RWA path used by the public demo.
contract GatedRwaNoteTest is Test {
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;
    uint64 constant SEPOLIA_KEY = 1;

    uint32 constant KR_VASP = Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;
    uint32 constant EU_RWA = Methods.LIVENESS | Methods.SANCTIONS_SCREENED | Methods.PEP_SCREENED;

    ProofmarkASC asc;
    ProofmarkRegistry reg;
    ComplianceSource src;
    ReceiptFixture fx;
    GatedRwaNote krNote;

    address owner = address(0xA11CE);
    address issuer = address(0x1554E4);
    address alice = address(0xA11);
    address bob = address(0xB0B);
    address mallory = address(0xBAD1);
    address recoveryApprover = address(0xC0A11);

    uint256 krPolicy;
    uint40 constant ISSUED_AT = 1_700_000_000;
    uint40 constant EXPIRY = 1_800_000_000;
    address[] subjects;
    RosterMark[] rosterMarks;

    function setUp() public {
        vm.etch(PRECOMPILE, address(new MockBlockProver()).code);
        vm.warp(ISSUED_AT + 1 days);

        fx = new ReceiptFixture();
        src = new ComplianceSource(owner);

        vm.startPrank(owner);
        src.setIssuer(issuer, true);
        src.setEpochPublisher(issuer, true);
        asc = new ProofmarkASC(owner);
        asc.configureSource(SEPOLIA_KEY, address(src));
        vm.stopPrank();

        reg = new ProofmarkRegistry(address(asc));
        krPolicy = reg.registerPolicy(
            Policy({
                requireAll: KR_VASP,
                minAssurance: 2,
                maxAge: 0,
                requiredRegime: 1,
                requiredJurisdiction: 410,
                trustedIssuer: issuer,
                requireRoster: true,
                exists: false
            })
        );
        reg.freezePolicy(krPolicy);

        krNote = new GatedRwaNote("KR Credit Note", "KRCN", address(reg), krPolicy, owner);
        vm.prank(owner);
        krNote.configureRecoveryGovernance(owner, recoveryApprover);
    }

    // Helpers

    function _issue(address subject, uint32 methods_, uint64 height, uint256 salt) internal {
        bytes32 attrs = MarkAttrs.pack(1, 3, 1, 410, methods_, ISSUED_AT, EXPIRY, 0);
        bytes32[] memory t = new bytes32[](4);
        t[0] = keccak256("MarkIssued(address,bytes32,address,bytes32,bytes32)");
        t[1] = bytes32(uint256(uint160(subject)));
        t[2] = attrs;
        t[3] = bytes32(uint256(uint160(issuer)));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = fx.log(address(src), t, abi.encode(bytes32(uint256(1)), bytes32(uint256(2))));
        _exec(uint8(Action.MarkIssued), height, fx.tx2(logs), salt);
        subjects.push(subject);
        rosterMarks.push(RosterMark(attrs, bytes32(uint256(1)), bytes32(uint256(2)), issuer));
        _refreshRoster();
    }

    function _refreshRoster() internal {
        (bytes32 root, RosterProof.Inclusion[] memory proofs) = RosterWitnessFixture.build(subjects, rosterMarks);
        _publishRoot(root);
        for (uint256 i; i < subjects.length; ++i) {
            if (!asc.tombstone(subjects[i])) reg.cacheRosterWitness(subjects[i], rosterMarks[i], proofs[i]);
        }
    }

    function _publishRoot(bytes32 root) internal {
        uint32 nextEpoch = src.lastEpoch() + 1;
        vm.recordLogs();
        vm.prank(issuer);
        src.publishEpoch(
            nextEpoch, root, 1, uint40(block.timestamp + 1 days), uint40(block.timestamp), bytes32(uint256(7))
        );
        Vm.Log[] memory recorded = vm.getRecordedLogs();
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](recorded.length);
        for (uint256 i; i < recorded.length; ++i) {
            logs[i] = fx.log(recorded[i].emitter, recorded[i].topics, recorded[i].data);
        }
        _exec(3, 1000 + uint64(src.lastEpoch()), fx.tx2(logs), 1000 + src.lastEpoch());
    }

    function _revoke(address subject, uint64 height, uint256 salt) internal {
        bytes32[] memory t = new bytes32[](4);
        t[0] = keccak256("MarkRevoked(address,uint16,uint32)");
        t[1] = bytes32(uint256(uint160(subject)));
        t[2] = bytes32(uint256(2));
        t[3] = bytes32(uint256(1));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = fx.log(address(src), t, bytes(""));
        _exec(uint8(Action.MarkRevoked), height, fx.tx2(logs), salt);
    }

    function _exec(uint8 action, uint64 height, bytes memory encTx, uint256 salt) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](0);
        bytes32[] memory roots = new bytes32[](0);
        asc.execute(action, SEPOLIA_KEY, height, encTx, bytes32(salt), sib, bytes32(0), roots);
    }

    // Demo scenes 6 and 8: the full lifecycle

    /// @dev Unverified reverts, issuance succeeds, revocation blocks again.
    ///      Exactly the `GatedRwaNote` definition of done from section 9.1.
    function test_DemoLifecycle_BlockedThenAllowedThenBlockedAgain() public {
        // 1. an unverified recipient cannot even be minted to
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, alice, krPolicy));
        krNote.mint(alice, 1000);

        // 2. once issued, minting works
        _issue(alice, KR_VASP, 100, 1);
        _issue(bob, KR_VASP, 101, 2);
        vm.prank(owner);
        krNote.mint(alice, 1000);
        assertEq(krNote.balanceOf(alice), 1000);

        // 3. verified wallets can transfer to each other
        vm.prank(alice);
        krNote.transfer(bob, 400);
        assertEq(krNote.balanceOf(bob), 400);

        // 4. after revocation the same transfer is blocked
        _revoke(alice, 200, 3);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.SenderNotVerified.selector, alice, krPolicy));
        krNote.transfer(bob, 100);

        assertEq(krNote.balanceOf(alice), 600, "balance must be untouched");
    }

    // Both sides are checked

    /// @dev Only the recipient is unverified. Gate one side and a sanctioned wallet can still receive.
    function test_BlocksTransferToUnverifiedRecipient() public {
        _issue(alice, KR_VASP, 100, 10);
        vm.prank(owner);
        krNote.mint(alice, 1000);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, mallory, krPolicy));
        krNote.transfer(mallory, 100);
    }

    /// @dev Sending to a sanctioned recipient is blocked too.
    function test_BlocksTransferToSanctionedRecipient() public {
        _issue(alice, KR_VASP, 100, 20);
        _issue(mallory, KR_VASP, 101, 21);
        vm.prank(owner);
        krNote.mint(alice, 1000);

        // mallory lands on a sanctions list
        _revoke(mallory, 200, 22);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, mallory, krPolicy));
        krNote.transfer(mallory, 100);
    }

    // Zero address exemption: mint and burn must not be blocked

    function test_BurnWorksForVerifiedHolder() public {
        _issue(alice, KR_VASP, 100, 30);
        vm.prank(owner);
        krNote.mint(alice, 1000);

        vm.prank(alice);
        krNote.burn(400); // to == address(0); isVerified(0) must not be called
        assertEq(krNote.balanceOf(alice), 600);
        assertEq(krNote.totalSupply(), 600);
    }

    // Demo scene 7: two tokens, two policies

    /// @dev The same mark passes on the KR note and is rejected on the EU note.
    ///      The portability claim is executable here, not just described.
    function test_SameMarkPassesKrNoteButFailsEuNote() public {
        uint256 euPolicy = reg.registerPolicy(
            Policy({
                requireAll: EU_RWA,
                minAssurance: 2,
                maxAge: 0,
                requiredRegime: 1, // Hypothetical consumer constraints, not an implemented EU regime.
                requiredJurisdiction: 276,
                trustedIssuer: issuer,
                requireRoster: true,
                exists: false
            })
        );
        reg.freezePolicy(euPolicy);
        GatedRwaNote euNote = new GatedRwaNote("EU RWA Note", "EURN", address(reg), euPolicy, owner);

        // issued through the Korean flow
        _issue(alice, KR_VASP, 100, 40);

        vm.prank(owner);
        krNote.mint(alice, 1000); // KR note: passes
        assertEq(krNote.balanceOf(alice), 1000);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, alice, euPolicy));
        euNote.mint(alice, 1000); // EU note: rejected
    }

    // Frontend helper

    function test_CanTransferPreview() public {
        _issue(alice, KR_VASP, 100, 50);
        assertFalse(krNote.canTransfer(alice, bob), "bob not verified yet");
        _issue(bob, KR_VASP, 101, 51);
        assertTrue(krNote.canTransfer(alice, bob));
    }

    // The policy is immutable

    function test_PolicyIdIsImmutable() public view {
        assertEq(krNote.POLICY_ID(), krPolicy);
        assertEq(address(krNote.REGISTRY()), address(reg));
    }

    function test_DeploymentRejectsMutablePolicy() public {
        uint256 mutablePolicy = reg.registerPolicy(
            Policy({
                requireAll: KR_VASP,
                minAssurance: 2,
                maxAge: 0,
                requiredRegime: 1,
                requiredJurisdiction: 410,
                trustedIssuer: issuer,
                requireRoster: false,
                exists: false
            })
        );
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.PolicyMustBeFrozen.selector, mutablePolicy));
        new GatedRwaNote("Mutable", "MUT", address(reg), mutablePolicy, owner);
    }

    function test_ApprovedDelayedRecoveryCanBurnBlockedHolder() public {
        _issue(alice, KR_VASP, 100, 60);
        vm.prank(owner);
        krNote.mint(alice, 1000);
        _revoke(alice, 200, 61);

        vm.prank(owner);
        uint256 recoveryId = krNote.proposeRecovery(
            GatedRwaNote.RecoveryKind.Burn, alice, address(0), 400, keccak256("synthetic redemption case")
        );
        vm.prank(recoveryApprover);
        krNote.approveRecovery(recoveryId);
        vm.expectRevert(
            abi.encodeWithSelector(
                GatedRwaNote.RecoveryDelayActive.selector,
                recoveryId,
                uint40(block.timestamp + krNote.MIN_RECOVERY_DELAY())
            )
        );
        krNote.executeRecovery(recoveryId);
        vm.warp(block.timestamp + krNote.MIN_RECOVERY_DELAY());
        vm.prank(mallory);
        krNote.executeRecovery(recoveryId);
        assertEq(krNote.balanceOf(alice), 600);
    }

    function test_GovernedRecoveryRechecksVerifiedRecipient() public {
        _issue(alice, KR_VASP, 100, 70);
        vm.prank(owner);
        krNote.mint(alice, 1000);
        _revoke(alice, 200, 71);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, bob, krPolicy));
        krNote.proposeRecovery(
            GatedRwaNote.RecoveryKind.Transfer, alice, bob, 100, keccak256("synthetic transfer case")
        );

        _issue(bob, KR_VASP, 300, 72);
        vm.prank(owner);
        uint256 recoveryId = krNote.proposeRecovery(
            GatedRwaNote.RecoveryKind.Transfer, alice, bob, 100, keccak256("synthetic transfer case")
        );
        vm.prank(recoveryApprover);
        krNote.approveRecovery(recoveryId);
        vm.warp(block.timestamp + krNote.MIN_RECOVERY_DELAY());
        krNote.executeRecovery(recoveryId);
        assertEq(krNote.balanceOf(bob), 100);
    }

    function test_ApprovedRecoveryCannotExecuteAfterRecipientLosesEligibility() public {
        _issue(alice, KR_VASP, 100, 76);
        _issue(bob, KR_VASP, 101, 77);
        vm.prank(owner);
        krNote.mint(alice, 1000);
        _revoke(alice, 200, 78);
        bytes32 reasonHash = keccak256("synthetic successor transfer case");
        vm.prank(owner);
        uint256 recoveryId = krNote.proposeRecovery(GatedRwaNote.RecoveryKind.Transfer, alice, bob, 100, reasonHash);
        vm.prank(recoveryApprover);
        krNote.approveRecovery(recoveryId);
        _revoke(bob, 300, 79);
        vm.warp(block.timestamp + krNote.MIN_RECOVERY_DELAY());
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, bob, krPolicy));
        krNote.executeRecovery(recoveryId);
        assertEq(krNote.balanceOf(alice), 1000);
        assertEq(krNote.balanceOf(bob), 0);

        (
            address storedFrom,
            address storedTo,
            uint256 storedAmount,
            bytes32 storedReason,
            address proposer,
            address storedApprover,,,
            bool executed
        ) = krNote.recoveryRequests(recoveryId);
        assertEq(storedFrom, alice);
        assertEq(storedTo, bob);
        assertEq(storedAmount, 100);
        assertEq(storedReason, reasonHash);
        assertEq(proposer, owner);
        assertEq(storedApprover, recoveryApprover);
        assertFalse(executed);
    }

    /// @dev T-13 counterexample: the asset owner must not be a unilateral recovery authority,
    ///      even when the eventual recipient currently passes the frozen policy.
    function test_OwnerAloneCannotForceMoveOrBurn() public {
        _issue(alice, KR_VASP, 100, 73);
        _issue(bob, KR_VASP, 101, 74);
        vm.prank(owner);
        krNote.mint(alice, 1000);
        _revoke(alice, 200, 75);

        vm.startPrank(owner);
        (bool moved,) =
            address(krNote).call(abi.encodeWithSignature("forceTransfer(address,address,uint256)", alice, bob, 100));
        (bool burned,) = address(krNote).call(abi.encodeWithSignature("forceBurn(address,uint256)", alice, 100));
        vm.stopPrank();

        assertFalse(moved, "one owner moved a blocked holder without independent approval");
        assertFalse(burned, "one owner burned a blocked holder without independent approval");
        assertEq(krNote.balanceOf(alice), 1000, "failed recovery attempts changed holder balance");
        assertEq(krNote.balanceOf(bob), 0, "failed recovery attempt changed recipient balance");
    }

    function test_FrozenDirectPolicyCannotBackANewRwaNote() public {
        uint256 direct = reg.registerPolicy(Policy(KR_VASP, 2, 0, 1, 410, issuer, false, false));
        reg.freezePolicy(direct);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.PolicyMustRequireRoster.selector, direct));
        new GatedRwaNote("Unsafe", "OLD", address(reg), direct, owner);
    }

    function test_SourceRevocationWithoutRelayAndNoPublisherStopsAssetAtCutoffDeadline() public {
        _issue(alice, KR_VASP, 100, 80);
        _issue(bob, KR_VASP, 101, 81);
        uint256 cutoff = block.timestamp;
        uint256 direct = reg.registerPolicy(Policy(KR_VASP, 2, 0, 1, 410, issuer, false, false));
        vm.prank(owner);
        krNote.mint(alice, 1000);
        uint32 epoch = src.lastEpoch();
        vm.prank(issuer);
        src.revoke(alice, 2, epoch); // source event deliberately NEVER delivered to ASC
        assertFalse(asc.tombstone(alice));
        vm.warp(cutoff + 1 days - 1);
        assertTrue(krNote.canTransfer(alice, bob), "exposure window is explicit, not instant revocation");
        vm.prank(alice);
        assertTrue(krNote.transfer(bob, 1));
        vm.warp(cutoff + 1 days);
        assertTrue(reg.isVerified(alice, direct), "old Direct issuance remains fresh by credential age only");
        assertFalse(krNote.canTransfer(alice, bob));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.SenderNotVerified.selector, alice, krPolicy));
        krNote.transfer(bob, 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, bob, krPolicy));
        krNote.mint(bob, 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GatedRwaNote.RecipientNotVerified.selector, bob, krPolicy));
        krNote.proposeRecovery(
            GatedRwaNote.RecoveryKind.Transfer, alice, bob, 1, keccak256("synthetic stale recipient case")
        );
        vm.prank(owner);
        uint256 recoveryId = krNote.proposeRecovery(
            GatedRwaNote.RecoveryKind.Burn, alice, address(0), 1, keccak256("synthetic blocked holder redemption")
        );
        vm.prank(recoveryApprover);
        krNote.approveRecovery(recoveryId);
        vm.warp(block.timestamp + krNote.MIN_RECOVERY_DELAY());
        krNote.executeRecovery(recoveryId);
    }

    function test_LateWitnessDeliveryDoesNotRenewTimeOrRewriteDirectOrigin() public {
        _issue(alice, KR_VASP, 100, 90);
        uint40 expiry = asc.epochValidUntil();
        (, RosterProof.Inclusion[] memory proofs) = RosterWitnessFixture.build(subjects, rosterMarks);
        vm.warp(expiry - 1);
        vm.prank(mallory); // anyone may deliver a valid proof
        reg.cacheRosterWitness(alice, rosterMarks[0], proofs[0]);
        assertTrue(reg.isVerified(alice, krPolicy));
        assertEq(asc.getMark(alice).origin, 1, "Direct provenance stays Direct");
        assertEq(asc.lastAppliedHeight(alice), 100, "witness must not rewrite lifecycle ordering");
        vm.warp(expiry);
        assertFalse(reg.isVerified(alice, krPolicy));
        vm.expectRevert(ProofmarkRegistry.InvalidRosterWitness.selector);
        reg.cacheRosterWitness(alice, rosterMarks[0], proofs[0]);
    }

    function test_NewEpochInvalidatesWitnessEvenWithSameRootAndRejectsForgedReplacement() public {
        _issue(alice, KR_VASP, 100, 100);
        (bytes32 root, RosterProof.Inclusion[] memory proofs) = RosterWitnessFixture.build(subjects, rosterMarks);
        _publishRoot(root);
        assertFalse(reg.isVerified(alice, krPolicy));
        reg.cacheRosterWitness(alice, rosterMarks[0], proofs[0]);
        assertTrue(reg.isVerified(alice, krPolicy));
        RosterMark memory forged = rosterMarks[0];
        forged.issuer = mallory;
        vm.expectRevert(ProofmarkRegistry.InvalidRosterWitness.selector);
        reg.cacheRosterWitness(alice, forged, proofs[0]);
        vm.expectRevert(ProofmarkRegistry.InvalidRosterWitness.selector);
        reg.cacheRosterWitness(bob, rosterMarks[0], proofs[0]);
        (uint32 cachedEpoch, RosterMark memory cached) = reg.getRosterWitness(alice);
        assertEq(cachedEpoch, asc.latestEpoch());
        assertEq(cached.issuer, issuer);
        assertTrue(reg.isVerified(alice, krPolicy));
        // A valid empty asserted set invalidates every old witness; no prior Direct fallback.
        (root,) = RosterWitnessFixture.build(new address[](0), new RosterMark[](0));
        _publishRoot(root);
        assertFalse(reg.isVerified(alice, krPolicy));
    }

    function test_WitnessRechecksPolicyAgeAndTombstoneAtUseTime() public {
        _issue(alice, KR_VASP, 100, 110);
        uint256 strict = reg.registerPolicy(Policy(KR_VASP, 2, 1 days, 1, 410, issuer, true, false));
        assertTrue(reg.isVerified(alice, strict));
        vm.warp(block.timestamp + 1);
        assertTrue(asc.isRosterFresh());
        assertFalse(reg.isVerified(alice, strict), "credential age is separate from roster time");
        assertTrue(reg.isVerified(alice, krPolicy));
        (, RosterProof.Inclusion[] memory proofs) = RosterWitnessFixture.build(subjects, rosterMarks);
        _revoke(alice, 200, 111);
        assertFalse(reg.isVerified(alice, krPolicy));
        vm.expectRevert(ProofmarkRegistry.InvalidRosterWitness.selector);
        reg.cacheRosterWitness(alice, rosterMarks[0], proofs[0]);
    }
}
