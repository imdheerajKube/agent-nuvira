---
name: nft-mint
description: Build an NFT minting platform: smart contract, metadata storage (IPFS), minting frontend, and reveal mechanism. Use when the goal is to create, deploy, and launch an NFT collection.
version: 1.0.0
---

# nft-mint

Build an NFT minting platform: smart contract, metadata storage (IPFS), minting frontend, and reveal mechanism. Use when the goal is to create, deploy, and launch an NFT collection.

## Goal pattern

NFT mint minting platform ERC-721 IPFS metadata collection launch

## Parameters

(none)

## Steps

1. [context-gatherer] Map the collection: how many NFTs? What metadata format (standard, generative art)? What chain? What pricing (free mint, fixed price, auction)? What reveal strategy (instant, delayed, staged)?

2. [planner] Design the NFT system:
1. Contract: ERC-721 with merkle tree allowlist, staged reveal, royalty support
2. Metadata: JSON schema, IPFS pinning (Pinata/NFT.Storage)
3. Art: on-chain generative or pre-computed with CID storage
4. Minting frontend: wallet connect, mint button, transaction tracking
5. Reveal: delayed reveal with metadata swap mechanism (after: step-0)

3. [runner] Implement the NFT system:
1. Write the ERC-721 contract with mint, reveal, and allowlist
2. Upload metadata to IPFS
3. Build the minting frontend with wallet integration
4. Test on testnet (Sepolia)
5. Deploy to mainnet
6. Verify and pin metadata (after: step-1)

4. [reviewer] Verify: test mint flow end-to-end, verify metadata on IPFS, check contract on Etherscan, test reveal mechanism, verify royalties. (after: step-2)
