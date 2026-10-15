import { getTransferSolInstruction } from '@solana-program/system';
import {
  createNoopSigner,
  generateKeyPairSigner,
  type Address,
  type TransactionSigner,
} from '@solana/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildVaultTransactionCreateInstruction,
  fetchConfigTransactionAccounts,
  fetchMultisigAccounts,
  fetchProgramConfigAccounts,
  fetchProposalAccounts,
  fetchVaultTransactionAccounts,
  findTransactionPda,
  getConfigTransactionCreateInstructionAsync,
  getProposalCreateInstructionAsync,
} from '../../src';
import { createTestContext, programConfig, type TestMembers } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

describe('getProgramAccounts helpers', () => {
  const rpc = ctx.client.rpc;
  let members: TestMembers;
  let multisig: Address;
  let otherMultisig: Address;

  async function createVaultTransaction(
    target: Address,
    creator: TransactionSigner,
    vault: Address,
    transactionIndex: bigint,
  ) {
    return buildVaultTransactionCreateInstruction(
      {
        multisig: target,
        creator,
        rentPayer: ctx.client.payer,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionIndex,
        instructions: [
          getTransferSolInstruction({
            source: createNoopSigner(vault),
            destination: ctx.client.payer.address,
            amount: 1n,
          }),
        ],
      },
      programConfig,
    );
  }

  beforeAll(async () => {
    const created = await ctx.createAutonomousMultisig();
    ({ members, multisig } = created);
    await ctx.send([
      await createVaultTransaction(multisig, members.proposer, created.vault, 1n),
      ...(await ctx.proposeAndApprove(multisig, members, 1n)),
    ]);
    await ctx.send([
      await createVaultTransaction(multisig, members.almighty, created.vault, 2n),
      await getConfigTransactionCreateInstructionAsync(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          actions: [{ __kind: 'ChangeThreshold', newThreshold: 1 }],
          transactionIndex: 3n,
        },
        programConfig,
      ),
      await getProposalCreateInstructionAsync(
        {
          multisig,
          creator: members.proposer,
          rentPayer: ctx.client.payer,
          transactionIndex: 3n,
        },
        programConfig,
      ),
    ]);

    const other = await ctx.createAutonomousMultisig();
    otherMultisig = other.multisig;
    await ctx.send([
      await createVaultTransaction(otherMultisig, other.members.proposer, other.vault, 1n),
      ...(await ctx.proposeAndApprove(otherMultisig, other.members, 1n)),
    ]);
  });

  it('finds multisigs by createKey and configAuthority', async () => {
    const { createKey } = await ctx.getMultisig(multisig);
    const byCreateKey = await fetchMultisigAccounts(rpc, { createKey }, programConfig);
    expect(byCreateKey.map((a) => a.address)).toEqual([multisig]);
    expect(byCreateKey[0].data.threshold).toBe(2);

    const configAuthority = (await generateKeyPairSigner()).address;
    const controlled = await ctx.createMultisig({
      members: ctx.memberArgs(members),
      threshold: 1,
      configAuthority,
    });
    const byAuthority = await fetchMultisigAccounts(rpc, { configAuthority }, programConfig);
    expect(byAuthority.map((a) => a.address)).toEqual([controlled]);
  });

  it('finds proposals by multisig and status', async () => {
    const proposals = await fetchProposalAccounts(rpc, { multisig }, programConfig);
    expect(proposals.map((p) => p.data.transactionIndex).sort()).toEqual([1n, 3n]);

    const approved = await fetchProposalAccounts(
      rpc,
      { multisig, status: 'Approved' },
      programConfig,
    );
    expect(approved.map((p) => p.data.transactionIndex)).toEqual([1n]);

    const active = await fetchProposalAccounts(rpc, { multisig, status: 'Active' }, programConfig);
    expect(active.map((p) => p.data.transactionIndex)).toEqual([3n]);

    const allApproved = await fetchProposalAccounts(rpc, { status: 'Approved' }, programConfig);
    expect(allApproved.map((p) => p.data.multisig)).toEqual(
      expect.arrayContaining([multisig, otherMultisig]),
    );
  });

  it('finds vault and config transactions by multisig and creator', async () => {
    const vaultTransactions = await fetchVaultTransactionAccounts(rpc, { multisig }, programConfig);
    expect(vaultTransactions.map((t) => t.data.index).sort()).toEqual([1n, 2n]);

    const [transaction] = await findTransactionPda(
      { multisig, transactionIndex: 2n },
      programConfig,
    );
    const byCreator = await fetchVaultTransactionAccounts(
      rpc,
      { multisig, creator: members.almighty.address },
      programConfig,
    );
    expect(byCreator.map((t) => t.address)).toEqual([transaction]);

    const configTransactions = await fetchConfigTransactionAccounts(
      rpc,
      { multisig },
      programConfig,
    );
    expect(configTransactions).toHaveLength(1);
    expect(configTransactions[0].data.actions[0]).toEqual({
      __kind: 'ChangeThreshold',
      newThreshold: 1,
    });

    expect(
      await fetchVaultTransactionAccounts(rpc, { multisig: otherMultisig }, programConfig),
    ).toHaveLength(1);
  });

  it('fetches the program config', async () => {
    const [account] = await fetchProgramConfigAccounts(rpc, programConfig);
    expect(account.data.treasury).toBe(ctx.treasury);
  });
});
