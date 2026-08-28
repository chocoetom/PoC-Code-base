## CCPoC - a decentralized Proof-of-Capacity network, featuring a native EVM compatible with Ethereum.

Version 1.0 (alpha testnet)

Abstract
CCpoc is a self-sufficient blockchain that does not require permission and aims to utilize old devices and transform them into something useful - sustainably mining for a greener planet 🌱

CCpoc was designed specifically for regular computer devices, especially small and low-power retired devices that other available networks are ignoring or setting a high bar to use. CCpoc makes it possible to start mining with zero capacity, thus transforming excess electronic waste into a worthy crypto miner.

CCpoc isn't just another storage coin. It allows creating the project's own tokens and smart contracts thanks to its built-in EVM compatible with Ethereum: users can create and run Solidity contracts as well as hold their own coin and use decentralized applications, all secured by Proof-of-Capacity without spending the high amount of energy that Proof-of-Work requires.

CCpoc starts with a fair launch. The total supply starts at zero and gradually grows with mining and block rewards. There was no pre-mine, no stake for the founder or investors.

1. Storage is valued over work

The majority of blockchain systems secure their network by consuming electricity. Miners are engaged in calculations trying to find a hash that is below a target number, and whoever gets to it first is awarded a block. The process is repeated every few minutes. While this system works, it has its drawbacks. The less than pleasant consequences are high power consumption and constant competition for the best mining hardware — only a narrow circle of people can afford to buy it, and even if they manage to do it, they should know that in a few years the chip will be rendered useless due to the invention of a new one.

Unlike this process, Proof-of-Capacity makes things entirely different. This method requires only a one-time investment in disk space (so-called plotting) and then just checking if the required piece of information is available on the disk. The only costs involved are for the space itself and a little electricity needed for the readouts.

1.1 The problem with high minimums

The majority of storage networks still impose restrictions on participants. For example, Chia requires that plotters possess a k32 plot of no smaller than around 101.4 GiB. Storj and similar networks expect nodes to provide hundreds of gigabytes up to terabytes of storage while maintaining a steady internet connection. Requirements like these make sure that a majority of households simply cannot participate.

That's a shame, because most unused devices end up sitting in attics or in landfills instead — an old laptop, a single board computer with a small SSD attached, an old external drive that hasn't been connected to anything in years.

CCpoc doesn't place any high standards. The scoop is 32 bytes, and capacity is accepted starting from practically zero. There are no minimum plot sizes or minimum node capacities set in the protocol. Effective capacity is tiered and rooted (more in 3.4), and even a small plot gets some returns — minimal, but real, and proportional to what the device can actually offer.

So that's the basic idea: turn hardware that was supposed to be thrown away into an active network participant instead of yet another piece of e-waste, while keeping the chain secure. Generate the plot once, and let it earn for years after that. Storage is cheap, and when the threshold is low, mining becomes much more widespread.

However, this doesn't come without a cost. Consensus through proof-of-space requires significantly more care than consensus through proof-of-work. There's a lot that goes into the creation of challenges, selecting winners, splitting rewards, and reaching agreement — an error at any of those stages leaves the system open to grinding, exploitation, or capture by a single miner. The rest of this document is about how CCpoc tries to avoid those errors.

2. Transactions

A transaction is the movement of value between accounts, similar to Ethereum, where an account is derived from a secp256k1 public key. A transaction carries the sender's and receiver's addresses, the amount of value being sent, a nonce, and gas parameters — the payment for which is expected in CC.

## 3. Consensus — Proof-of-Capacity

### 3.1 Plots and scoops

Mining starts with generating a **plot**: a file of pseudorandom 32-byte units called scoops, grouped into nonces of 8,192 scoops apiece. It's a one-time write, parallelizable, and after that the plot just sits there — rescanned for every new challenge, never regenerated.

```
scoops(plot) = floor(size_bytes / 32)
```

Capacity is just however many gigabytes that plot holds.

### 3.2 Challenge and deadline

Challenges aren't random. They come deterministically out of the chain's own history so nobody gets to pick timing or content.

From the block at the tip, the network computes a generation signature (`genSig`). The challenge ID is `sha256(genSig ‖ tip_hash)`. A target scoop index falls out of `sha256(genSig)` modulo the scoop modulus, and for each plot a miner has, they read that scoop and hash it against `genSig` to get a quality value.

```
quality = sha256(scoop_data ‖ genSig)      # first 8 bytes, big-endian
deadline = quality ÷ base_target
```

The deadline is roughly how long it'd take that plot to win, clamped to a fixed range — and whoever has the lowest deadline for the current challenge gets to forge the next block. Since the challenge comes straight from unforgeable chain history and the target scoop comes from a hash nobody controls, there's nothing to grind for. You can't fish around for a favorable challenge in advance.

### 3.3 Difficulty and capacity targeting

`base_target` is what keeps blocks landing roughly on schedule, set from total effective network capacity and the target block time:

```
denominator = total_effective_capacity × 8,192 × 240
base_target = 2^64 ÷ denominator
```

It's a straightforward inverse relationship — double the effective capacity and `base_target` halves, pushing expected deadlines up and pulling the realized block time back toward 240 seconds. The window re-adjusts every 8,192 blocks, floored so the chain can't stall out entirely.

### 3.4 Effective capacity and tiers

Raw storage doesn't map one-to-one onto forging power, and that's deliberate — a straight linear mapping would let one big miner dominate everything. So capacity runs through a square-root curve first, then gets tiered on top of that:

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

Doubling your storage doesn't double your power, because the curve is rooted — small miners aren't priced out and concentration is naturally harder. And past 10 TB, effective capacity just stops climbing. The top tier reuses tier 4's multiplier but freezes the size term, so piling on more disk past that point doesn't buy anything extra.

### 3.5 Reward distribution across multiple miners

Most PoC and PoW designs pay one winner and that's it. CCpoc splits the block reward across that block's miners instead, by tier:

| Tier | Share of block reward |
|---|---|
| tier_1 (drawer) | 8% |
| tier_2 (small) | 12% |
| tier_3 (medium) | 20% |
| tier_4 (large) | 25% |
| tier_5 (capped) | 35% |

The block reward first splits across whichever tiers had valid submissions, using those shares. Inside a tier, that portion splits again across every valid submission in it. And the miner who actually won the challenge — the block's forger — takes 70% of their own tier's portion as a winner share, with the remaining 30% divided among everyone else who submitted a valid proof in that same tier.

Owning a lot of storage shouldn't buy a proportionally unbounded slice of rewards, so the capacity cap, the fixed tier shares, and the intra-tier split all push in the other direction — away from any single big operator quietly taking over emission.

### 3.6 Finalization and reorgs

Same idea as any longest-chain protocol here: safety comes from stacking confirmations on top of a block. Once it's buried under 30 confirmations, it counts as finalized. If a heavier sibling chain shows up before that, a rollback path recomputes balances and contract state from stored history so switching lands on something consistent.

---

## 4. Network

Nodes talk over WebSocket, passing around blocks, transactions, challenges, and proofs. Peers connect that way too, with fail and ban thresholds to eject anyone misbehaving. New transactions and blocks get broadcast as they happen; a node that notices it's behind just asks for what it missed. Heartbeat and discovery run in the background so nodes can come and go without the network losing track of anyone.

A block only gets accepted once it checks out against current state. Nodes effectively vote by extending whatever tip they believe is correct, and the chain with more accumulated work wins out.

On top of all that sits a REST API for observability and admin work, plus Ethereum JSON-RPC — `eth_sendRawTransaction`, `eth_call`, `eth_getBalance`, `eth_getTransactionByHash`, `eth_getBlockByNumber`/`ByHash`, `eth_getStorageAt`, `eth_getCode`, `eth_chainId`, and the rest — so existing Ethereum wallets and tooling work out of the box.

---

## 5. Smart contracts and the EVM

CCpoc runs a full Ethereum virtual machine, EthereumJS at the Shanghai hard-fork, executing Solidity contracts compiled with solc 0.8.28.

That gets you the complete opcode set through Shanghai — `PUSH0`, `CREATE2`, `EXTCODEHASH` all included — plus the standard precompiles (`ecrecover`, `sha256`, `ripemd160`, `identity`, `modexp`, BN254 add/mul/pairing, `blake2f`). Contract storage persists per address. `CREATE`/`CREATE2` let contracts deploy other contracts. Events and logs come out of execution normally, and native CC works as the value token directly — contracts can hold it and move it without any wrapper.

Every block commits to what execution actually produced. Two Merkle roots sit in the header: a transactions root over the tx hashes, and a state root over the full account state — every address, balance, nonce, plus contract storage. Every node re-executes the block's transactions on its own and recomputes both roots independently. If they don't match what the block claims, the block gets rejected, full stop. That makes execution deterministic and checkable by anyone, and the same Merkle commitments double as inclusion proofs when you need to verify a transaction or a balance without replaying the whole chain.

A handful of reference contracts ship with the network out of the box: a hash-time-locked contract for atomic swaps, a liquidity pool for trading CC against other tokens, an order-book market, and a couple of token templates. Enough to stand up a basic DeFi stack directly on-chain without waiting on anyone.

---

## 6. Incentives and token economics

CC is minted entirely through block rewards, fair-launch style — supply starts at zero, nothing pre-allocated to founders, investors, or a treasury. Every coin that will ever exist comes out of mining.

The initial reward is 1.65 CC per block, and every 6,300,000 blocks — roughly 47.9 years at the 240-second target block time — that reward halves by integer division:

```
reward(n) = 1.65 ÷ (2 ^ floor(n / 6,300,000))
```

Because halving is geometric, the total supply this policy actually settles on converges to something like 20.79 million CC (`1.65 × 6,300,000 × 2`), a bit under the round 21 million figure people tend to quote. Think of that 21 million the way people talk about Bitcoin's cap: an asymptotic, rounded ceiling that emission approaches over decades of halvings without landing on exactly, at least under these particular parameters.

CC is also what pays for everything on the network day to day. A plain transfer costs its intrinsic gas, contracts cost gas proportional to what they actually compute and store, and gas gets priced off the network's minimum with a base fee that adjusts as demand shifts — predictable block capacity, bounded by both a target and a hard cap.

And the reward-splitting from Section 3.5 isn't an afterthought — it's the whole incentive design. Spreading it across miners keeps forging profitable for a much broader set of small operators than handing the entire thing to whoever happens to win a given block, which is really the point of building on storage in the first place.

---

## 7. Security

Accounts derive from secp256k1 public keys. Transactions and blocks both get authenticated with recoverable ECDSA signatures, which means the public key comes straight out of the signature — no external registry required to check who signed what, block signatures included. Anyone can bind a block to its forger without trusting some central directory to vouch for it.

On the consensus side: per-account nonces plus balance checks on every block rule out double-spending within any consistent view of the chain. Challenges coming from unforgeable chain history rule out grinding — there's no favorable challenge sitting out there to fish for. Effective capacity being sub-linear and capped, combined with rewards spread across tiers, lowers the payoff of just piling on more disk to dominate the network. And confirmation depth gives everything a reorg-safe horizon once a block is old enough.

At the end of the day security comes down to how much effective capacity honest miners actually control. Because that capacity is rooted and capped, grabbing a majority means controlling an outsized — and deliberately diminishing-return — slice of everything committed to the network. Expensive by design, not by accident.

---

## 8. Privacy

Privacy here works the same way it does on any account-based chain: pseudonymous, not confidential. Addresses don't have to tie back to a real identity, and anyone can generate a fresh key pair offline whenever they want. Every transaction is still public on the ledger, though, so value flows are fully visible — it's just the mapping from a key back to an actual person that's left up to the user.

---

## 9. Reference implementation status

Everything above describes the protocol as intended. The reference implementation, ChocoNode v3.6.0, doesn't fully match that yet in one place that matters for consensus security.

The PoC proof itself isn't cryptographically re-verified when a block gets accepted. Recomputing the deadline from scoop data, the Merkle proof, and the generation signature — the actual check that a claimed win is real, described back in 3.2 — doesn't happen in the block-acceptance path today. The network currently trusts the `winner_proof` signature and whether it matches a submission recorded locally, but it doesn't independently recompute and verify the deadline itself. Blocks pulled in through REST sync also skip signature and difficulty/target validation right now, and blocks already sitting in the database don't get re-checked during chain reorganizations either.

None of that breaks the design laid out in Sections 3 through 5. It's implementation work still outstanding, and it needs to be treated as launch-blocking before mainnet — not something to patch later.

---

## 10. Conclusion

CCpoc puts two ideas into one permissionless network. Securing the chain with Proof-of-Capacity makes mining accessible on ordinary storage and cuts consensus's electricity footprint way down next to Proof-of-Work. Bundling in a full Ethereum-compatible EVM makes that storage-secured ledger immediately useful on top of that — smart contracts, tokens, dApps, all running on native CC.

Every choice in here points at the same outcome: challenge derivation from the chain itself, capacity-based difficulty, tiered and capped effective capacity, rewards split across many miners instead of one. A decentralized, low-energy, programmable network that ordinary people can actually help secure with hardware they already own.

---

*This document describes the CCpoc protocol as intended. Parameters and mechanics may evolve in future versions.*
