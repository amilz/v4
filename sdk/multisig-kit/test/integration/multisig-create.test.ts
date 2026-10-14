import { generateKeyPairSigner, none, some } from '@solana/kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  fetchMultisig,
  findMultisigPda,
  getMultisigCreateV2InstructionAsync,
  getProgramConfigSetMultisigCreationFeeInstructionAsync,
  SQUADS_MULTISIG_ERROR__DUPLICATE_MEMBER,
  SQUADS_MULTISIG_ERROR__INVALID_THRESHOLD,
  allPermissions,
} from '../../src';
import { createTestContext, LAMPORTS_PER_SOL, programConfig } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

const DEFAULT_ADDRESS = '11111111111111111111111111111111';

describe('multisigCreateV2', () => {
  it('creates an autonomous multisig with auto-derived PDAs', async () => {
    const members = await ctx.generateMembers();
    const createKey = await generateKeyPairSigner();
    const rentCollector = (await generateKeyPairSigner()).address;

    const ix = await getMultisigCreateV2InstructionAsync(
      {
        treasury: ctx.treasury,
        createKey,
        creator: ctx.client.payer,
        configAuthority: null,
        threshold: 2,
        members: ctx.memberArgs(members),
        timeLock: 60,
        rentCollector,
        memo: 'kit sdk',
      },
      programConfig,
    );
    expect(ix.programAddress).toBe(programConfig.programAddress);
    await ctx.send([ix]);

    const [multisigPda, bump] = await findMultisigPda(
      { createKey: createKey.address },
      programConfig,
    );
    expect(ix.accounts[2].address).toBe(multisigPda);

    const account = await fetchMultisig(ctx.client.rpc, multisigPda);
    expect(account.programAddress).toBe(programConfig.programAddress);
    expect(account.data).toMatchObject({
      createKey: createKey.address,
      configAuthority: DEFAULT_ADDRESS,
      threshold: 2,
      timeLock: 60,
      transactionIndex: 0n,
      staleTransactionIndex: 0n,
      rentCollector: some(rentCollector),
      bump,
    });
    expect(account.data.members).toHaveLength(4);
    expect(account.data.members).toEqual(expect.arrayContaining(ctx.memberArgs(members)));
  });

  it('creates a controlled multisig', async () => {
    const configAuthority = await generateKeyPairSigner();
    const member = await generateKeyPairSigner();
    const multisig = await ctx.createMultisig({
      members: [{ key: member.address, permissions: allPermissions() }],
      threshold: 1,
      configAuthority: configAuthority.address,
    });

    const data = await ctx.getMultisig(multisig);
    expect(data.configAuthority).toBe(configAuthority.address);
    expect(data.rentCollector).toEqual(none());
  });

  it('rejects duplicate members', async () => {
    const member = await generateKeyPairSigner();
    const createKey = await generateKeyPairSigner();
    await ctx.expectProgramError(
      [
        await getMultisigCreateV2InstructionAsync(
          {
            treasury: ctx.treasury,
            createKey,
            creator: ctx.client.payer,
            configAuthority: null,
            threshold: 1,
            members: [
              { key: member.address, permissions: allPermissions() },
              { key: member.address, permissions: allPermissions() },
            ],
            timeLock: 0,
            rentCollector: null,
          },
          programConfig,
        ),
      ],
      SQUADS_MULTISIG_ERROR__DUPLICATE_MEMBER,
    );
  });

  it('rejects a threshold above the number of voters', async () => {
    const members = await ctx.generateMembers();
    const createKey = await generateKeyPairSigner();
    await ctx.expectProgramError(
      [
        await getMultisigCreateV2InstructionAsync(
          {
            treasury: ctx.treasury,
            createKey,
            creator: ctx.client.payer,
            configAuthority: null,
            threshold: 3,
            members: ctx.memberArgs(members),
            timeLock: 0,
            rentCollector: null,
          },
          programConfig,
        ),
      ],
      SQUADS_MULTISIG_ERROR__INVALID_THRESHOLD,
    );
  });

  it('charges the multisig creation fee to the creator', async () => {
    const fee = LAMPORTS_PER_SOL / 10;
    await ctx.send([
      await getProgramConfigSetMultisigCreationFeeInstructionAsync(
        { authority: ctx.programConfigAuthority, newMultisigCreationFee: fee },
        programConfig,
      ),
    ]);

    const treasuryBefore = await ctx.getBalance(ctx.treasury);
    const members = await ctx.generateMembers();
    await ctx.createMultisig({ members: ctx.memberArgs(members), threshold: 1 });
    expect(await ctx.getBalance(ctx.treasury)).toBe(treasuryBefore + BigInt(fee));

    await ctx.send([
      await getProgramConfigSetMultisigCreationFeeInstructionAsync(
        { authority: ctx.programConfigAuthority, newMultisigCreationFee: 0 },
        programConfig,
      ),
    ]);
  });
});
