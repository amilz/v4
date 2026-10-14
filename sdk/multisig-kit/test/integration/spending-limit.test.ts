import { address, generateKeyPairSigner } from '@solana/kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  fetchSpendingLimit,
  findSpendingLimitPda,
  findVaultPda,
  getMultisigAddSpendingLimitInstructionAsync,
  getSpendingLimitUseInstructionAsync,
  buildConfigTransactionExecuteInstruction,
  getConfigTransactionCreateInstructionAsync,
  getProposalApproveInstructionAsync,
  getProposalCreateInstructionAsync,
  Period,
  SQUADS_MULTISIG_ERROR__MISSING_ACCOUNT,
  SQUADS_MULTISIG_ERROR__INVALID_DESTINATION,
  SQUADS_MULTISIG_ERROR__SPENDING_LIMIT_EXCEEDED,
  SQUADS_MULTISIG_ERROR__UNAUTHORIZED,
  allPermissions,
} from '../../src';
import { createTestContext, LAMPORTS_PER_SOL, programConfig } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

const SOL_MINT = address('11111111111111111111111111111111');

describe('spending limit (SOL)', () => {
  it('lets an allowed member transfer from the vault within the limit', async () => {
    const configAuthority = await generateKeyPairSigner();
    const member = await generateKeyPairSigner();
    const outsider = await generateKeyPairSigner();
    const destination = (await generateKeyPairSigner()).address;
    const otherDestination = (await generateKeyPairSigner()).address;
    const multisig = await ctx.createMultisig({
      members: [
        { key: member.address, permissions: allPermissions() },
        { key: outsider.address, permissions: allPermissions() },
      ],
      threshold: 1,
      configAuthority: configAuthority.address,
    });

    const createKey = (await generateKeyPairSigner()).address;
    const limit = 2n * BigInt(LAMPORTS_PER_SOL);
    await ctx.send([
      await getMultisigAddSpendingLimitInstructionAsync(
        {
          multisig,
          configAuthority,
          rentPayer: ctx.client.payer,
          createKey,
          vaultIndex: 0,
          mint: SOL_MINT,
          amount: limit,
          period: Period.OneTime,
          members: [member.address],
          destinations: [destination],
        },
        programConfig,
      ),
    ]);
    const [spendingLimit] = await findSpendingLimitPda({ multisig, createKey }, programConfig);
    const [vault] = await findVaultPda({ multisig, vaultIndex: 0 }, programConfig);
    ctx.fund(vault, 10);

    const use = (amount: bigint, signer = member, to = destination) =>
      getSpendingLimitUseInstructionAsync(
        {
          multisig,
          member: signer,
          spendingLimit,
          destination: to,
          amount,
          decimals: 9,
          vaultIndex: 0,
        },
        programConfig,
      );

    const amount = BigInt(LAMPORTS_PER_SOL);
    const useIx = await use(amount);
    expect(useIx.accounts[3].address).toBe(vault);
    const vaultBefore = await ctx.getBalance(vault);
    await ctx.send([useIx]);

    expect(await ctx.getBalance(vault)).toBe(vaultBefore - amount);
    expect(await ctx.getBalance(destination)).toBe(amount);
    expect((await fetchSpendingLimit(ctx.client.rpc, spendingLimit)).data.remainingAmount).toBe(
      limit - amount,
    );

    await ctx.expectProgramError(
      [await use(limit - amount + 1n)],
      SQUADS_MULTISIG_ERROR__SPENDING_LIMIT_EXCEEDED,
    );
    await ctx.expectProgramError(
      [await use(1n, member, otherDestination)],
      SQUADS_MULTISIG_ERROR__INVALID_DESTINATION,
    );
    await ctx.expectProgramError([await use(1n, outsider)], SQUADS_MULTISIG_ERROR__UNAUTHORIZED);
  });

  it('adds a spending limit through an autonomous config transaction', async () => {
    const members = await ctx.generateMembers();
    const multisig = await ctx.createMultisig({ members: ctx.memberArgs(members), threshold: 1 });
    const createKey = (await generateKeyPairSigner()).address;
    const [spendingLimit] = await findSpendingLimitPda({ multisig, createKey }, programConfig);
    const input = { multisig, transactionIndex: 1n };

    await ctx.send([
      await getConfigTransactionCreateInstructionAsync(
        {
          ...input,
          creator: members.almighty,
          rentPayer: ctx.client.payer,
          actions: [
            {
              __kind: 'AddSpendingLimit',
              createKey,
              vaultIndex: 0,
              mint: SOL_MINT,
              amount: 1_000_000n,
              period: Period.Week,
              members: [members.almighty.address],
              destinations: [],
            },
          ],
        },
        programConfig,
      ),
      await getProposalCreateInstructionAsync(
        { ...input, creator: members.almighty, rentPayer: ctx.client.payer },
        programConfig,
      ),
      await getProposalApproveInstructionAsync(
        { ...input, member: members.almighty },
        programConfig,
      ),
    ]);

    const executeInput = { ...input, member: members.almighty, rentPayer: ctx.client.payer };
    await ctx.expectProgramError(
      [await buildConfigTransactionExecuteInstruction(executeInput, programConfig)],
      SQUADS_MULTISIG_ERROR__MISSING_ACCOUNT,
    );
    await ctx.send([
      await buildConfigTransactionExecuteInstruction(
        { ...executeInput, spendingLimits: [spendingLimit] },
        programConfig,
      ),
    ]);

    const account = await fetchSpendingLimit(ctx.client.rpc, spendingLimit);
    expect(account.data).toMatchObject({
      multisig,
      createKey,
      amount: 1_000_000n,
      period: Period.Week,
    });
  });
});
