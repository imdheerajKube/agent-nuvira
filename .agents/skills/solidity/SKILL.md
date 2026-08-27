---
name: solidity
description: Write, test, and deploy Solidity smart contracts. Covers contract design, security patterns, gas optimization, testing with Hardhat/Foundry, and mainnet deployment. Use when building on Ethereum or EVM-compatible chains.
version: 1.0.0
---

# solidity

Write, test, and deploy Solidity smart contracts. Covers contract design, security patterns, gas optimization, testing with Hardhat/Foundry, and mainnet deployment. Use when building on Ethereum or EVM-compatible chains.

## Goal pattern

solidity smart contract ethereum EVM hardhat foundry deploy gas optimization security audit blockchain

## Parameters

(none)

## Steps

1. [context-gatherer] Map the requirements: what chain (Ethereum, Polygon, Arbitrum)? What does the contract do (token, NFT, DeFi, DAO)? What standard (ERC-20, ERC-721, ERC-1155)? What security requirements?

2. [planner] Design the contract architecture:
1. Interface design: define public/external functions, events, errors
2. Storage layout: state variables, mappings, structs (optimize for gas)
3. Security patterns: checks-effects-interactions, reentrancy guards, access control
4. Testing strategy: unit tests, fuzz tests, invariant tests
5. Deployment: testnet first, verify on Etherscan, multi-sig for mainnet (after: step-0)

3. [runner] Implement the contract:
1. Write the Solidity contract with NatSpec documentation
2. Add security checks (OpenZeppelin libraries where possible)
3. Write comprehensive tests (Hardhat or Foundry)
4. Run static analysis (Slither, Mythril)
5. Deploy to testnet and verify
6. Run integration tests on testnet (after: step-1)

4. [reviewer] Verify the contract: run all tests, static analysis, gas report, verify on testnet explorer. Document any findings and recommendations. (after: step-2)
