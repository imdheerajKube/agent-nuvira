# Solidity Reference Guide

## Overview
Write, test, and deploy Solidity smart contracts. Covers contract design, security patterns, gas optimization, testing with Hardhat/Foundry, and mainnet deployment. Use when building on Ethereum or EVM-compatible chains.

## # solidity

Write, test, and deploy Solidity smart contracts. Covers contract design, security patterns, gas optimization, testing with Hardhat/Foundry, and mainnet deployment. Use when building on Ethereum or EVM-compatible chains.

## Goal pattern

solidity smart contract ethereum EVM hardhat foundry deploy gas optimization security audit blockchain

## Steps

0. [context-gatherer] Map the requirements: what chain (Ethereum, Polygon, Arbitrum)? What does the contract do (token, NFT, DeFi, DAO)? What standard (ERC-20, ERC-721, ERC-1155)? What security requirements?

1. [planner] Design the contract architecture:
1. Interface design: define public/external functions, events, errors
2. Storage layout: state variables, mappings, structs (optimize for gas)
3. Security patterns: checks-effects-interactions, reentrancy guards, access control
4. Testing strategy: unit tests, fuzz tests, invariant tests
5. Deployment: testnet first, verify on Etherscan, multi-sig for mainnet (after: 'step-0')

2. [runner] Implement the contract:
1. Write the Solidity contract with NatSpec documentation
2. Add security checks (OpenZeppelin libraries where possible)
3. Write comprehensive tests (Hardhat or Foundry)
4. Run static analysis (Slither, Mythril)
5. Deploy to testnet and verify
6. Run integration tests on testnet (after: 'step-1')

3. [reviewer] Verify the contract: run all tests, static analysis, gas report, verify on testnet explorer. Document any findings and recommendations. (after: 'step-2')

## Best Practices

- Follow the skill's methodology step by step
- Verify each step before proceeding to the next
- Use the appropriate tools for each task
- Document any deviations from the standard approach

## Common Patterns

- Start with context gathering to understand the current state
- Plan the implementation before writing code
- Test changes before committing
- Review for security and performance implications

## Troubleshooting

- If the skill fails, check the prerequisites first
- Verify environment variables are set correctly
- Check for conflicting configurations
- Review logs for detailed error messages

## Further Reading

- Refer to the main SKILL.md for complete methodology
- Check official documentation for the specific technology
- Review related skills in the registry for complementary approaches
