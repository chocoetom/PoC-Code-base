# CCpoc

**A peer-to-peer, decentralized Proof-of-Capacity network, with a native Ethereum-compatible EVM.**

Version 1.0

---

## Abstract

CCpoc is an independent, permissionless blockchain, focused on turning old hardware into something useful — mining, sustainably, for a more eco-conscious world 🌱

CCpoc is built for ordinary hardware, and specifically for small, low-power, already-retired devices that other storage networks simply ignore, or gate behind high minimums most people can't meet. CCpoc lets you start mining with *essentially zero* capacity, turning e-waste into a real crypto miner.

CCpoc isn't just another storage coin. It lets you create your own tokens and contracts through a built-in **Ethereum-compatible EVM**: anyone can deploy and run Solidity contracts, hold a native currency, and use decentralized applications — all secured by Proof-of-Capacity, without the energy and hardware intensity of Proof-of-Work.

CC starts from a **fair launch**: total supply begins at zero, grows only through block rewards across recurring halvings, and creeps toward a hard cap. No pre-mine, no founder stash, no investor allocation.

---

## 1. Why storage, not work

Most chains secure themselves by burning electricity: miners race to compute hashes until one falls below a target, and whoever gets there first wins the block. It works, but it comes with real costs — constant power draw, an arms race toward specialized ASICs that only a few can afford, and hardware that's obsolete (and often trashed) within a couple of years.

Proof-of-Capacity flips that. Instead of burning cycles, you set aside disk space — a "plot" — once, and from then on you just check a small slice of it against each new challenge. The cost of securing the network becomes the space you've already committed, plus a tiny bit of energy to read it. No arms race, no constant burn.

### 1.1 The problem with high minimums

Here's the thing: most storage-based networks still gatekeep. Chia needs at least a ~101.4 GiB `k32` plot to participate. Storj-style networks typically expect nodes provisioned in the hundreds of gigabytes to multiple terabytes, plus steady bandwidth and uptime — numbers that quietly rule out anything small, old, or intermittently connected.

That's exactly the hardware sitting unused in most households and landfills: an old laptop's internal drive, a small SBC with a spare SSD attached, a retired external drive nobody plugs in anymore. Not broken — just below the bar everyone else has set.

CCpoc doesn't set that bar. A scoop is 32 bytes, and capacity is accepted from essentially zero — no mandatory plot size, no minimum-node requirement. Because effective capacity is tiered and rooted (Section 3.4), even a genuinely tiny plot earns a real, if modest, share of rewards proportional to what the device can actually offer.

That's the whole point: give hardware that would otherwise be scrapped a second life as an active network participant, instead of adding to the pile of e-waste — while still keeping the chain properly secured. A plot is generated once and keeps earning for years. Cheap, commodity storage means a lower bar to entry and a broader, more egalitarian mining base.

Building security purely on proof-of-space takes more care than proof-of-work, though. How the challenge is derived, how a winner gets picked, how rewards are split, how consensus is reached — all of it has to resist grinding, gaming, and single-winner capture. The rest of this document walks through how CCpoc handles each of those.

---

## 2. Transactions

A transaction moves value from one account to another. Like Ethereum, an account here is just an address derived from a secp256k1 public key, and every transaction carries:

- **To / from** — sender and recipient.
- **Value** — the amount of CC being sent.
- **Nonce** — a per-account counter, ordering transactions and blocking replay.
- **Gas** — a plain transfer costs 21,000 gas intrinsic, paid in CC at whatever the current gas price is.
- **Signature** — recoverable ECDSA over secp256k1 (`v, r, s`). Because the signature itself yields the public key, any node can verify who sent it and that it's authorized, with no separate key registry needed.

Each transaction is checked against current state before it's applied: the sender needs to exist, needs enough balance to cover value plus fee, and the nonce has to match what's expected next. Once accepted, balances update and the fee is collected — and that new state gets rolled into the block's state root (Section 5).

---

## 3. Consensus — Proof-of-Capacity

### 3.1 Plots and scoops

To mine, you generate a **plot** once: a file of pseudorandom 32-byte units called scoops, grouped into nonces of 8,192 scoops each. It's a one-time, parallelizable write — after that, the plot just sits there and gets rescanned for every new challenge.

```
scoops(plot) = floor(size_bytes / 32)
```

The capacity you commit to the network is simply how many gigabytes that plot holds.

### 3.2 Challenge and deadline

Challenges aren't random — they're derived deterministically from the chain's own history, so nobody controls their timing or content:

1. From the block at the tip, the network computes a **generation signature** (`genSig`).
2. `challenge_id = sha256(genSig ‖ tip_hash)`.
3. A target scoop index is derived from `sha256(genSig)` modulo the scoop modulus.
4. For each plot, the miner reads that scoop and hashes it against `genSig` to get a **quality**:

```
quality = sha256(scoop_data ‖ genSig)      # first 8 bytes, big-endian
deadline = quality ÷ base_target
```

The **deadline** is, roughly, how many seconds it'd take for that plot to "win" the challenge — clamped to a fixed range. Lowest deadline forges the next block.

Because the challenge comes from the chain itself and the target scoop is derived from a hash nobody controls, there's no way to grind for a favorable challenge in advance.

### 3.3 Difficulty and capacity targeting

`base_target` is the dial that keeps blocks landing roughly on schedule. It's set from the network's total *effective* capacity and the target block time:

```
denominator = total_effective_capacity × 8,192 × 240
base_target = 2^64 ÷ denominator
```

The relationship is linearly inverse: double the network's effective capacity, and `base_target` halves — which pushes expected deadlines up and pulls the realized block time back toward the 240-second target. Difficulty re-adjusts every 8,192 blocks, with a floor so the chain can't stall out.

### 3.4 Effective capacity and tiers

Raw storage doesn't translate one-to-one into forging power — on purpose. A straight linear mapping would let one big miner dominate. So CCpoc runs capacity through a square-root curve, then tiers it:

| Tier | Raw size (GB) | Name | Multiplier |
|---|---|---|---|
| 1 | 0 – 32 | drawer | × 1.0 |
| 2 | 32 – 500 | small | × 1.6 |
| 3 | 500 – 5,000 | medium | × 2.4 |
| 4 | 5,000 – 10,000 | large | × 3.2 |
| 5 | > 10,000 | capped | size frozen at 10,000 GB, × 3.2 |

```
effective_capacity = sqrt(capped_size) × tier_multiplier
```

Two things fall out of this:

- **Diminishing returns.** Because it's rooted, doubling your storage doesn't double your power. Small miners aren't priced out, and the network resists concentration.
- **A hard ceiling.** Past 10 TB, effective capacity just... stops growing. The top tier reuses the tier-4 multiplier but freezes the size term, so piling on more disk past that point buys you nothing extra.

### 3.5 Reward distribution across multiple miners

Most PoC and PoW designs pay one winner, full stop. CCpoc splits it instead — the block reward is shared across that block's miners, by tier:

| Tier | Share of block reward |
|---|---|
| tier_1 (drawer) | 8% |
| tier_2 (small) | 12% |
| tier_3 (medium) | 20% |
| tier_4 (large) | 25% |
| tier_5 (capped) | 35% |

Here's how it plays out:

1. The block reward splits across tiers that had valid submissions, using the shares above.
2. Within a tier, that tier's share splits again across every valid submission in it.
3. The miner who actually won the challenge — the block's forger — takes a **70% winner share** of their own tier's portion. The remaining 30% is split among everyone else who submitted a valid proof in that same tier.

The intent is straightforward: owning a lot of storage doesn't buy you a proportionally unbounded slice of rewards. The capacity cap, fixed tier shares, and intra-tier split all push against any single big operator quietly taking over emission.

### 3.6 Finalization and reorgs

Same idea as any longest-chain protocol: safety comes from stacking confirmations. A block counts as finalized once it's buried under 30 confirmations. If a heavier sibling chain shows up, a rollback path recomputes balances and contract state from stored history so the switch lands on consistent state.

---

## 4. Network

Nodes talk to each other over WebSocket, gossiping blocks, transactions, challenges, and proofs.

- Peers connect over WebSocket, with fail/ban thresholds to eject anyone misbehaving.
- New transactions and blocks get broadcast; a node that notices it's behind just asks for what it's missing.
- Heartbeat and discovery run periodically, so nodes can join or drop freely without the network losing track.
- A block only gets accepted if it checks out against current state; nodes effectively "vote" by extending whichever tip they think is correct, and a heavier chain wins.

Two interfaces sit on top of that:

- a **REST API** for observability and admin work, and
- **Ethereum JSON-RPC** (`eth_sendRawTransaction`, `eth_call`, `eth_getBalance`, `eth_getTransactionByHash`, `eth_getBlockByNumber`/`ByHash`, `eth_getStorageAt`, `eth_getCode`, `eth_chainId`, and more), so existing Ethereum wallets and tooling just work.

---

## 5. Smart contracts and the EVM

CCpoc runs a full Ethereum virtual machine (EthereumJS, Shanghai hard-fork) and executes Solidity contracts compiled with solc 0.8.28.

### 5.1 What it supports

- The complete opcode set through Shanghai — `PUSH0`, `CREATE2`, `EXTCODEHASH` included.
- Standard precompiles: `ecrecover`, `sha256`, `ripemd160`, `identity`, `modexp`, BN254 (add/mul/pairing), `blake2f`.
- Persistent per-address contract storage.
- `CREATE`/`CREATE2`, so contracts can deploy contracts.
- Contract events/logs from execution.
- **Native CC** as the value token — contracts can hold and move it directly.

### 5.2 State commitment and verifiability

Every block commits to what execution actually produced, via two Merkle roots in the header: a **transactions root** over tx hashes, and a **state root** over the full account state — every address, balance, nonce, plus contract storage.

Every node re-executes the block's transactions and recomputes both roots independently; if they don't match what the block claims, the block gets rejected. Execution is deterministic, public, and checkable by anyone — and the same Merkle commitments let you build inclusion proofs for transactions or account state without replaying the whole chain.

### 5.3 Native contracts

The network ships a few reference contracts out of the box: a **hash-time-locked contract** for atomic swaps, a **liquidity pool** for trading CC against other tokens, an **order-book market**, and a couple of token templates — enough to stand up a basic DeFi stack directly on-chain.

---

## 6. Incentives and token economics

### 6.1 Emission

CC is minted entirely through block rewards, fair-launch style: supply starts at zero, nothing is pre-allocated to founders, investors, or a treasury. Every coin that exists came from mining.

- **Initial reward:** 1.65 CC per block.
- **Halving interval:** every 6,300,000 blocks (~47.9 years at the 240-second target block time), the reward halves by integer division.

```
reward(n) = 1.65 ÷ (2 ^ floor(n / 6,300,000))
```

Because halving is geometric, the total supply this policy settles on converges to roughly **20.79 million CC** (`1.65 × 6,300,000 × 2`) — a bit under the round 21 million figure people tend to quote. Think of 21 million the way Bitcoin's cap gets talked about: an asymptotic, rounded ceiling that emission approaches over decades of halvings, without landing on it exactly under these particular parameters.

### 6.2 Fee market

CC pays for everything on the network. A plain transfer costs its intrinsic gas; contracts cost gas proportional to what they actually compute and store. Gas is priced off the network's minimum gas price, and total gas per block is bounded by a target and a hard cap — predictable block capacity, with a base fee that adjusts to demand.

### 6.3 Why the reward gets shared

Splitting the reward across miners (Section 3.5) is a deliberate incentive choice: it rewards capacity more evenly and keeps forging profitable for lots of small miners at once, rather than handing the whole thing to whoever happens to win a given block. That's the decentralization the storage-based model is supposed to deliver, backed up by how rewards actually flow.

---

## 7. Security

### 7.1 Signatures and authenticity

- Accounts derive from secp256k1 public keys.
- Transactions and blocks are both authenticated with recoverable ECDSA signatures — the signature itself yields the public key, so no external registry is needed to verify who signed what.
- Block signatures work the same way, letting anyone bind a block to its forger without trusting a central directory.

### 7.2 Consensus security

- **Double-spend prevention** — per-account nonces plus balance checks on every block make spending the same coin twice impossible within a consistent view of the chain.
- **Grinding resistance** — challenges come from unforgeable chain history (Section 3.2), so there's no favorable challenge to fish for.
- **Concentration resistance** — effective capacity is sub-linear and capped (Section 3.4), and rewards spread across tiers (Section 3.5), which lowers the payoff of just piling on more disk.
- **Finalization** — confirmation depth gives a reorg-safe horizon (Section 3.6).

### 7.3 Storage as the thing actually securing you

At the end of the day, security comes down to how much effective capacity honest miners control. Because capacity is rooted and capped, grabbing a majority means controlling an outsized — and deliberately diminishing-return — slice of the network's committed space. Expensive by design.

---

## 8. Privacy

CCpoc's privacy model is the same pseudonymity you get on any account-based chain. Addresses don't have to be tied to a real identity, and anyone can generate a fresh key pair offline. Every transaction is public, though, so this isn't confidentiality — it's pseudonymous addresses plus fully transparent balances. Value flows are visible; who's behind the key is up to the user.

---

## 9. Reference implementation status

Everything above describes the protocol as **intended**. In the reference implementation (ChocoNode v3.6.0) reviewed alongside this document, one thing relevant to consensus security isn't finished yet:

- **The PoC proof itself isn't cryptographically re-verified on block acceptance.** Recomputing the `deadline` from scoop data, the Merkle proof, and the generation signature (Section 3.2) — the actual check that a claimed win is real — doesn't happen in the block-acceptance path today. The network currently trusts the `winner_proof` signature and whether it matches a locally-recorded submission, but doesn't independently recompute and verify the deadline.
- Blocks pulled in via REST sync currently skip signature and difficulty/target validation, and blocks already sitting in the database don't get re-checked during chain reorganizations.

None of this breaks the design in Sections 3–5 — it's implementation work that's still outstanding, and it should be treated as launch-blocking before mainnet, not a nice-to-have.

---

## 10. Conclusion

CCpoc puts two ideas in one permissionless network. Securing the chain with Proof-of-Capacity makes mining accessible on commodity storage and cuts consensus's electricity footprint way down compared to Proof-of-Work. Bundling in a full Ethereum-compatible EVM makes that storage-secured ledger immediately useful — smart contracts, tokens, dApps — with native CC running the whole thing.

Every design choice here — challenge derivation from the chain, capacity-based difficulty, tiered and capped effective capacity, reward split across many miners — points at one outcome: a decentralized, low-energy, programmable network that ordinary people can help secure with hardware they already own.

---

*This document describes the CCpoc protocol as intended. Parameters and mechanics may evolve in future versions.*
