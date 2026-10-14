import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchMaybeSpendingLimit,
  fetchSpendingLimit,
  findSpendingLimitPda,
  getMultisigAddMemberInstruction,
  getMultisigAddSpendingLimitInstructionAsync,
  getMultisigChangeThresholdInstruction,
  getMultisigRemoveMemberInstruction,
  getMultisigRemoveSpendingLimitInstruction,
  getMultisigSetConfigAuthorityInstruction,
  getMultisigSetTimeLockInstruction,
  Period,
  SQUADS_MULTISIG_ERROR__DUPLICATE_MEMBER,
  SQUADS_MULTISIG_ERROR__INVALID_THRESHOLD,
  SQUADS_MULTISIG_ERROR__UNAUTHORIZED,
  createPermissions,
  Permission,
} from '../../src';
import { createTestContext, programConfig, type TestMembers } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

describe('controlled multisig config authority', () => {
  let configAuthority: KeyPairSigner;
  let members: TestMembers;
  let multisig: Address;

  beforeEach(async () => {
    configAuthority = await generateKeyPairSigner();
    members = await ctx.generateMembers();
    multisig = await ctx.createMultisig({
      members: ctx.memberArgs(members),
      threshold: 1,
      configAuthority: configAuthority.address,
    });
  });

  it('adds a member', async () => {
    const newMember = await generateKeyPairSigner();
    await ctx.send([
      getMultisigAddMemberInstruction(
        {
          multisig,
          configAuthority,
          rentPayer: ctx.client.payer,
          newMember: { key: newMember.address, permissions: createPermissions([Permission.Vote]) },
          memo: 'add member',
        },
        programConfig,
      ),
    ]);

    const data = await ctx.getMultisig(multisig);
    expect(data.members).toHaveLength(5);
    expect(data.members).toContainEqual({
      key: newMember.address,
      permissions: createPermissions([Permission.Vote]),
    });
  });

  it('rejects adding an existing member', async () => {
    await ctx.expectProgramError(
      [
        getMultisigAddMemberInstruction(
          {
            multisig,
            configAuthority,
            rentPayer: ctx.client.payer,
            newMember: {
              key: members.voter.address,
              permissions: createPermissions([Permission.Vote]),
            },
          },
          programConfig,
        ),
      ],
      SQUADS_MULTISIG_ERROR__DUPLICATE_MEMBER,
    );
  });

  it('rejects a signer that is not the config authority', async () => {
    const impostor = await generateKeyPairSigner();
    await ctx.expectProgramError(
      [
        getMultisigSetTimeLockInstruction(
          { multisig, configAuthority: impostor, timeLock: 10 },
          programConfig,
        ),
      ],
      SQUADS_MULTISIG_ERROR__UNAUTHORIZED,
    );
  });

  it('removes a member', async () => {
    await ctx.send([
      getMultisigRemoveMemberInstruction(
        { multisig, configAuthority, oldMember: members.proposer.address },
        programConfig,
      ),
    ]);

    const data = await ctx.getMultisig(multisig);
    expect(data.members.map((m) => m.key)).not.toContain(members.proposer.address);
    expect(data.members).toHaveLength(3);
  });

  it('changes the threshold', async () => {
    await ctx.send([
      getMultisigChangeThresholdInstruction(
        { multisig, configAuthority, newThreshold: 2 },
        programConfig,
      ),
    ]);
    expect((await ctx.getMultisig(multisig)).threshold).toBe(2);
  });

  it('rejects a threshold above the number of voters', async () => {
    await ctx.expectProgramError(
      [
        getMultisigChangeThresholdInstruction(
          { multisig, configAuthority, newThreshold: 3 },
          programConfig,
        ),
      ],
      SQUADS_MULTISIG_ERROR__INVALID_THRESHOLD,
    );
  });

  it('sets the time lock', async () => {
    await ctx.send([
      getMultisigSetTimeLockInstruction(
        { multisig, configAuthority, timeLock: 300 },
        programConfig,
      ),
    ]);
    expect((await ctx.getMultisig(multisig)).timeLock).toBe(300);
  });

  it('sets a new config authority', async () => {
    const newConfigAuthority = await generateKeyPairSigner();
    await ctx.send([
      getMultisigSetConfigAuthorityInstruction(
        { multisig, configAuthority, newConfigAuthority: newConfigAuthority.address },
        programConfig,
      ),
    ]);
    expect((await ctx.getMultisig(multisig)).configAuthority).toBe(newConfigAuthority.address);
  });

  it('adds and removes a spending limit', async () => {
    const createKey = (await generateKeyPairSigner()).address;
    const destination = (await generateKeyPairSigner()).address;
    const addIx = await getMultisigAddSpendingLimitInstructionAsync(
      {
        multisig,
        configAuthority,
        rentPayer: ctx.client.payer,
        createKey,
        vaultIndex: 1,
        mint: '11111111111111111111111111111111' as Address,
        amount: 1_000_000_000n,
        period: Period.Day,
        members: [members.almighty.address],
        destinations: [destination],
      },
      programConfig,
    );
    await ctx.send([addIx]);

    const [spendingLimit, bump] = await findSpendingLimitPda(
      { multisig, createKey },
      programConfig,
    );
    expect(addIx.accounts[2].address).toBe(spendingLimit);
    const account = await fetchSpendingLimit(ctx.client.rpc, spendingLimit);
    expect(account.programAddress).toBe(programConfig.programAddress);
    expect(account.data).toMatchObject({
      multisig,
      createKey,
      vaultIndex: 1,
      amount: 1_000_000_000n,
      remainingAmount: 1_000_000_000n,
      period: Period.Day,
      members: [members.almighty.address],
      destinations: [destination],
      bump,
    });

    await ctx.send([
      getMultisigRemoveSpendingLimitInstruction(
        { multisig, configAuthority, spendingLimit, rentCollector: ctx.client.payer.address },
        programConfig,
      ),
    ]);
    expect((await fetchMaybeSpendingLimit(ctx.client.rpc, spendingLimit)).exists).toBe(false);
  });
});
