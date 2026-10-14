import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTransferSolInstruction } from '@solana-program/system';
import { createClient, createNoopSigner, generateKeyPairSigner } from '@solana/kit';
import { surfpool } from '@solana/surfpool/kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allPermissions,
  buildVaultTransactionExecuteInstruction,
  compileCompactTransactionMessage,
  getCompactTransactionMessageEncoder,
  getProgramConfigEncoder,
  getSquadsMultisigErrorMessage,
  isSquadsMultisigError,
  squadsMultisigProgram,
  SQUADS_MULTISIG_ERROR__ALREADY_APPROVED,
  SQUADS_MULTISIG_PROGRAM_ADDRESS,
} from '../../src';

/**
 * The generated `squadsMultisigProgram()` plugin and `isSquadsMultisigError` are hardwired to the
 * mainnet program id, so this file deploys the build made without the `testing` feature
 * (`pnpm build:program`) at that address instead of using the shared testing-id harness.
 */
const SO_PATH = fileURLToPath(
  new URL('../../../../target/deploy-mainnet/squads_multisig_program.so', import.meta.url),
);
if (!existsSync(SO_PATH)) {
  throw new Error(`Missing ${SO_PATH}. Run \`pnpm build:program\` first.`);
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

const client = await createClient().use(surfpool()).use(squadsMultisigProgram());
afterAll(() => client.surfnet.stop());

client.surfnet.deploy({ programId: SQUADS_MULTISIG_PROGRAM_ADDRESS, soPath: SO_PATH });

// The mainnet build only lets the real initializer key run `programConfigInit`, so the
// ProgramConfig account is written straight into the Surfnet using the generated encoder.
const treasury = (await generateKeyPairSigner()).address;
const [programConfigPda] = await client.squadsMultisig.pdas.programConfig();
const programConfigData = getProgramConfigEncoder().encode({
  authority: (await generateKeyPairSigner()).address,
  multisigCreationFee: 0n,
  treasury,
  reserved: new Uint8Array(64),
});
client.surfnet.setAccount(
  programConfigPda,
  Number(
    await client.rpc.getMinimumBalanceForRentExemption(BigInt(programConfigData.length)).send(),
  ),
  new Uint8Array(programConfigData),
  SQUADS_MULTISIG_PROGRAM_ADDRESS,
);

async function createMultisig() {
  const [alice, bob, executor, createKey] = await Promise.all(
    Array.from({ length: 4 }, () => generateKeyPairSigner()),
  );
  const [multisig] = await client.squadsMultisig.pdas.multisig({ createKey: createKey.address });
  const [vault] = await client.squadsMultisig.pdas.vault({ multisig, vaultIndex: 0 });

  await client.squadsMultisig.instructions
    .multisigCreateV2({
      treasury,
      createKey,
      creator: client.payer,
      configAuthority: null,
      threshold: 2,
      members: [alice, bob, executor].map((member) => ({
        key: member.address,
        permissions: allPermissions(),
      })),
      timeLock: 0,
      rentCollector: null,
    })
    .sendTransaction();

  return { alice, bob, executor, multisig, vault };
}

describe('squadsMultisigProgram() plugin', () => {
  it('creates a multisig and reads it back', async () => {
    const { alice, bob, executor, multisig } = await createMultisig();

    const account = await client.squadsMultisig.accounts.multisig.fetch(multisig);

    expect(account.programAddress).toBe(SQUADS_MULTISIG_PROGRAM_ADDRESS);
    expect(account.data.threshold).toBe(2);
    expect(account.data.members.map((m) => m.key).sort()).toEqual(
      [alice, bob, executor].map((m) => m.address).sort(),
    );
  });

  it('runs a vault transaction that transfers SOL', async () => {
    const { alice, bob, executor, multisig, vault } = await createMultisig();
    const destination = (await generateKeyPairSigner()).address;
    const amount = LAMPORTS_PER_SOL;
    client.surfnet.fundSol(vault, Number(2n * LAMPORTS_PER_SOL));
    const transactionIndex = 1n;

    const transactionMessage = getCompactTransactionMessageEncoder().encode(
      compileCompactTransactionMessage({
        vault,
        instructions: [
          getTransferSolInstruction({ source: createNoopSigner(vault), destination, amount }),
        ],
      }),
    );

    const { instructions } = client.squadsMultisig;
    await instructions
      .vaultTransactionCreate({
        multisig,
        creator: alice,
        rentPayer: client.payer,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionIndex,
        transactionMessage,
      })
      .sendTransaction();
    await instructions
      .proposalCreate({ multisig, creator: alice, rentPayer: client.payer, transactionIndex })
      .sendTransaction();
    await instructions
      .proposalApprove({ multisig, member: alice, transactionIndex })
      .sendTransaction();
    await instructions
      .proposalApprove({ multisig, member: bob, transactionIndex })
      .sendTransaction();

    const [proposalPda] = await client.squadsMultisig.pdas.proposal({ multisig, transactionIndex });
    const approved = await client.squadsMultisig.accounts.proposal.fetch(proposalPda);
    expect(approved.data.status.__kind).toBe('Approved');

    // The plugin has no equivalent of this helper: it fetches the stored message and adds the
    // remaining accounts `vaultTransactionExecute` needs.
    const execute = await buildVaultTransactionExecuteInstruction({
      rpc: client.rpc,
      multisig,
      member: executor,
      transactionIndex,
    });
    await client.sendTransaction(execute.instruction);

    expect((await client.rpc.getBalance(destination).send()).value).toBe(amount);
    expect((await client.rpc.getBalance(vault).send()).value).toBe(LAMPORTS_PER_SOL);
    const executed = await client.squadsMultisig.accounts.proposal.fetch(proposalPda);
    expect(executed.data.status.__kind).toBe('Executed');
  });

  it('decodes program errors with isSquadsMultisigError', async () => {
    const { alice, multisig, vault } = await createMultisig();
    const transactionIndex = 1n;
    const { instructions } = client.squadsMultisig;
    const transactionMessage = getCompactTransactionMessageEncoder().encode(
      compileCompactTransactionMessage({
        vault,
        instructions: [
          getTransferSolInstruction({
            source: createNoopSigner(vault),
            destination: alice.address,
            amount: 1n,
          }),
        ],
      }),
    );
    await instructions
      .vaultTransactionCreate({
        multisig,
        creator: alice,
        rentPayer: client.payer,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionIndex,
        transactionMessage,
      })
      .sendTransaction();
    await instructions
      .proposalCreate({ multisig, creator: alice, rentPayer: client.payer, transactionIndex })
      .sendTransaction();
    await instructions
      .proposalApprove({ multisig, member: alice, transactionIndex })
      .sendTransaction();

    // `isSquadsMultisigError` needs the transaction message to map the failing instruction index
    // to a program, so plan first and send that same message.
    const approveAgain = instructions.proposalApprove({
      multisig,
      member: alice,
      transactionIndex,
    });
    const message = await approveAgain.planTransaction();
    const error = await client.sendTransaction(message).then(
      () => undefined,
      (e: unknown) => e,
    );

    // The program error sits below the send failure and the simulation failure in the cause chain.
    let cause = error;
    while (
      cause &&
      !isSquadsMultisigError(cause, message, SQUADS_MULTISIG_ERROR__ALREADY_APPROVED)
    ) {
      cause = (cause as { cause?: unknown }).cause;
    }
    expect(cause, `unexpected error: ${String(error)}`).toBeDefined();
    expect(getSquadsMultisigErrorMessage(SQUADS_MULTISIG_ERROR__ALREADY_APPROVED)).toBe(
      'Member already approved the transaction',
    );
  });
});
