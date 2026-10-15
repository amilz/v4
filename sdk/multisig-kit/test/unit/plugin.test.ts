import { getTransferSolInstruction } from '@solana-program/system';
import {
  AccountRole,
  createNoopSigner,
  generateKeyPairSigner,
  type Address,
  type Instruction,
} from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  buildVaultTransactionCreateInstruction,
  findVaultPda,
  squadsMultisigProgram,
  SQUADS_MULTISIG_PROGRAM_ADDRESS,
  type SquadsMultisigPluginRequirements,
} from '../../src';

function createFakeClient(config?: Parameters<typeof squadsMultisigProgram>[0]) {
  const getProgramAccounts = vi.fn(() => ({ send: async () => [] }));
  const sendTransaction = vi.fn(async (instruction: Instruction) => ({ instruction }));
  const client = {
    rpc: { getProgramAccounts },
    planTransaction: vi.fn(),
    planTransactions: vi.fn(),
    sendTransaction,
    sendTransactions: vi.fn(),
  } as unknown as SquadsMultisigPluginRequirements;
  return { client: squadsMultisigProgram(config)(client), getProgramAccounts, sendTransaction };
}

const randomAddress = async () => (await generateKeyPairSigner()).address;

describe('squadsMultisigProgram()', () => {
  it('keeps the generated namespaces and instructions', () => {
    const { client } = createFakeClient();
    expect(client.squadsMultisig.accounts.multisig.fetch).toBeTypeOf('function');
    expect(client.squadsMultisig.pdas.vault).toBeTypeOf('function');
    expect(client.squadsMultisig.instructions.proposalApprove).toBeTypeOf('function');
    expect(client.squadsMultisig.identifyAccount).toBeTypeOf('function');
  });

  it('compiles the compact message in vaultTransactionCreate', async () => {
    const { client } = createFakeClient();
    const multisig = await randomAddress();
    const [vault] = await client.squadsMultisig.pdas.vault({ multisig, vaultIndex: 0 });
    const input = {
      multisig,
      creator: await generateKeyPairSigner(),
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionIndex: 1n,
      instructions: [
        getTransferSolInstruction({
          source: createNoopSigner(vault),
          destination: await randomAddress(),
          amount: 1n,
        }),
      ],
    };

    const instruction = await client.squadsMultisig.instructions.vaultTransactionCreate(input);

    expect(instruction).toEqual(await buildVaultTransactionCreateInstruction(input));
  });

  it('appends spending limits in configTransactionExecute and sends through the client', async () => {
    const { client, sendTransaction } = createFakeClient();
    const spendingLimit = await randomAddress();

    await client.squadsMultisig.instructions
      .configTransactionExecute({
        multisig: await randomAddress(),
        member: await generateKeyPairSigner(),
        transactionIndex: 1n,
        spendingLimits: [spendingLimit],
      })
      .sendTransaction();

    const [[sent]] = sendTransaction.mock.calls;
    expect(sent.programAddress).toBe(SQUADS_MULTISIG_PROGRAM_ADDRESS);
    expect(sent.accounts?.at(-1)).toEqual({ address: spendingLimit, role: AccountRole.WRITABLE });
  });

  it('binds gpa queries to the client rpc', async () => {
    const { client, getProgramAccounts } = createFakeClient();
    const multisig: Address = await randomAddress();

    expect(await client.squadsMultisig.gpa.proposals({ multisig, status: 'Active' })).toEqual([]);

    expect(getProgramAccounts).toHaveBeenCalledOnce();
    expect(getProgramAccounts).toHaveBeenCalledWith(
      SQUADS_MULTISIG_PROGRAM_ADDRESS,
      expect.objectContaining({ encoding: 'base64' }),
    );
  });

  it('targets a custom program address, with per-call configs taking precedence', async () => {
    const programAddress = await randomAddress();
    const callProgramAddress = await randomAddress();
    const { client, getProgramAccounts } = createFakeClient({
      programAddress: { address: programAddress },
    });
    const multisig = await randomAddress();
    const input = {
      multisig,
      member: await generateKeyPairSigner(),
      transactionIndex: 1n,
      spendingLimits: [],
    };

    const [vault] = await client.squadsMultisig.pdas.vault({ multisig, vaultIndex: 0 });
    expect(vault).toBe((await findVaultPda({ multisig, vaultIndex: 0 }, { programAddress }))[0]);
    expect((await client.squadsMultisig.instructions.proposalApprove(input)).programAddress).toBe(
      programAddress,
    );
    expect(
      (await client.squadsMultisig.instructions.configTransactionExecute(input)).programAddress,
    ).toBe(programAddress);
    expect(
      (
        await client.squadsMultisig.instructions.configTransactionExecute(input, {
          programAddress: callProgramAddress,
        })
      ).programAddress,
    ).toBe(callProgramAddress);

    await client.squadsMultisig.gpa.programConfigs();
    await client.squadsMultisig.gpa.programConfigs({ programAddress: callProgramAddress });
    expect(getProgramAccounts).toHaveBeenNthCalledWith(1, programAddress, expect.anything());
    expect(getProgramAccounts).toHaveBeenNthCalledWith(2, callProgramAddress, expect.anything());
  });
});
