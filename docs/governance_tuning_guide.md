# Governance Parameter Tuning Guide

This guide provides best practices for configuring governance parameters in the SolarProof Community Governance contract. Choosing the right parameters is critical for balancing security, agility, and community participation.

## Parameters Overview

### 1. Quorum Threshold (`QuorumBps`)
The minimum percentage of "Yes" votes required for a proposal to pass, relative to the total number of registered voters.
- **Role**: Prevents small minorities from making significant changes.
- **Default**: 1000 (10%).

### 2. Approval Threshold (`ThresholdBps`)
The percentage of cast votes that must be "Yes" for the proposal to pass (majority rule).
- **Role**: Ensures broad consensus among active voters.
- **Default**: 5100 (51%).

### 3. Voting Duration (`VotingPeriod`)
The length of time (in ledgers) that a proposal remains open for voting.
- **Role**: Balances the need for quick decisions with giving voters enough time to review and cast their votes.
- **Scale**: In Soroban (10s ledger time), 1 day ≈ 8,640 ledgers.

### 4. Execution Timelock (`ExecuteTimelock`)
The cooldown period between a proposal passing and when it can actually be executed.
- **Role**: Provides a safety window for the community to react (or exit) if a malicious or controversial proposal passes.

### 5. Minimum Balance (Proposer Requirement)
*Note: Currently enforced socially or through custom front-ends/wrappers in SolarProof.*
- **Role**: Prevents spam by requiring proposers to have a "stake" in the system (e.g., holding a minimum amount of Energy Tokens).

---

## Tuning by DAO Size

### Small DAOs (< 100 Members)
Typically highly active, closely-knit groups where communication is efficient.
- **Goal**: High agility and high participation.
- **Quorum**: High (e.g., 20-30%) because reaching a large portion of 50 people is feasible.
- **Voting Duration**: Short (3-5 days).
- **Timelock**: Minimal (24 hours).

### Medium DAOs (100 - 1000 Members)
A mix of active contributors and passive observers.
- **Goal**: Balance security with participation.
- **Quorum**: Moderate (e.g., 10-15%).
- **Voting Duration**: Moderate (7 days).
- **Timelock**: Moderate (2-3 days).

### Large DAOs (1000+ Members)
High degree of voter apathy and diverse interests.
- **Goal**: Prevent gridlock while maintaining security.
- **Quorum**: Low (e.g., 2-5%) to avoid proposals constantly failing due to lack of turnout.
- **Voting Duration**: Long (10-14 days) to ensure enough reach.
- **Timelock**: Long (7 days) for maximum security.

---

## Example Configurations

| Size | Quorum (BPS) | Threshold (BPS) | Voting Period | Timelock |
| :--- | :--- | :--- | :--- | :--- |
| **Small** | 2500 (25%) | 5100 (51%) | 25,920 ledgers (~3 days) | 8,640 ledgers (~24h) |
| **Medium** | 1000 (10%) | 5100 (51%) | 60,480 ledgers (~7 days) | 17,280 ledgers (~48h) |
| **Large** | 300 (3%) | 6000 (60%) | 120,960 ledgers (~14 days) | 60,480 ledgers (~7 days) |

---

## Tradeoffs and Best Practices

### Quorum vs. Participation
- **High Quorum**: Highly secure against hostile takeovers but risks "governance gridlock" where nothing passes due to apathy.
- **Low Quorum**: Easy to pass changes, but susceptible to "ninja voting" (small groups passing changes while others aren't looking).

### Duration vs. Agility
- **Longer Durations**: Better for complex technical changes or high-stakes financial decisions. Give the community time to discuss on social channels.
- **Shorter Durations**: Better for operational tweaks or emergency responses.

### Timelocks as a Safety Valve
Always use a timelock for protocol upgrades or large fund movements. A 48-72 hour window is generally considered the "goldilocks" zone for medium-sized DAOs, allowing enough time for an "emergency pause" or for users to withdraw their stake if they disagree with the outcome.

---

## 6. Vote Weight Parameters (issue #61)

Starting from v1.1.0, the `community_governance` contract supports
**token-balance-weighted voting**.  Every voter's influence is proportional to
their energy-token balance at the ledger when the proposal was created
(`snapshot_ledger`), capped to prevent single-voter dominance.

### How it works

1. On `propose()` the current ledger sequence is stored as `snapshot_ledger`.
2. On `vote()` the contract looks up the caller's energy-token balance at the
   `snapshot_ledger` using a cross-contract call to the registered
   `TokenContract`.
3. The raw balance is clamped to `[0, VoteWeightCap]`.
4. `yes_weight` / `no_weight` on the proposal are accumulated.
5. On `finalize()` the decision is made using weighted totals:
   `yes_weight / (yes_weight + no_weight) >= threshold_bps / 10000`.

When no `TokenContract` is configured the contract falls back to
**1-account-1-vote** (original behaviour — fully backwards compatible).

### Configuration

| Parameter | Contract method | Default | Description |
|---|---|---|---|
| `TokenContract` | `set_token_contract(admin, address)` | Not set | Energy-token contract to query for balances |
| `VoteWeightCap` | `set_vote_weight_cap(admin, cap)` | `1_000_000` | Max weight per voter (energy-token units) |

### Weight Cap Recommendations

The cap prevents a single large holder from unilaterally deciding every proposal.
Choose the cap based on your cooperative's token distribution:

| Cooperative size | Recommended cap | Rationale |
|---|---|---|
| Small (< 100 members) | `100_000` (100 kWh equivalent) | Even large producers shouldn't dominate |
| Medium (100–1000) | `500_000` (500 kWh equivalent) | Balances participation vs. stake |
| Large (1000+) | `1_000_000` (1 000 kWh equivalent) | Cap is wide — natural distribution limits concentration |

### Example: enabling weighted voting

```bash
# Via the Soroban CLI
soroban contract invoke --id $GOV_CONTRACT_ID \
  -- set_token_contract \
  --admin $ADMIN_ADDRESS \
  --token_contract $TOKEN_CONTRACT_ID

soroban contract invoke --id $GOV_CONTRACT_ID \
  -- set_vote_weight_cap \
  --admin $ADMIN_ADDRESS \
  --cap 500000
```

### Interaction with Quorum and Threshold

* **Quorum** (`QuorumBps`) is still checked against the **head count**
  (`yes_votes + no_votes`), not weighted totals.  This ensures a minimum
  number of participants regardless of their token balance.
* **Threshold** (`ThresholdBps`) is evaluated against the **weighted** totals:
  `yes_weight / (yes_weight + no_weight) >= threshold_bps / 10000`.
* Both conditions must hold for a proposal to `Pass`.

### Disabling weighted voting

Set `TokenContract` to an invalid address or simply do not call
`set_token_contract`.  The contract will use unit weight (1 per vote)
automatically.
