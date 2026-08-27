# Web3 Dapp Reference Guide

## Overview
Build a Web3 decentralized application: wallet connection, contract interaction, transaction handling, and IPFS integration. Use when the goal is to create a frontend that interacts with blockchain contracts.

## # web3-dapp

Build a Web3 decentralized application: wallet connection, contract interaction, transaction handling, and IPFS integration. Use when the goal is to create a frontend that interacts with blockchain contracts.

## Goal pattern

web3 dapp decentralized application wallet connection metamask contract interaction IPFS blockchain frontend

## Steps

0. [context-gatherer] Map the stack: what frontend framework (React, Next.js, Vue)? What chain? What wallet (MetaMask, WalletConnect)? What contract ABI? What off-chain storage (IPFS, Arweave)?

1. [planner] Design the DApp architecture:
1. Wallet connection: RainbowKit or custom connect button
2. Contract interaction: wagmi hooks or ethers.js read/write calls
3. Transaction handling: pending state, confirmation, error recovery
4. IPFS integration: pin files, retrieve content
5. State management: React Query for on-chain data caching
6. Error handling: user-friendly messages for common wallet errors (after: 'step-0')

2. [runner] Build the DApp:
1. Set up the project with wagmi + viem (or ethers.js)
2. Implement wallet connection flow
3. Add contract read hooks (useContractRead)
4. Add contract write hooks (useContractWrite) with transaction tracking
5. Integrate IPFS for file storage
6. Add error handling and loading states (after: 'step-1')

3. [reviewer] Test the DApp: connect wallet, read contract state, execute transactions, verify IPFS upload/download, test error states (wrong chain, rejected transaction). (after: 'step-2')

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
