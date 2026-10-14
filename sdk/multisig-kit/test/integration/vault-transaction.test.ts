import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  fetchMint,
  getInitializeMint2Instruction,
  getMintSize,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { createNoopSigner, generateKeyPairSigner, some } from '@solana/kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildVaultTransactionCreateInstruction,
  fetchProposal,
  fetchVaultTransaction,
  findEphemeralSignerPda,
  findProposalPda,
  findTransactionPda,
  fetchMaybeProposal,
  fetchMaybeVaultTransaction,
  getVaultTransactionAccountsCloseInstructionAsync,
  SQUADS_MULTISIG_ERROR__INVALID_PROPOSAL_STATUS,
} from '../../src';
import { createTestContext, LAMPORTS_PER_SOL, programConfig } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

describe('vault transaction', () => {
  it('transfers SOL from the vault', async () => {
    const { members, multisig, vault } = await ctx.createAutonomousMultisig();
    const destination = (await generateKeyPairSigner()).address;
    ctx.fund(vault, 2);
    const transactionIndex = 1n;
    const amount = BigInt(LAMPORTS_PER_SOL);

    await ctx.send([
      await buildVaultTransactionCreateInstruction(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          vaultIndex: 0,
          ephemeralSigners: 0,
          transactionIndex,
          memo: 'transfer 1 SOL',
          instructions: [
            getTransferSolInstruction({ source: createNoopSigner(vault), destination, amount }),
          ],
        },
        programConfig,
      ),
      ...(await ctx.proposeAndApprove(multisig, members, transactionIndex)),
    ]);

    const [transaction] = await findTransactionPda({ multisig, transactionIndex }, programConfig);
    const vaultTransaction = await fetchVaultTransaction(ctx.client.rpc, transaction);
    expect(vaultTransaction.programAddress).toBe(programConfig.programAddress);
    expect(vaultTransaction.data.message.accountKeys[0]).toBe(vault);

    const vaultBefore = await ctx.getBalance(vault);
    await ctx.executeVaultTransaction(multisig, members.executor, transactionIndex);

    expect(await ctx.getBalance(vault)).toBe(vaultBefore - amount);
    expect(await ctx.getBalance(destination)).toBe(amount);
    const [proposal] = await findProposalPda({ multisig, transactionIndex }, programConfig);
    expect((await fetchProposal(ctx.client.rpc, proposal)).data.status.__kind).toBe('Executed');
  });

  it('creates a mint using an ephemeral signer', async () => {
    const { members, multisig, vault } = await ctx.createAutonomousMultisig();
    const transactionIndex = 1n;
    const [transaction] = await findTransactionPda({ multisig, transactionIndex }, programConfig);
    const [mint] = await findEphemeralSignerPda(
      { transaction, ephemeralSignerIndex: 0 },
      programConfig,
    );
    const space = getMintSize();
    const lamports = await ctx.client.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
    ctx.client.surfnet.fundSol(vault, Number(lamports));

    await ctx.send([
      await buildVaultTransactionCreateInstruction(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          vaultIndex: 0,
          ephemeralSigners: 1,
          transactionIndex,
          instructions: [
            getCreateAccountInstruction({
              payer: createNoopSigner(vault),
              newAccount: createNoopSigner(mint),
              lamports,
              space,
              programAddress: TOKEN_PROGRAM_ADDRESS,
            }),
            getInitializeMint2Instruction({
              mint,
              decimals: 9,
              mintAuthority: vault,
              freezeAuthority: vault,
            }),
          ],
        },
        programConfig,
      ),
      ...(await ctx.proposeAndApprove(multisig, members, transactionIndex)),
    ]);
    await ctx.executeVaultTransaction(multisig, members.executor, transactionIndex);

    const mintAccount = await fetchMint(ctx.client.rpc, mint);
    expect(mintAccount.data).toMatchObject({
      isInitialized: true,
      decimals: 9,
      supply: 0n,
      mintAuthority: some(vault),
      freezeAuthority: some(vault),
    });
  });

  it('closes the vault transaction and proposal after execution', async () => {
    const rentCollector = (await generateKeyPairSigner()).address;
    const { members, multisig, vault } = await ctx.createAutonomousMultisig({ rentCollector });
    ctx.fund(vault);
    const transactionIndex = 1n;
    const destination = (await generateKeyPairSigner()).address;
    const close = getVaultTransactionAccountsCloseInstructionAsync(
      { multisig, rentCollector, transactionIndex },
      programConfig,
    );

    await ctx.send([
      await buildVaultTransactionCreateInstruction(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          vaultIndex: 0,
          ephemeralSigners: 0,
          transactionIndex,
          instructions: [
            getTransferSolInstruction({
              source: createNoopSigner(vault),
              destination,
              amount: 1_000_000n,
            }),
          ],
        },
        programConfig,
      ),
      ...(await ctx.proposeAndApprove(multisig, members, transactionIndex)),
    ]);
    await ctx.expectProgramError([await close], SQUADS_MULTISIG_ERROR__INVALID_PROPOSAL_STATUS);

    await ctx.executeVaultTransaction(multisig, members.executor, transactionIndex);
    await ctx.send([await close]);

    const [transaction] = await findTransactionPda({ multisig, transactionIndex }, programConfig);
    const [proposal] = await findProposalPda({ multisig, transactionIndex }, programConfig);
    expect((await fetchMaybeVaultTransaction(ctx.client.rpc, transaction)).exists).toBe(false);
    expect((await fetchMaybeProposal(ctx.client.rpc, proposal)).exists).toBe(false);
    expect(await ctx.getBalance(rentCollector)).toBeGreaterThan(0n);
  });
});
