// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CreditUnion
 * @notice Decentralized member-governed lending pool. Members deposit ETH, vote on
 *         loan requests using a sqrt(deposit)*log2(tenure) weight formula, earn yield
 *         from interest, and absorb losses from defaults proportionally via share
 *         accounting.  Loans are tiered (Trust / Standard / Secured) and require
 *         on-chain collateral commensurate with risk.
 *
 * Share accounting
 * ----------------
 *   First depositor : shares = depositAmount  (1 : 1 wei)
 *   Subsequent      : shares = depositAmount * totalShares / totalPoolETH
 *   Interest repaid → totalPoolETH increases  → existing shares appreciate
 *   Default bounty  → totalPoolETH decreases  → existing shares depreciate
 *   Collateral seized at default → added to totalPoolETH before bad-debt calc
 *
 * Voting weight (integer approximation)
 * ----------------------------------------
 *   weight = sqrt(depositAmount_wei) * bitLength(months_as_member + 1)
 *
 *   sqrt  : Babylonian method, applied directly to wei value.
 *           0.01 ETH = 1e16 wei → sqrt = 1e8  (non-zero at minimum deposit)
 *
 *   log2  : floor(log2(n)) implemented as unrolled MSB lookup (O(1), no loops).
 *           bitLength(months + 1) — new members (<1 month) have weight = 0,
 *           preventing flash-deposit governance attacks.
 *
 * Loan tiers
 * ----------
 *   Trust    (Tier 0) : amount ≤ 2% pool  AND duration ≤ 30 days → 15% base collateral
 *   Standard (Tier 1) : amount ≤ 10% pool AND duration ≤ 90 days → 40% base collateral
 *   Secured  (Tier 2) : everything else                           → 75% base collateral
 *
 *   Base collateral is then adjusted dynamically by loan-to-pool size
 *   (size premium) and borrower stake (skin-in-the-game discount).
 *
 *   Trust tier requires: no prior default AND
 *   (≥1 prior successful repayment OR membership ≥ 30 days).
 *
 * Loan lifecycle
 * --------------
 *   requestLoan → (3-day vote window) → finalizeLoan → activateLoan (borrower
 *   locks collateral within 7 days) → repay [partial ok] → Repaid / triggerDefault
 */
contract CreditUnion is ReentrancyGuard {

    // ─────────────────────────────────────────────
    //  Enums
    // ─────────────────────────────────────────────

    enum LoanStatus { Pending, Approved, Rejected, Active, Repaid, Defaulted }

    /// @notice Risk tier assigned at requestLoan time; determines collateral %.
    enum LoanTier      { Trust, Standard, Secured }

    /// @notice Collateral class committed by the borrower.
    enum CollateralType { ETH, NFT }

    /// @notice Parameter types that can be changed through a governance vote.
    enum GovParamType  { MaxLoanSize, MinInterestRate, KeeperBountyRate, Unpause, TransferTreasurer }

    /// @notice Lifecycle status of a governance proposal.
    enum GovStatus     { Pending, Approved, Rejected, Executed, Vetoed }

    // ─────────────────────────────────────────────
    //  Structs
    // ─────────────────────────────────────────────

    struct Member {
        uint256 depositAmount;   // current ETH value of remaining shares (wei); recalculated to pool value on addDeposit and withdraw
        uint256 joinTimestamp;   // block.timestamp at first deposit
        uint256 shares;          // pool shares currently held
        bool    exists;
    }

    struct LoanRequest {
        uint256    id;
        address    borrower;
        uint256    amount;                      // principal in wei
        uint256    interestRate;                // basis points (500 = 5 %)
        uint256    duration;                    // repayment window in seconds
        uint256    votesFor;                    // final yes-weight stored at finalizeLoan
        uint256    voteDeadline;                // block.timestamp + VOTE_WINDOW
        uint256    totalVotingWeightSnapshot;   // total weight at finalizeLoan time
        LoanStatus status;
        LoanTier   tier;
        uint256    approvalTimestamp;           // set by finalizeLoan if approved
        uint256    thresholdRate;              // dynamic min rate computed at requestLoan
        uint256    thresholdCollateral;        // dynamic min collateral computed at requestLoan
        uint256    collateralOffered;          // what borrower committed to lock
        uint256    approvalThresholdBps;       // approval difficulty, used by finalizeLoan
        CollateralType collateralType;
        uint256    collateralEthValue;         // Trusted demo NFT valuation; 0 for ETH collateral
        string     nftId;                      // Demo NFT identifier; empty for ETH collateral
        address    guarantor;                  // Proposed/approved guarantor for under-100% ETH loans
        bool       requiresGuarantor;
        bool       guarantorApproved;
        uint256    guaranteeRequired;          // ETH-value shortfall to 100% principal collateral
    }

    struct ActiveLoan {
        uint256    requestId;
        address    borrower;
        uint256    principal;
        uint256    interest;            // simple interest due in total
        uint256    totalDue;            // principal + interest
        uint256    amountRepaid;        // cumulative repayments
        uint256    repaymentDeadline;   // block.timestamp at activateLoan + duration
        bool       defaultTriggered;
        uint256    collateralLocked;    // wei locked by borrower
        LoanTier   tier;
        CollateralType collateralType;
        uint256    collateralEthValue;
        string     nftId;
        address    guarantor;
        bool       requiresGuarantor;
        uint256    guaranteeLocked;    // current locked ETH-value; zero after repayment/default
        uint256    guaranteeAmount;    // original ETH-value locked at activation for history/views
    }

    struct GovernanceProposal {
        uint256      id;
        GovParamType paramType;
        uint256      newValue;                    // for TransferTreasurer: uint256(uint160(newAddr))
        uint256      votesFor;
        uint256      voteDeadline;
        uint256      totalVotingWeightSnapshot;
        uint256      timelockExpiry;              // 0 until approved; then block.timestamp + GOVERNANCE_TIMELOCK
        GovStatus    status;
    }

    // ─────────────────────────────────────────────
    //  Constants
    // ─────────────────────────────────────────────

    uint256 public constant MIN_DEPOSIT       = 0.01 ether;
    uint256 public constant VOTE_WINDOW       = 3 days;
    uint256 public constant ACTIVATION_WINDOW = 7 days;   // borrower must activate within 7 days of approval
    uint256 public constant RESERVE_RATIO_BPS = 1_000;    // 10 % reserve of total deposits ever
    uint256 public constant MAX_BOUNTY_BPS    = 200;      // 2 % hard cap on keeper bounty
    uint256 public constant BPS_DENOMINATOR   = 10_000;
    uint256 public constant MAX_LOAN_PCT      = 20;       // 20 % of pool per loan
    uint256 public constant MAX_LOAN_DURATION    = 365 days * 10;  // overflow guard
    uint256 public constant GOVERNANCE_TIMELOCK  = 2 days;         // delay between vote approval and execution
    uint256 public constant MAX_MEMBERS          = 500;             // bounds the O(N) voting-weight snapshot loop

    // Collateral rates per tier (in bps)
    uint256 private constant COLLATERAL_TRUST    = 1_500;  // 15 %
    uint256 private constant COLLATERAL_STANDARD = 4_000;  // 40 %
    uint256 private constant COLLATERAL_SECURED  = 7_500;  // 75 %

    // Boost threshold: offering ≥130% of a threshold dimension gets an approval boost
    uint256 private constant BOOST_THRESHOLD_BPS = 13_000;   // 130%

    // Approval thresholds (bps of total weight; higher = harder to approve)
    uint256 private constant APPROVAL_SHORT_BPS  = 5_000;    // ≤30 days  → 50%
    uint256 private constant APPROVAL_MED_BPS    = 5_500;    // 31–90 days → 55%
    uint256 private constant APPROVAL_LONG_BPS   = 6_000;    // >90 days  → 60%
    uint256 private constant APPROVAL_BOOST_BPS  = 1_000;    // -10% per boost dimension
    uint256 private constant APPROVAL_FLOOR_BPS  = 3_500;    // never below 35%

    // Tier thresholds (bps of pool)
    uint256 private constant TRUST_POOL_BPS    = 200;   // 2 %
    uint256 private constant STANDARD_POOL_BPS = 1_000; // 10 %

    // Tier duration thresholds
    uint256 private constant TRUST_MAX_DURATION    = 30 days;
    uint256 private constant STANDARD_MAX_DURATION = 90 days;

    // ─────────────────────────────────────────────
    //  State — Roles & Config
    // ─────────────────────────────────────────────

    address public treasurer;
    bool    public paused;
    uint256 public pausedAt;   // block.timestamp when the last emergency pause was triggered

    uint256 public maxLoanSize;       // absolute cap in wei
    uint256 public minInterestRate;   // minimum rate in bps
    uint256 public keeperBountyRate;  // current bounty rate in bps (≤ MAX_BOUNTY_BPS)

    // ─────────────────────────────────────────────
    //  State — Pool Accounting
    // ─────────────────────────────────────────────

    uint256 public totalPoolETH;       // ETH physically in this contract right now
    uint256 public totalShares;        // total issued shares (wei scale, 1:1 first deposit)
    uint256 public totalDepositsEver;  // monotonically increasing sum of all deposit amounts

    // ─────────────────────────────────────────────
    //  State — Members
    // ─────────────────────────────────────────────

    mapping(address => Member) public members;
    address[] public memberList;   // used only for voting-weight snapshot in requestLoan
    uint256   public memberCount;

    // ─────────────────────────────────────────────
    //  State — Loans
    // ─────────────────────────────────────────────

    uint256 public loanCounter;   // starts at 1; 0 is the null sentinel

    mapping(uint256 => LoanRequest)                public loanRequests;
    mapping(uint256 => ActiveLoan)                 public activeLoans;
    mapping(uint256 => mapping(address => bool))   public hasVoted;
    mapping(uint256 => mapping(address => bool))   public loanVoteSupport;  // requestId => voter => support
    mapping(uint256 => address[])                  private loanVoterList;   // requestId => ordered voter list
    mapping(address => uint256)                    public activeLoanIdOf;   // 0 = no active loan

    // ─────────────────────────────────────────────
    //  State — Collateral & Reputation
    // ─────────────────────────────────────────────

    mapping(uint256 => uint256) public collateralHeld;         // loanId → wei locked
    mapping(address => uint256) public lockedGuarantorValueEth; // guarantor → ETH-value backing active loans
    mapping(address => bool)    public hasDefaulted;           // ever defaulted
    mapping(address => uint256) public successfulRepayments;   // count of fully repaid loans
    mapping(address => uint256) public totalDefaulted;         // cumulative bad debt in wei

    // ─────────────────────────────────────────────
    //  State — Governance
    // ─────────────────────────────────────────────

    uint256 public govCounter;
    mapping(uint256 => GovernanceProposal)           public govProposals;
    mapping(uint256 => mapping(address => bool))     public hasVotedOnGov;
    mapping(uint256 => mapping(address => bool))     public govVoteSupport;  // proposalId => voter => support
    mapping(uint256 => address[])                    private govVoterList;   // proposalId => ordered voter list

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event MemberJoined(address indexed member, uint256 depositAmount, uint256 sharesIssued);
    event DepositAdded(address indexed member, uint256 amount, uint256 sharesIssued);
    event Withdrawn(address indexed member, uint256 sharesRedeemed, uint256 ethReturned);
    event LoanRequested(uint256 indexed id, address indexed borrower, uint256 amount, LoanTier tier, uint256 collateralRequired);
    event GuaranteeApproved(uint256 indexed requestId, address indexed guarantor, uint256 guaranteeRequired);
    event GuaranteeUnlocked(uint256 indexed loanId, address indexed guarantor, uint256 guaranteeValue);
    event GuarantorSharesSeized(uint256 indexed loanId, address indexed guarantor, uint256 sharesBurned, uint256 valueCovered);
    event VoteCast(uint256 indexed requestId, address indexed voter, bool support, uint256 weight);
    event LoanApproved(uint256 indexed id, address indexed borrower, uint256 amount);
    event LoanRejected(uint256 indexed id);
    event LoanActivated(uint256 indexed id, address indexed borrower, uint256 collateralLocked);
    event LoanRepaid(uint256 indexed id, uint256 amount, bool fullRepayment);
    event CollateralReturned(uint256 indexed id, address indexed borrower, uint256 amount);
    event DefaultTriggered(uint256 indexed id, address indexed keeper, uint256 bounty, uint256 badDebt);
    event PoolLossSocialized(uint256 lossAmount, uint256 newTotalPoolETH);
    event EmergencyPaused(address indexed by);
    event EmergencyUnpaused(address indexed by);
    event GovernanceProposed(uint256 indexed id, GovParamType paramType, uint256 newValue);
    event GovernanceVoteCast(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event GovernanceFinalized(uint256 indexed id, bool approved);
    event GovernanceExecuted(uint256 indexed id, GovParamType paramType, uint256 newValue);
    event GovernanceVetoed(uint256 indexed id);

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }

    modifier onlyTreasurer() {
        require(msg.sender == treasurer, "Not treasurer");
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    constructor(address _treasurer) {
        require(_treasurer != address(0), "Zero treasurer");
        treasurer        = _treasurer;
        maxLoanSize      = 100 ether;
        minInterestRate  = 800;   // 8 %
        keeperBountyRate = 100;   // 1 %
    }

    // ─────────────────────────────────────────────
    //  Member management
    // ─────────────────────────────────────────────

    /**
     * @notice Join the credit union by making the initial deposit.
     *         Shares are minted 1:1 if the pool is empty, or proportionally otherwise.
     */
    function join() external payable nonReentrant whenNotPaused {
        require(!members[msg.sender].exists, "Already a member");
        require(msg.value >= MIN_DEPOSIT, "Below minimum deposit");
        require(memberCount < MAX_MEMBERS, "Member cap reached");

        uint256 shares = _computeShares(msg.value);

        members[msg.sender] = Member({
            depositAmount : msg.value,
            joinTimestamp : block.timestamp,
            shares        : shares,
            exists        : true
        });
        memberList.push(msg.sender);
        memberCount++;

        totalShares      += shares;
        totalPoolETH     += msg.value;
        totalDepositsEver += msg.value;

        emit MemberJoined(msg.sender, msg.value, shares);
    }

    /**
     * @notice Add more ETH to an existing membership position.
     */
    function addDeposit() external payable nonReentrant whenNotPaused {
        require(members[msg.sender].exists, "Not a member");
        require(msg.value >= MIN_DEPOSIT, "Below minimum deposit");

        uint256 shares = _computeShares(msg.value);

        members[msg.sender].shares += shares;

        totalShares       += shares;
        totalPoolETH      += msg.value;
        totalDepositsEver += msg.value;

        // Recalculate depositAmount from current pool value so voting weight reflects
        // the member's true economic stake (including any interest earned since joining).
        members[msg.sender].depositAmount =
            (members[msg.sender].shares * totalPoolETH) / totalShares;

        emit DepositAdded(msg.sender, msg.value, shares);
    }

    /**
     * @notice Redeem shares for ETH.  Cannot withdraw while a loan is active.
     * @param shareAmount Number of shares to burn.
     */
    function withdraw(uint256 shareAmount) external nonReentrant whenNotPaused {
        require(members[msg.sender].exists, "Not a member");
        require(activeLoanIdOf[msg.sender] == 0, "Active loan outstanding");
        require(shareAmount > 0, "Zero shares");
        require(shareAmount <= members[msg.sender].shares, "Insufficient shares");

        uint256 ethAmount = (shareAmount * totalPoolETH) / totalShares;
        require(ethAmount > 0, "Zero ETH out");
        uint256 lockedValue = lockedGuarantorValueEth[msg.sender];
        if (lockedValue > 0) {
            uint256 currentValue = (members[msg.sender].shares * totalPoolETH) / totalShares;
            require(currentValue >= ethAmount + lockedValue, "Shares locked as loan guarantee");
        }

        _checkReserve(totalPoolETH - ethAmount);

        // CEI: update state before transfer
        members[msg.sender].shares -= shareAmount;
        // Recompute depositAmount proportionally to remaining shares
        if (members[msg.sender].shares == 0) {
            members[msg.sender].depositAmount = 0;
        } else {
            members[msg.sender].depositAmount =
                (members[msg.sender].shares * totalPoolETH) / totalShares;
        }
        totalShares  -= shareAmount;
        totalPoolETH -= ethAmount;

        (bool ok,) = msg.sender.call{value: ethAmount}("");
        require(ok, "ETH transfer failed");

        emit Withdrawn(msg.sender, shareAmount, ethAmount);
    }

    /**
     * @notice Return a member's current ETH value in the pool.
     */
    function getMemberValue(address addr) external view returns (uint256) {
        if (totalShares == 0) return 0;
        return (members[addr].shares * totalPoolETH) / totalShares;
    }

    // ─────────────────────────────────────────────
    //  Loan lifecycle
    // ─────────────────────────────────────────────

    /**
     * @notice Submit a loan request.  Tier and collateral thresholds are determined
     *         automatically based on pool risk parameters.
     * @param amount             Principal in wei.
     * @param interestRate       Rate in basis points (e.g. 800 = 8 %).
     * @param duration           Repayment window in seconds.
     * @param collateralOffered  ETH collateral the borrower commits to lock at activation.
     * @param collateralType     ETH or trusted demo NFT collateral.
     * @param collateralEthValue Trusted demo NFT valuation in wei; 0 for ETH collateral.
     * @param nftId              Trusted demo NFT identifier; empty for ETH collateral.
     * @param proposedGuarantor  Guarantor nominated for under-100% ETH loans.
     */
    function requestLoan(
        uint256 amount,
        uint256 interestRate,
        uint256 duration,
        uint256 collateralOffered,
        CollateralType collateralType,
        uint256 collateralEthValue,
        string calldata nftId,
        address proposedGuarantor
    ) external nonReentrant whenNotPaused {
        require(members[msg.sender].exists,  "Not a member");
        require(activeLoanIdOf[msg.sender] == 0, "Active loan outstanding");
        require(amount > 0,                  "Zero amount");
        require(amount <= maxLoanSize,        "Exceeds max loan size");
        require(totalPoolETH > 0,            "Empty pool");
        require(amount <= totalPoolETH * MAX_LOAN_PCT / 100, "Exceeds 20% pool cap");
        require(duration > 0 && duration <= MAX_LOAN_DURATION, "Invalid duration");

        // Reserve check: ensure pool stays above 10% of cumulative deposits after disbursement
        _checkReserve(totalPoolETH - amount);

        LoanTier tier = _determineTier(amount, duration);

        // Compute dynamic risk thresholds
        (uint256 threshRate, uint256 threshCollat) = _computeThresholds(msg.sender, amount, duration, tier);

        require(interestRate >= threshRate, "Rate below risk threshold");

        uint256 storedThresholdCollateral = threshCollat;
        bool requiresGuarantor = false;
        bool guarantorApproved = false;
        uint256 guaranteeRequired = 0;
        address guarantor = address(0);

        if (collateralType == CollateralType.ETH) {
            require(collateralEthValue == 0, "ETH collateral value must be zero");
            require(bytes(nftId).length == 0, "ETH loan cannot include NFT");
            require(collateralOffered >= threshCollat, "Collateral below risk threshold");

            if (collateralOffered < amount) {
                requiresGuarantor = true;
                guaranteeRequired = amount - collateralOffered;
                guarantor = proposedGuarantor;
                _validateGuarantor(msg.sender, guarantor, guaranteeRequired);
            } else {
                require(proposedGuarantor == address(0), "Guarantor not needed");
            }
        } else {
            require(collateralOffered == 0, "NFT loan cannot lock ETH collateral");
            require(proposedGuarantor == address(0), "NFT loan cannot use guarantor");
            require(bytes(nftId).length > 0, "Missing NFT id");
            storedThresholdCollateral = threshCollat + amount;
            require(collateralEthValue >= storedThresholdCollateral, "NFT valuation too low for loan tier");
        }

        // Trust tier eligibility
        if (tier == LoanTier.Trust) {
            require(!hasDefaulted[msg.sender], "Prior default disqualifies Trust tier");
            require(
                successfulRepayments[msg.sender] >= 1 ||
                block.timestamp >= members[msg.sender].joinTimestamp + 30 days,
                "Not yet eligible for Trust tier"
            );
        }

        // Compute approval threshold based on duration and boost dimensions
        uint256 approvalThreshBps;
        if (duration > 90 days) {
            approvalThreshBps = APPROVAL_LONG_BPS;
        } else if (duration > 30 days) {
            approvalThreshBps = APPROVAL_MED_BPS;
        } else {
            approvalThreshBps = APPROVAL_SHORT_BPS;
        }

        // Subtract boost for generous rate or collateral offerings
        if (interestRate >= threshRate * BOOST_THRESHOLD_BPS / BPS_DENOMINATOR) {
            if (approvalThreshBps > APPROVAL_BOOST_BPS) approvalThreshBps -= APPROVAL_BOOST_BPS;
            else approvalThreshBps = 0;
        }
        uint256 boostCollateralValue = collateralType == CollateralType.NFT ? collateralEthValue : collateralOffered;
        if (boostCollateralValue >= storedThresholdCollateral * BOOST_THRESHOLD_BPS / BPS_DENOMINATOR) {
            if (approvalThreshBps > APPROVAL_BOOST_BPS) approvalThreshBps -= APPROVAL_BOOST_BPS;
            else approvalThreshBps = 0;
        }
        if (approvalThreshBps < APPROVAL_FLOOR_BPS) approvalThreshBps = APPROVAL_FLOOR_BPS;

        // Snapshot total voting weight across all current members, EXCLUDING the
        // borrower — the borrower cannot vote on their own loan, so counting their
        // weight in the denominator would treat them as a forced "no" against
        // themselves. O(N) loop, bounded by member count.
        uint256 snapshot = _computeTotalVotingWeight();
        uint256 borrowerWeight = computeVotingWeight(msg.sender);
        snapshot = snapshot > borrowerWeight ? snapshot - borrowerWeight : 0;
        require(snapshot > 0, "No eligible voting weight");

        loanCounter++;
        uint256 id = loanCounter;

        loanRequests[id] = LoanRequest({
            id                       : id,
            borrower                 : msg.sender,
            amount                   : amount,
            interestRate             : interestRate,
            duration                 : duration,
            votesFor                 : 0,
            voteDeadline             : block.timestamp + VOTE_WINDOW,
            totalVotingWeightSnapshot: snapshot,
            status                   : LoanStatus.Pending,
            tier                     : tier,
            approvalTimestamp        : 0,
            thresholdRate            : threshRate,
            thresholdCollateral      : storedThresholdCollateral,
            collateralOffered        : collateralOffered,
            approvalThresholdBps     : approvalThreshBps,
            collateralType           : collateralType,
            collateralEthValue       : collateralEthValue,
            nftId                    : nftId,
            guarantor                : guarantor,
            requiresGuarantor        : requiresGuarantor,
            guarantorApproved        : guarantorApproved,
            guaranteeRequired        : guaranteeRequired
        });

        emit LoanRequested(id, msg.sender, amount, tier, storedThresholdCollateral);
    }

    /**
     * @notice Approve a guarantee nomination for an under-100% ETH loan.
     *         Must be called by the nominated guarantor during the loan vote window.
     */
    function approveGuarantee(uint256 requestId) external nonReentrant whenNotPaused {
        LoanRequest storage req = loanRequests[requestId];
        require(req.status == LoanStatus.Pending, "Not pending");
        require(block.timestamp < req.voteDeadline, "Guarantee approval closed");
        require(req.requiresGuarantor, "Guarantee not required");
        require(msg.sender == req.guarantor, "Not proposed guarantor");
        _validateGuarantor(req.borrower, msg.sender, req.guaranteeRequired);
        req.guarantorApproved = true;
        emit GuaranteeApproved(requestId, msg.sender, req.guaranteeRequired);
    }

    /**
     * @notice Cast a vote on a pending loan request.
     * @param requestId Loan request ID.
     * @param support   True = vote for, false = vote against.
     */
    function vote(uint256 requestId, bool support) external nonReentrant whenNotPaused {
        LoanRequest storage req = loanRequests[requestId];
        require(req.status == LoanStatus.Pending, "Not pending");
        require(block.timestamp < req.voteDeadline, "Voting closed");
        require(members[msg.sender].exists, "Not a member");
        require(msg.sender != req.borrower, "Borrower cannot vote");
        require(!hasVoted[requestId][msg.sender], "Already voted");

        uint256 weight = computeVotingWeight(msg.sender);
        require(weight > 0, "No voting weight yet");

        hasVoted[requestId][msg.sender]      = true;
        loanVoteSupport[requestId][msg.sender] = support;
        loanVoterList[requestId].push(msg.sender);

        emit VoteCast(requestId, msg.sender, support, weight);
    }

    /**
     * @notice Finalize a loan request after the vote deadline.
     *         Approval requires votesFor > duration-based threshold (50/55/60%) of the
     *         eligible voting weight, where the borrower's weight is excluded from the
     *         denominator. Abstentions by other members still count against.
     * @param requestId Loan request ID.
     */
    function finalizeLoan(uint256 requestId) external nonReentrant {
        LoanRequest storage req = loanRequests[requestId];
        require(req.status == LoanStatus.Pending, "Not pending");
        require(block.timestamp >= req.voteDeadline, "Voting still open");

        // Dynamic recompute: walk the voter list and weight each voter at their
        // *current* deposit + tenure rather than the weight they had when they cast.
        // Borrower is excluded from the denominator (they cannot vote on their own loan).
        uint256 currentTotal = _computeTotalVotingWeight();
        uint256 borrowerWeight = computeVotingWeight(req.borrower);
        currentTotal = currentTotal > borrowerWeight ? currentTotal - borrowerWeight : 0;
        require(currentTotal > 0, "No eligible voting weight");
        uint256 dynVotesFor;
        address[] storage voters = loanVoterList[requestId];
        for (uint256 i = 0; i < voters.length; i++) {
            if (loanVoteSupport[requestId][voters[i]]) {
                dynVotesFor += computeVotingWeight(voters[i]);
            }
        }

        req.votesFor                  = dynVotesFor;
        req.totalVotingWeightSnapshot = currentTotal;

        if (req.requiresGuarantor && !req.guarantorApproved) {
            req.status = LoanStatus.Rejected;
            emit LoanRejected(requestId);
            return;
        }

        if (dynVotesFor * BPS_DENOMINATOR > currentTotal * req.approvalThresholdBps) {
            req.status            = LoanStatus.Approved;
            req.approvalTimestamp = block.timestamp;
            emit LoanApproved(requestId, req.borrower, req.amount);
        } else {
            req.status = LoanStatus.Rejected;
            emit LoanRejected(requestId);
        }
    }

    /**
     * @notice Borrower activates an approved loan by locking the required collateral.
     *         Must be called within ACTIVATION_WINDOW (7 days) of approval.
     *         Transfers principal ETH to the borrower.
     * @param requestId Approved loan request ID.
     */
    function activateLoan(uint256 requestId) external payable nonReentrant whenNotPaused {
        LoanRequest storage req = loanRequests[requestId];
        require(req.status == LoanStatus.Approved, "Not approved");
        require(msg.sender == req.borrower, "Not borrower");
        require(activeLoanIdOf[msg.sender] == 0, "Active loan outstanding");

        // Expire if activation window has passed
        if (block.timestamp > req.approvalTimestamp + ACTIVATION_WINDOW) {
            req.status = LoanStatus.Rejected;
            // Refund any accidentally sent ETH
            if (msg.value > 0) {
                (bool refundOk,) = msg.sender.call{value: msg.value}("");
                require(refundOk, "Refund failed");
            }
            emit LoanRejected(requestId);
            return;
        }

        // Re-check pool constraints first (pool may have changed since requestLoan)
        require(req.amount <= totalPoolETH * MAX_LOAN_PCT / 100, "Exceeds pool cap now");
        _checkReserve(totalPoolETH - req.amount);

        // Re-evaluate tier based on current pool state — only escalate, never de-escalate.
        // The pool may have shrunk since requestLoan, raising the loan into a riskier tier.
        LoanTier currentTier = _determineTier(req.amount, req.duration);
        LoanTier activeTier  = currentTier > req.tier ? currentTier : req.tier;

        // If tier escalated, compute new threshold; borrower must cover the higher of
        // their original commitment vs the escalated threshold.
        (, uint256 currentThreshCollat) = _computeThresholds(req.borrower, req.amount, req.duration, activeTier);
        uint256 requiredCollateral;
        uint256 guaranteeToLock;
        if (req.collateralType == CollateralType.ETH) {
            requiredCollateral = req.collateralOffered > currentThreshCollat
                ? req.collateralOffered
                : currentThreshCollat;
            require(msg.value == requiredCollateral, "Wrong collateral amount");

            guaranteeToLock = req.requiresGuarantor && requiredCollateral < req.amount
                ? req.amount - requiredCollateral
                : 0;
            if (guaranteeToLock > 0) {
                require(req.guarantorApproved, "Guarantee not approved");
                _validateGuarantor(req.borrower, req.guarantor, guaranteeToLock);
                lockedGuarantorValueEth[req.guarantor] += guaranteeToLock;
            }
        } else {
            requiredCollateral = currentThreshCollat + req.amount;
            require(req.collateralEthValue >= requiredCollateral, "NFT valuation too low for loan tier");
            require(msg.value == 0, "NFT loan does not accept ETH collateral");
        }

        // Simple interest: principal * rate * duration / (365 days * BPS_DENOMINATOR)
        uint256 interest = (req.amount * req.interestRate * req.duration) /
                           (365 days * BPS_DENOMINATOR);
        require(interest > 0, "Loan too small or duration too short to accrue interest");

        activeLoans[requestId] = ActiveLoan({
            requestId        : requestId,
            borrower         : req.borrower,
            principal        : req.amount,
            interest         : interest,
            totalDue         : req.amount + interest,
            amountRepaid     : 0,
            repaymentDeadline: block.timestamp + req.duration,
            defaultTriggered : false,
            collateralLocked : msg.value,
            tier             : activeTier,
            collateralType   : req.collateralType,
            collateralEthValue: req.collateralEthValue,
            nftId            : req.nftId,
            guarantor        : req.guarantor,
            requiresGuarantor: req.requiresGuarantor,
            guaranteeLocked  : guaranteeToLock,
            guaranteeAmount  : guaranteeToLock
        });

        req.status = LoanStatus.Active;
        activeLoanIdOf[req.borrower] = requestId;

        // Lock collateral and record it — do NOT add to pool (it's the borrower's money)
        collateralHeld[requestId] = msg.value;

        // CEI: deduct principal before transfer
        totalPoolETH -= req.amount;

        (bool ok,) = req.borrower.call{value: req.amount}("");
        require(ok, "Disbursement failed");

        emit LoanActivated(requestId, req.borrower, msg.value);
    }

    /**
     * @notice Repay part or all of an active loan.  Partial repayments are accepted.
     *         Callable even when paused.
     * @param loanId Active loan ID (= the original request ID).
     */
    function repay(uint256 loanId) external payable nonReentrant {
        ActiveLoan storage loan = activeLoans[loanId];
        require(loan.borrower == msg.sender, "Not borrower");
        require(!loan.defaultTriggered, "Loan defaulted");
        require(loan.amountRepaid < loan.totalDue, "Already fully repaid");
        require(msg.value > 0, "Zero payment");

        uint256 remaining = loan.totalDue - loan.amountRepaid;
        require(msg.value <= remaining, "Overpayment");

        // CEI: update state before any external calls
        loan.amountRepaid += msg.value;
        totalPoolETH      += msg.value;   // ETH re-enters pool; shares appreciate as interest accrues

        bool fullRepayment = (loan.amountRepaid >= loan.totalDue);

        if (fullRepayment) {
            loanRequests[loanId].status = LoanStatus.Repaid;
            activeLoanIdOf[msg.sender]  = 0;
            successfulRepayments[msg.sender]++;

            if (loan.guaranteeLocked > 0) {
                _unlockGuarantee(loanId, loan.guarantor, loan.guaranteeLocked);
                loan.guaranteeLocked = 0;
            }

            uint256 collateral = collateralHeld[loanId];
            if (collateral > 0) {
                collateralHeld[loanId] = 0;
                (bool colOk,) = msg.sender.call{value: collateral}("");
                require(colOk, "Collateral return failed");
                emit CollateralReturned(loanId, msg.sender, collateral);
            }
        }

        emit LoanRepaid(loanId, msg.value, fullRepayment);
    }

    /**
     * @notice Trigger a default on an overdue loan.  Callable by anyone; the caller
     *         receives a keeper bounty from the pool.  Callable even when paused.
     * @param loanId Overdue active loan ID.
     */
    function triggerDefault(uint256 loanId) external payable nonReentrant {
        ActiveLoan storage loan = activeLoans[loanId];
        require(!loan.defaultTriggered, "Already defaulted");
        require(block.timestamp > loan.repaymentDeadline, "Not overdue");
        require(loan.amountRepaid < loan.totalDue, "Already fully repaid");

        uint256 grossBadDebt = loan.totalDue - loan.amountRepaid;

        uint256 recoveredValue = loan.collateralType == CollateralType.NFT
            ? loan.collateralEthValue
            : collateralHeld[loanId];
        if (loan.collateralType == CollateralType.NFT) {
            require(msg.value == recoveredValue, "Wrong NFT liquidation value");
        } else {
            require(msg.value == 0, "ETH default does not accept value");
        }

        uint256 remainingBadDebt = _applyRecoveredCollateral(loan.borrower, recoveredValue, grossBadDebt);

        if (collateralHeld[loanId] > 0) {
            collateralHeld[loanId] = 0;
        }

        if (remainingBadDebt > 0 && loan.guaranteeLocked > 0) {
            uint256 coveredByGuarantor = _seizeGuarantorShares(
                loanId,
                loan.guarantor,
                remainingBadDebt,
                loan.guaranteeLocked
            );
            remainingBadDebt -= coveredByGuarantor;
            loan.guaranteeLocked = 0;
        } else if (loan.guaranteeLocked > 0) {
            _unlockGuarantee(loanId, loan.guarantor, loan.guaranteeLocked);
            loan.guaranteeLocked = 0;
        }

        // Keeper bounty: the lesser of (bountyRate % of bad debt) and (MAX_BOUNTY_BPS % of principal)
        uint256 bounty = (grossBadDebt * keeperBountyRate) / BPS_DENOMINATOR;
        uint256 maxBounty = (loan.principal * MAX_BOUNTY_BPS) / BPS_DENOMINATOR;
        if (bounty > maxBounty) bounty = maxBounty;
        if (bounty > totalPoolETH) bounty = totalPoolETH;

        // CEI: update all state before external call
        loan.defaultTriggered = true;
        loanRequests[loanId].status   = LoanStatus.Defaulted;
        activeLoanIdOf[loan.borrower] = 0;

        hasDefaulted[loan.borrower]   = true;
        totalDefaulted[loan.borrower] += grossBadDebt;

        uint256 poolAfterBounty = totalPoolETH - bounty;
        totalPoolETH = poolAfterBounty;

        if (bounty > 0) {
            (bool ok,) = msg.sender.call{value: bounty}("");
            require(ok, "Bounty transfer failed");
        }

        emit DefaultTriggered(loanId, msg.sender, bounty, grossBadDebt);
        emit PoolLossSocialized(remainingBadDebt + bounty, totalPoolETH);
    }

    // ─────────────────────────────────────────────
    //  Treasurer — emergency pause only
    // ─────────────────────────────────────────────

    /**
     * @notice Immediately pause the contract for emergency use.
     *         Unpausing requires a governance proposal voted on by members.
     */
    function emergencyPause() external onlyTreasurer {
        require(!paused, "Already paused");
        paused   = true;
        pausedAt = block.timestamp;
        emit EmergencyPaused(msg.sender);
    }

    /**
     * @notice Failsafe unilateral unpause for a true governance deadlock: usable only
     *         when the contract has been paused for ≥30 days AND the total member voting
     *         weight is zero (no member has enough tenure to vote, so a proposal cannot
     *         pass).  Under normal circumstances unpausing must go through a governance
     *         vote (GovParamType.Unpause).
     */
    function emergencyUnpause() external onlyTreasurer {
        require(paused, "Not paused");
        require(block.timestamp >= pausedAt + 30 days, "Must be paused for 30+ days");
        require(_computeTotalVotingWeight() == 0, "Governance still operable");
        paused = false;
        emit EmergencyUnpaused(msg.sender);
    }

    // ─────────────────────────────────────────────
    //  Governance — member-voted parameter changes
    // ─────────────────────────────────────────────

    /**
     * @notice Treasurer proposes a parameter change. Members vote using the same
     *         weighted formula as loan votes. If approved, the change is queued
     *         behind a 2-day timelock before anyone can execute it.
     *         Callable even when paused so the treasurer can propose Unpause.
     * @param paramType The parameter to change.
     * @param newValue  New value. For TransferTreasurer pass uint256(uint160(newAddress)).
     */
    function proposeChange(GovParamType paramType, uint256 newValue)
        external onlyTreasurer returns (uint256)
    {
        if (paramType == GovParamType.KeeperBountyRate) {
            require(newValue <= MAX_BOUNTY_BPS, "Exceeds 2% cap");
        }
        if (paramType == GovParamType.TransferTreasurer) {
            require(address(uint160(newValue)) != address(0), "Zero address");
        }
        if (paramType == GovParamType.Unpause) {
            require(paused, "Not currently paused");
        }

        uint256 snapshot = _computeTotalVotingWeight();
        require(snapshot > 0, "No voting weight in pool");

        govCounter++;
        uint256 id = govCounter;

        govProposals[id] = GovernanceProposal({
            id                       : id,
            paramType                : paramType,
            newValue                 : newValue,
            votesFor                 : 0,
            voteDeadline             : block.timestamp + VOTE_WINDOW,
            totalVotingWeightSnapshot: snapshot,
            timelockExpiry           : 0,
            status                   : GovStatus.Pending
        });

        emit GovernanceProposed(id, paramType, newValue);
        return id;
    }

    /**
     * @notice Cast a weighted vote on a governance proposal.
     *         Uses the same sqrt(deposit)×log2(tenure) formula as loan votes.
     *         Callable even when paused to allow voting on Unpause proposals.
     */
    function voteOnProposal(uint256 proposalId, bool support) external {
        GovernanceProposal storage p = govProposals[proposalId];
        require(p.status == GovStatus.Pending, "Not pending");
        require(block.timestamp < p.voteDeadline, "Voting closed");
        require(members[msg.sender].exists, "Not a member");
        require(!hasVotedOnGov[proposalId][msg.sender], "Already voted");

        uint256 weight = computeVotingWeight(msg.sender);
        require(weight > 0, "No voting weight yet");

        hasVotedOnGov[proposalId][msg.sender]      = true;
        govVoteSupport[proposalId][msg.sender]     = support;
        govVoterList[proposalId].push(msg.sender);

        emit GovernanceVoteCast(proposalId, msg.sender, support, weight);
    }

    /**
     * @notice Finalize a governance proposal after its 3-day vote window.
     *         Approval sets a 2-day timelock; rejection closes the proposal.
     *         Callable even when paused.
     */
    function finalizeProposal(uint256 proposalId) external {
        GovernanceProposal storage p = govProposals[proposalId];
        require(p.status == GovStatus.Pending, "Not pending");
        require(block.timestamp >= p.voteDeadline, "Voting still open");

        uint256 currentTotal = _computeTotalVotingWeight();
        uint256 dynVotesFor;
        address[] storage voters = govVoterList[proposalId];
        for (uint256 i = 0; i < voters.length; i++) {
            if (govVoteSupport[proposalId][voters[i]]) {
                dynVotesFor += computeVotingWeight(voters[i]);
            }
        }

        p.votesFor                  = dynVotesFor;
        p.totalVotingWeightSnapshot = currentTotal;

        if (dynVotesFor * 2 > currentTotal) {
            p.status         = GovStatus.Approved;
            p.timelockExpiry = block.timestamp + GOVERNANCE_TIMELOCK;
            emit GovernanceFinalized(proposalId, true);
        } else {
            p.status = GovStatus.Rejected;
            emit GovernanceFinalized(proposalId, false);
        }
    }

    /**
     * @notice Execute an approved governance proposal once the 2-day timelock has elapsed.
     *         Callable by anyone. Callable even when paused (needed to execute Unpause).
     */
    function executeProposal(uint256 proposalId) external {
        GovernanceProposal storage p = govProposals[proposalId];
        require(p.status == GovStatus.Approved, "Not approved");
        require(block.timestamp >= p.timelockExpiry, "Timelock not expired");

        p.status = GovStatus.Executed;

        if (p.paramType == GovParamType.MaxLoanSize) {
            maxLoanSize = p.newValue;
        } else if (p.paramType == GovParamType.MinInterestRate) {
            minInterestRate = p.newValue;
        } else if (p.paramType == GovParamType.KeeperBountyRate) {
            keeperBountyRate = p.newValue;
        } else if (p.paramType == GovParamType.Unpause) {
            paused = false;
        } else if (p.paramType == GovParamType.TransferTreasurer) {
            treasurer = address(uint160(p.newValue));
        }

        emit GovernanceExecuted(proposalId, p.paramType, p.newValue);
    }

    /**
     * @notice Treasurer can withdraw a pending proposal before voting closes.
     *         Cannot veto once votes have been cast and the window has closed —
     *         members' decision is final.
     */
    function vetoProposal(uint256 proposalId) external onlyTreasurer {
        GovernanceProposal storage p = govProposals[proposalId];
        require(p.status == GovStatus.Pending, "Can only veto pending proposals");
        require(block.timestamp < p.voteDeadline, "Voting already closed");
        p.status = GovStatus.Vetoed;
        emit GovernanceVetoed(proposalId);
    }

    /**
     * @notice Return a governance proposal by ID.
     */
    function getGovProposal(uint256 id) external view returns (GovernanceProposal memory) {
        return govProposals[id];
    }

    // ─────────────────────────────────────────────
    //  View helpers
    // ─────────────────────────────────────────────

    function getPool() external view returns (
        uint256 _totalPoolETH,
        uint256 _totalShares,
        uint256 _memberCount,
        uint256 _loanCount
    ) {
        return (totalPoolETH, totalShares, memberCount, loanCounter);
    }

    function getLoanRequest(uint256 id) external view returns (LoanRequest memory) {
        return loanRequests[id];
    }

    function getActiveLoan(uint256 id) external view returns (ActiveLoan memory) {
        return activeLoans[id];
    }

    /**
     * @notice Compute voting weight for a member.
     * @dev    weight = sqrt(depositAmount_wei) * floor_log2(months + 1)
     *         New members (<1 month) return 0 — intentional flash-vote prevention.
     */
    function computeVotingWeight(address addr) public view returns (uint256) {
        Member storage m = members[addr];
        if (!m.exists || m.depositAmount == 0) return 0;

        uint256 sqrtPart = _sqrt(m.depositAmount);

        // months_as_member uses 30-day approximation
        uint256 secondsIn = block.timestamp - m.joinTimestamp;
        uint256 months    = secondsIn / 30 days;

        // floor(log2(months + 1)) — 0 for month 0, 1 for months 1–3, 2 for 4–7, …
        uint256 log2Part  = _log2(months + 1);

        return sqrtPart * log2Part;
    }

    /**
     * @notice Sum of voting weights across all current members. Useful for
     *         frontends that want to show a member's weight as a percentage
     *         of total pool voting power.
     */
    function getTotalVotingWeight() external view returns (uint256) {
        return _computeTotalVotingWeight();
    }

    /**
     * @notice Determine the loan tier for a given amount and duration.
     */
    function determineTier(uint256 amount, uint256 duration) public view returns (LoanTier) {
        return _determineTier(amount, duration);
    }

    /**
     * @notice Public view wrapper to compute dynamic risk thresholds for a potential loan.
     * @param borrower  Address of the prospective borrower.
     * @param amount    Principal in wei.
     * @param duration  Repayment window in seconds.
     * @return threshRate       Minimum acceptable interest rate in bps.
     * @return threshCollateral Minimum collateral required in wei.
     */
    function computeThresholds(
        address borrower,
        uint256 amount,
        uint256 duration
    ) external view returns (uint256 threshRate, uint256 threshCollateral) {
        LoanTier tier = _determineTier(amount, duration);
        return _computeThresholds(borrower, amount, duration, tier);
    }

    /**
     * @notice Compute trusted demo NFT collateral requirement.
     *         NFTs require the normal dynamic threshold plus 100% of principal.
     */
    function computeNFTCollateralRequirement(
        address borrower,
        uint256 amount,
        uint256 duration
    ) external view returns (uint256) {
        LoanTier tier = _determineTier(amount, duration);
        (, uint256 threshCollateral) = _computeThresholds(borrower, amount, duration, tier);
        return threshCollateral + amount;
    }

    /**
     * @notice Return collateral metadata for loan cards/frontends.
     */
    function getLoanCollateralInfo(uint256 id) external view returns (
        CollateralType collateralType,
        uint256 collateralLocked,
        uint256 collateralEthValue,
        string memory nftId,
        address guarantor,
        bool requiresGuarantor,
        bool guarantorApproved,
        uint256 guaranteeValue
    ) {
        LoanRequest storage req = loanRequests[id];
        ActiveLoan storage loan = activeLoans[id];
        bool activeLike = loan.borrower != address(0);
        return (
            activeLike ? loan.collateralType : req.collateralType,
            activeLike ? loan.collateralLocked : req.collateralOffered,
            activeLike ? loan.collateralEthValue : req.collateralEthValue,
            activeLike ? loan.nftId : req.nftId,
            activeLike ? loan.guarantor : req.guarantor,
            activeLike ? loan.requiresGuarantor : req.requiresGuarantor,
            activeLike ? loan.guarantor != address(0) && (loan.guaranteeLocked > 0 || req.guarantorApproved) : req.guarantorApproved,
            activeLike ? loan.guaranteeAmount : req.guaranteeRequired
        );
    }

    /**
     * @notice Return borrower reputation data.
     */
    function getBorrowerProfile(address addr) external view returns (
        bool   _hasDefaulted,
        uint256 _successfulRepayments,
        uint256 _totalDefaulted
    ) {
        return (hasDefaulted[addr], successfulRepayments[addr], totalDefaulted[addr]);
    }

    /**
     * @notice Returns live vote totals for a loan request using each voter's
     *         current weight (deposit + tenure at the moment of the call).
     */
    function getLiveVoteTotals(uint256 requestId) external view returns (
        uint256 currentTotalWeight,
        uint256 currentVotesFor,
        uint256 currentVotesAgainst
    ) {
        currentTotalWeight = _computeTotalVotingWeight();
        address borrower = loanRequests[requestId].borrower;
        if (borrower != address(0)) {
            uint256 bw = computeVotingWeight(borrower);
            currentTotalWeight = currentTotalWeight > bw ? currentTotalWeight - bw : 0;
        }
        address[] storage voters = loanVoterList[requestId];
        for (uint256 i = 0; i < voters.length; i++) {
            address v = voters[i];
            uint256 w = computeVotingWeight(v);
            if (loanVoteSupport[requestId][v]) {
                currentVotesFor += w;
            } else {
                currentVotesAgainst += w;
            }
        }
    }

    /**
     * @notice Returns live vote totals for a governance proposal using each
     *         voter's current weight.
     */
    function getLiveGovVoteTotals(uint256 proposalId) external view returns (
        uint256 currentTotalWeight,
        uint256 currentVotesFor,
        uint256 currentVotesAgainst
    ) {
        currentTotalWeight = _computeTotalVotingWeight();
        address[] storage voters = govVoterList[proposalId];
        for (uint256 i = 0; i < voters.length; i++) {
            address v = voters[i];
            uint256 w = computeVotingWeight(v);
            if (govVoteSupport[proposalId][v]) {
                currentVotesFor += w;
            } else {
                currentVotesAgainst += w;
            }
        }
    }

    // ─────────────────────────────────────────────
    //  Internal helpers
    // ─────────────────────────────────────────────

    /**
     * @dev Compute dynamic risk thresholds for a loan request.
     *      threshRate     = minInterestRate + sizeRiskPremium + durationRiskPremium
     *      threshCollat   = tierBase + sizePremium - stakeDiscount (capped)
     */
    function _computeThresholds(
        address borrower,
        uint256 amount,
        uint256 duration,
        LoanTier tier
    ) internal view returns (uint256 threshRate, uint256 threshCollateral) {
        uint256 loanPoolBps = totalPoolETH > 0
            ? (amount * BPS_DENOMINATOR) / totalPoolETH
            : BPS_DENOMINATOR;

        // Threshold rate: base + size premium + duration premium
        uint256 sizePremium = loanPoolBps / 10;
        uint256 durPremium  = (duration * 2_000) / (365 days);
        if (durPremium > 2_000) durPremium = 2_000;
        threshRate = minInterestRate + sizePremium + durPremium;

        // Threshold collateral: tier base, adjusted for stake discount and loan-size premium
        uint256 baseCollatBps;
        if      (tier == LoanTier.Trust)    baseCollatBps = COLLATERAL_TRUST;
        else if (tier == LoanTier.Standard) baseCollatBps = COLLATERAL_STANDARD;
        else                                baseCollatBps = COLLATERAL_SECURED;

        uint256 memberVal    = totalShares > 0
            ? (members[borrower].shares * totalPoolETH) / totalShares
            : 0;
        uint256 stakePoolBps = totalPoolETH > 0
            ? (memberVal * BPS_DENOMINATOR) / totalPoolETH
            : 0;
        uint256 stakeDiscount = stakePoolBps / 4;
        uint256 maxDiscount   = baseCollatBps / 4;
        if (stakeDiscount > maxDiscount) stakeDiscount = maxDiscount;

        uint256 sizePremiumCollat = loanPoolBps / 2;
        if (sizePremiumCollat > 1_500) sizePremiumCollat = 1_500;

        uint256 effectiveBps = baseCollatBps + sizePremiumCollat - stakeDiscount;
        threshCollateral = (amount * effectiveBps) / BPS_DENOMINATOR;
    }

    function _validateGuarantor(address borrower, address guarantor, uint256 guaranteeValue) internal view {
        require(guarantor != address(0), "Guarantor required");
        require(guarantor != borrower, "Guarantor cannot be borrower");
        require(members[guarantor].exists, "Guarantor not a member");
        require(_availableGuarantorValue(guarantor) >= guaranteeValue, "Guarantor cannot cover shortfall");
    }

    function _availableGuarantorValue(address guarantor) internal view returns (uint256) {
        if (totalShares == 0) return 0;
        uint256 value = (members[guarantor].shares * totalPoolETH) / totalShares;
        uint256 locked = lockedGuarantorValueEth[guarantor];
        return value > locked ? value - locked : 0;
    }

    function _unlockGuarantee(uint256 loanId, address guarantor, uint256 guaranteeValue) internal {
        if (guarantor == address(0) || guaranteeValue == 0) return;
        uint256 locked = lockedGuarantorValueEth[guarantor];
        lockedGuarantorValueEth[guarantor] = locked > guaranteeValue ? locked - guaranteeValue : 0;
        emit GuaranteeUnlocked(loanId, guarantor, guaranteeValue);
    }

    function _seizeGuarantorShares(
        uint256 loanId,
        address guarantor,
        uint256 remainingBadDebt,
        uint256 guaranteeValue
    ) internal returns (uint256 coveredValue) {
        uint256 coverTarget = remainingBadDebt < guaranteeValue ? remainingBadDebt : guaranteeValue;
        _unlockGuarantee(loanId, guarantor, guaranteeValue);
        if (coverTarget == 0 || totalPoolETH == 0 || totalShares == 0) return 0;

        uint256 guarantorShares = members[guarantor].shares;
        uint256 sharesToBurn = (coverTarget * totalShares + totalPoolETH - 1) / totalPoolETH;
        if (sharesToBurn > guarantorShares) sharesToBurn = guarantorShares;
        if (sharesToBurn == 0) return 0;

        coveredValue = (sharesToBurn * totalPoolETH) / totalShares;
        if (coveredValue > remainingBadDebt) coveredValue = remainingBadDebt;

        members[guarantor].shares -= sharesToBurn;
        totalShares -= sharesToBurn;
        members[guarantor].depositAmount = totalShares == 0
            ? 0
            : (members[guarantor].shares * totalPoolETH) / totalShares;

        emit GuarantorSharesSeized(loanId, guarantor, sharesToBurn, coveredValue);
    }

    function _applyRecoveredCollateral(
        address borrower,
        uint256 recoveredValue,
        uint256 grossBadDebt
    ) internal returns (uint256 remainingBadDebt) {
        uint256 lossCover = recoveredValue > grossBadDebt ? grossBadDebt : recoveredValue;
        uint256 excess    = recoveredValue > grossBadDebt ? recoveredValue - grossBadDebt : 0;

        if (recoveredValue > 0) {
            totalPoolETH += lossCover;

            if (excess > 0) {
                uint256 defShares = members[borrower].shares;
                // Only burn if defaulter holds shares AND non-defaulters exist; otherwise
                // there's no one to redirect the benefit to, so just add the excess plainly.
                if (defShares > 0 && totalShares > defShares && totalPoolETH > 0) {
                    uint256 nonDef = totalShares - defShares;
                    uint256 numerator   = defShares * totalPoolETH * nonDef;
                    uint256 denominator = totalPoolETH * nonDef + totalShares * excess;
                    uint256 newDefShares = numerator / denominator;
                    uint256 sharesBurned = defShares - newDefShares;
                    members[borrower].shares = newDefShares;
                    totalShares -= sharesBurned;
                    members[borrower].depositAmount = totalShares == 0
                        ? 0
                        : (members[borrower].shares * totalPoolETH) / totalShares;
                }
                totalPoolETH += excess;
            }
        }

        remainingBadDebt = grossBadDebt > recoveredValue ? grossBadDebt - recoveredValue : 0;
    }

    /**
     * @dev Compute shares to mint for a given ETH deposit using the current pool ratio.
     *      If the pool is empty (first depositor), shares are minted 1:1 in wei.
     */
    function _computeShares(uint256 ethAmount) internal view returns (uint256) {
        if (totalShares == 0 || totalPoolETH == 0) {
            return ethAmount;
        }
        return (ethAmount * totalShares) / totalPoolETH;
    }

    /**
     * @dev Revert if the pool would fall below the 10% reserve of total cumulative deposits.
     * @param afterDeduction totalPoolETH after the proposed outflow.
     */
    function _checkReserve(uint256 afterDeduction) internal view {
        require(
            afterDeduction * BPS_DENOMINATOR >= totalDepositsEver * RESERVE_RATIO_BPS,
            "Would breach 10% reserve"
        );
    }

    /**
     * @dev Determine the risk tier based on amount vs pool size and duration.
     */
    function _determineTier(uint256 amount, uint256 duration) internal view returns (LoanTier) {
        if (totalPoolETH > 0) {
            bool smallAmount   = amount * BPS_DENOMINATOR <= totalPoolETH * TRUST_POOL_BPS;
            bool shortDuration = duration <= TRUST_MAX_DURATION;
            if (smallAmount && shortDuration) return LoanTier.Trust;

            bool medAmount   = amount * BPS_DENOMINATOR <= totalPoolETH * STANDARD_POOL_BPS;
            bool medDuration = duration <= STANDARD_MAX_DURATION;
            if (medAmount && medDuration) return LoanTier.Standard;
        }
        return LoanTier.Secured;
    }

    /**
     * @dev Sum voting weights across all current members.
     *      O(N) in member count — called from requestLoan, finalizeLoan, finalizeProposal,
     *      emergencyUnpause, and the getLive*Totals view helpers.
     */
    function _computeTotalVotingWeight() internal view returns (uint256 total) {
        uint256 len = memberList.length;
        for (uint256 i = 0; i < len; i++) {
            total += computeVotingWeight(memberList[i]);
        }
    }

    // ─────────────────────────────────────────────
    //  Math helpers
    // ─────────────────────────────────────────────

    /**
     * @dev Babylonian square root.  Converges in ≤ 16 iterations for uint256.
     *      Applied directly to wei values:
     *        0.01 ETH = 1e16 wei → sqrt ≈ 1e8  (non-zero at MIN_DEPOSIT)
     *        1 ETH    = 1e18 wei → sqrt ≈ 1e9
     */
    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /**
     * @dev Unrolled floor(log2(n)) using MSB lookup.  O(1), no loops.
     *      Returns 0 for n == 0 and n == 1.
     */
    function _log2(uint256 n) internal pure returns (uint256 r) {
        if (n == 0) return 0;
        if (n >= 1 << 128) { n >>= 128; r += 128; }
        if (n >= 1 <<  64) { n >>=  64; r +=  64; }
        if (n >= 1 <<  32) { n >>=  32; r +=  32; }
        if (n >= 1 <<  16) { n >>=  16; r +=  16; }
        if (n >= 1 <<   8) { n >>=   8; r +=   8; }
        if (n >= 1 <<   4) { n >>=   4; r +=   4; }
        if (n >= 1 <<   2) { n >>=   2; r +=   2; }
        if (n >= 1 <<   1) {            r +=   1; }
    }

    // ─────────────────────────────────────────────
    //  Fallback: reject accidental ETH sends
    // ─────────────────────────────────────────────

    receive()  external payable { revert("Use join() or addDeposit()"); }
    fallback() external payable { revert("Use join() or addDeposit()"); }
}
