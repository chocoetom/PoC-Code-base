# CCpoc

**A peer-to-peer value transfer network secured by Proof-of-Capacity, with a built-in Ethereum-compatible virtual machine.**

Version 1.0

---

## Abstract

CCpoc is an independent, permissionless blockchain that secures itself with **storage space instead of raw computing power**. Miners set aside disk space in the form of plots and earn the right to forge blocks based on the effective capacity they control. The only electricity spent is what's needed to scan that space — there's no endless burning of joules to hash until you get lucky.

The whole point of that trade is **accessibility**. CCpoc is built for ordinary hardware — and, above all, for the small, low-power, and already-retired devices that other storage networks simply ignore. Where competitors demand big minimums (Chia's ~101.4 GiB `k32` plots, Storj's multi-hundred-gigabyte nodes), CCpoc lets you in starting from essentially zero capacity. A device nobody wants anymore can find a real second life here instead of becoming e-waste.

On top of that same network sits a complete **Ethereum-compatible virtual machine**. Anyone can deploy and run Solidity smart contracts, hold the network's native currency (CC), and use decentralized applications — all on a chain secured by proof-of-capacity, not proof-of-work.

CC starts from a **fair launch**: the total supply begins at zero, grows only through block rewards across recurring halvings, and creeps toward a hard cap. There's no pre-mine, no founder stash, no investor allocation.

---

## 1. Introduction

Digital payment systems and decentralized networks almost always secure themselves the same way, with proof-of-work: to win the right to extend the ledger you grind away computationally until one of your hashes lands below a target. It works, but it comes with real costs:

- **It eats electricity.** Security is bought one joule at a time. The bigger the network, the more power it burns continuously.
- **It rewards the well-funded.** The fast way to mine is to build expensive, specialized hardware, which puts the power in the hands of whoever can afford it.
- **It produces e-waste and heat.** Dedicated mining rigs have a short useful life and leave a long footprint behind.

Proof-of-capacity (PoC) takes a different route: instead of "work," it asks for "storage you've already set aside." A miner prepares a plot once, a large file of pseudorandom data, and then, for every new block, only checks a sliver of it against the challenge. The cost of keeping the network safe becomes the opportunity cost of the occupied disk plus the modest energy to scan it, not a continuous burn of electricity.

### 1.1 The problem of high entry minimums and e-waste

CCpoc exists for one specific reason: the leading storage networks set **entry minimums that lock the low end of the hardware market out**:

- **Chia** requires proofs of space in plots of at least `k32` = **≈ 101.4 GiB**. To participate, you have to pledge over 100 GB of disk per plot.
- **Storj** and similar storage-service networks want nodes in the **hundreds of gigabytes** (a common floor is 400 GB or more), plus uptime and bandwidth commitments that a small device just can't meet.

Those thresholds quietly leave out the small, low-power, already-decommissioned hardware filling ordinary homes and e-waste streams: an old laptop's humble internal drive, a used mini-board with a disk bolted on, a retired little SSD. Each year these devices get thrown away not because they're broken, but because modern software has outgrown them — and, in the case of the storage networks, because they fall below a capacity gate. The result is a steadily growing pile of **electronic waste** whose computing and storage are perfectly fine for light, steady work.

CCpoc deliberately has **no such floor**:

- A scoop is a **32-byte unit**, and capacity is welcome starting from essentially **zero**. The smallest tier kicks in the moment a plot holds even a single scoop's worth of space. There's no mandatory `k`-size plot and no "you must own this much disk" requirement for joining.
- Because effective capacity is rooted and tiered (Section 3.4), even a genuinely tiny plot earns a real share of rewards — modest, sure, but real, and proportional to what the device can honestly offer.

That's the heart of the project: turn devices that would otherwise be scrapped into **working members** of a permissionless ledger. Old and modest hardware gets a useful second life, the e-waste tide slows down a little — and in return you get a usable, working chain. You generate a plot once, and the same space keeps serving the network for years. Storage is cheap, everyday hardware, so the door is wide open and the mining base can be broad and personal rather than a handful of giants.

Building a blockchain on proofs of space is, admittedly, trickier to get right than one on proofs of work. You have to be careful about how a challenge is derived, how a winner is chosen, how rewards are split, and how everyone reaches agreement — otherwise you end up vulnerable to grinding, monopolies, and a single winner walking away with everything. The rest of this document walks through how CCpoc answers those questions: a challenge chain drawn from the block history, a capacity-based difficulty target, tiered effective capacity to push back against concentration, and a reward scheme that pays out across many miners in a single block.

---

## 2. Transactions

A transaction is the fundamental unit of value transfer. As in Ethereum-style systems, an account is an address derived from a public key on the secp256k1 curve, and each transaction carries:

- **To / from** — who's sending and who's receiving.
- **Value** — how much CC moves.
- **Nonce** — a per-account counter that keeps transactions in order and blocks replay attacks.
- **Gas parameters** — every transaction consumes gas proportional to the work it does; gas is bought at a price (paid in CC), and a simple transfer costs 21,000 gas.
- **Signature** — the sender signs with their private key. Because the signatures are recoverable (ECDSA over secp256k1, encoded as `v, r, s`), the sender's address can be pulled straight from the signature — no separate key registry needed — and any node can verify both who sent it and that it was authorized.

A block holds an ordered list of transactions. Before any transaction is applied, it's checked against the current state: the sender must exist, must have enough balance to cover the value plus the fee, and the nonce must match the expected next one. On acceptance, the sender is debited, the recipient is credited, and the fee is collected. Those changes update the account state, and a root commitment of that state goes into the block header (Section 5).

---

## 3. Consensus — Proof-of-Capacity

CCpoc secures its ledger with proof-of-capacity: miners prove they've set aside a real, measurable amount of disk space in exchange for the right to forge blocks.

### 3.1 Plots and scoops

To join, a miner first generates a **plot**: a file of pseudorandom 32-byte units called *scoops*, organized into *nonces* of 8,192 scoops each. Generating a plot is a one-time, parallelizable write that fills the reserved space with data derived from the miner's keys. After that the plot sits still: it can be rescanned against every new challenge without ever being regenerated.

The number of scoops in a plot is simply how many 32-byte units it holds:

```
scoops(plot) = floor(size_bytes / 32)
```

The amount of space a miner commits to the network is their advertised capacity, in gigabytes.

### 3.2 Challenge and deadline

The network doesn't hand out random challenges; it derives them deterministically from the chain's own history, so nobody controls when a challenge comes or what it looks like.

1. From the block at the head of the chain, the network computes a **generation signature** (`genSig`).
2. The challenge identifier is `challenge_id = sha256(genSig ‖ tip_hash)`.
3. A **target scoop index** is derived from `sha256(genSig)` modulo the scoop modulus.
4. Every miner reads the target scoop at that index and hashes it against the generation signature to get a *quality*:

```
quality = sha256(scoop_data ‖ genSig)      # first 8 bytes, big-endian
deadline = quality ÷ base_target
```

The **deadline** is the expected number of seconds before the winner would be revealed if the challenge carried on. It's clamped to a fixed interval. The miner with the **lowest deadline** for the current challenge gets to forge the next block.

Because the challenge comes from the chain itself and the target scoop is a hash of the generation signature, no miner can predict or nudge the challenge in advance. There's no way to grind a favorable one into existence.

### 3.3 Difficulty and capacity targeting

`base_target` is what turns raw deadline numbers into a predictable rate of blocks. It's derived from the network's total *effective* capacity and the target block time:

```
denominator      = total_effective_capacity × 8,192 × 240
base_target      = 2^64 ÷ denominator
```

The relationship between capacity and `base_target` is **linearly inverse**: doubling the network's effective capacity halves `base_target`, which stretches expected deadlines and pulls the realized block time back toward the **240-second** target. Difficulty is re-adjusted over a window of 8,192 blocks, and the target is floored so the chain never stalls.

### 3.4 Effective capacity and tiers

Disk space doesn't translate into forging power one-for-one, on purpose. A plain linear mapping would let one very large miner take over the network. CCpoc converts raw capacity into *effective* capacity with a sub-linear curve combined with tiers:

| Tier | Raw size (GB) | Name | Effective-capacity multiplier |
|---|---|---|---|
| 1 | 0 – 32 | drawer | × 1.0 |
| 2 | 32 – 500 | small | × 1.6 |
| 3 | 500 – 5,000 | medium | × 2.4 |
| 4 | 5,000 – 10,000 | large | × 3.2 |
| 5 | > 10,000 | capped | size capped at 10,000 GB, × 3.2 |

```
effective_capacity = sqrt(capped_size) × tier_multiplier
```

Two things follow:

- **Diminishing returns.** Because capacity is square-rooted, doubling your storage less than doubles your effective power. Small miners aren't priced out, and the network shrugs off concentration.
- **A hard ceiling.** A dedicated cap binds effective capacity, so no single actor can corner an arbitrarily large fraction of the network by filling endless disk. The top tier reuses the biggest multiplier but freezes the size term. It's a fixed effective capacity no matter how much is actually stored above the cap.

### 3.5 Reward distribution across multiple miners

Most proof-of-capacity and proof-of-work designs hand the entire block reward to one winner. CCpoc deliberately does something different: the reward for each block is **shared across that block's miners**, by tier.

| Tier | Share of block reward |
|---|---|
| tier_1 (drawer) | 8% |
| tier_2 (small) | 12% |
| tier_3 (medium) | 20% |
| tier_4 (large) | 25% |
| tier_5 (capped) | 35% |

How it works:

1. The block reward is split among the tiers that hold valid proof submissions for that challenge, in proportion to the shares above.
2. Within each tier, that tier's share is divided among its valid submissions.
3. The miner whose deadline won the challenge, the block's **forger**, takes a **winner share of 70%** of their own tier's portion. The remaining 30% of that tier's portion is shared among the other valid miners on the same tier.

The point is explicit: holding a big chunk of storage does **not** translate into a big, unbounded cut of rewards. The effective-capacity cap, the fixed tier shares, and the intratier split all push rewards toward decentralization and keep a single large operator from hoarding emission.

### 3.6 Finalization

As with any longest-chain protocol, safety comes down to accumulated confirmations. A block is considered finalized once it's buried under a fixed number of confirmations (a depth of 30 blocks). Reorganizations roll back through a path that recomputes account balances and contract state from stored history, so switching to a heavier sibling chain always restores a consistent state.

---

## 4. Network

The network is a peer-to-peer mesh of nodes that pass around blocks, transactions, challenges, and proofs.

- Nodes connect over WebSocket and keep a bounded set of peers, with fail and ban thresholds to kick out troublemakers.
- New transactions and freshly forged blocks get broadcast; a node that realizes it missed a block asks for it.
- Periodic heartbeat and discovery keep the membership warm, and let nodes join or leave freely.
- A node accepts a block only if it validates against the current state. Nodes vote with their storage by working to extend the head they believe in, and a heavier (higher-work) chain replaces a lighter one.

Nodes expose two interfaces:

- a **REST API** for observability and administration, and
- an **Ethereum JSON-RPC** surface (`eth_sendRawTransaction`, `eth_call`, `eth_getBalance`, `eth_getTransactionByHash`, `eth_getBlockByNumber`/`ByHash`, `eth_getStorageAt`, `eth_getCode`, `eth_chainId`, and others), so existing Ethereum wallets and tooling can talk to the network without learning anything new.

---

## 5. Smart contracts and the EVM

CCpoc embeds a complete Ethereum virtual machine (EthereumJS, at the Shanghai hard-fork) and runs contracts compiled with Solidity (solc 0.8.28).

### 5.1 Capabilities

- The full opcode set through Shanghai, including `PUSH0`, `CREATE2`, and `EXTCODEHASH`.
- The standard precompiles: `ecrecover`, `sha256`, `ripemd160`, `identity`, `modexp`, BN254 (add/mul/pairing), and `blake2f`.
- Persistent per-address contract storage.
- `CREATE`/`CREATE2` so contracts can deploy other contracts.
- Contract events/logs emitted during execution.
- **Native CC** as the value token — contracts can receive and transfer CC.

### 5.2 State commitment and verifiability

Each block commits to the outcome of execution. Two Merkle roots go into the header:

- a **transactions root** over the transaction hashes, and
- a **state root** over the full account state (every address, balance, and nonce, plus contract storage).

Every node re-executes the transactions and recomputes these roots when it receives a block; if they don't match the committed values, the block is rejected. Execution is therefore **deterministic, public, and verifiable by everyone**. And because of those Merkle commitments, you can prove a transaction or piece of account state without replaying history — the roots enable inclusion proofs.

### 5.3 Native contracts

The network ships reference contracts: a **hash-time-locked contract** for atomic swaps between parties, a **liquidity pool** for trading between CC and tokens, an **order-book market**, and token templates — a decentralized-finance stack living directly on the chain.

---

## 6. Incentives and token economics

### 6.1 Emission

CC issues through block rewards in a **fair launch**: the supply starts at zero, and nothing is pre-allocated to founders, investors, or a treasury. Every CC that exists was mined.

- **Initial reward: 1.65 CC per block.**
- **Halving interval:** every 6,300,000 blocks (≈ 47.9 years at the 240 s target block time), the reward halves by integer division.

```
reward(n) = 1.65 ÷ (2 ^ floor(n / 6,300,000))
```

Because the reward halves geometrically, the total supply settled by this policy converges to roughly **20.79 million CC** (`1.65 × 6,300,000 × 2`), a bit below the 21 million figure often quoted as the cap. The 21 million cap is best read as an **asymptotic, rounded ceiling** in the spirit of Bitcoin's 21 million: emissions creep toward it across successive halvings but never quite reach it under the current parameters.

### 6.2 Fee market

CC is the network's money. A simple transfer costs intrinsic gas, and contracts burn gas in proportion to their computation and storage. Gas is priced at the network's minimum gas price, and total gas per block is bounded by a target and a hard maximum. That gives predictable block capacity and a base fee for settlement.

### 6.3 Why the reward is shared

The multi-miner reward (Section 3.5) is a deliberate incentive choice: it spreads rewards more evenly and makes forging worthwhile for a broad set of small miners. It reinforces the decentralization the storage model is meant to deliver, instead of dumping emission into whoever happens to win each block.

---

## 7. Security

### 7.1 Signatures and authenticity

- **Accounts** derive from secp256k1 public keys.
- **Transactions and blocks** are authenticated by recoverable ECDSA signatures. Because a signature reveals the public key, a verifier needs no external key registry — authenticity is self-contained.
- Block signatures are recoverable too, so anyone can tie a block header to its forger without trusting a central directory.

### 7.2 Consensus security

- **Double-spend prevention.** Per-account nonces plus balance validation in every block make it impossible to spend the same coin twice within a consistent view of the chain.
- **Grinding resistance.** Challenges come from the unforgeable chain history (Section 3.2), so a miner can't shop for a favorable challenge.
- **Concentration resistance.** Effective capacity is sub-linear and capped (Section 3.4), and rewards are spread across tiers (Section 3.5), which shrinks the payoff of hoarding outsized capacity.
- **Finalization.** Confirmations at depth give a reorg-safe horizon (Section 3.6).

### 7.3 Storage as a lived resource

Security ultimately rests on the share of total effective capacity controlled by honest miners. Because capacity is root-capped, reaching a majority means controlling an outsized fraction of the network's committed space — costly and, by design, subject to diminishing returns.

---

## 8. Privacy

CCpoc offers pseudonymity, much like other account-based chains. Addresses don't have to be tied to real-world identities, and anyone can mint a fresh key pair offline. Transactions themselves are public on the ledger, so the model is one of pseudonymous addresses and transparent balances, not confidentiality. Value flows are visible to anyone; whether those flows connect to a real person is up to each user to control.

---

## 9. Conclusion

CCpoc brings two ideas together on one permissionless network. By securing the chain with proof-of-capacity, it makes mining accessible to everyday storage and slashes the electricity footprint of consensus compared with proof-of-work. By embedding a full Ethereum-compatible virtual machine, it makes that storage-secured ledger immediately useful for smart contracts, token issuance, and decentralized applications, with native CC as the network's currency.

Its design choices — challenge derivation from the chain, capacity-based difficulty, tiered and capped effective capacity, and multi-miner reward distribution — all point at a single goal: a decentralized, low-energy, programmable value network that ordinary people can secure with hardware they already own.

---

*This document describes the CCpoc protocol as intended. Parameters and mechanisms may evolve in future versions.*
