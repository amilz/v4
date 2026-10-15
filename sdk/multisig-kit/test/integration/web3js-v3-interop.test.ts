import { AccountRole, type Instruction, type TransactionPartialSigner } from '@solana/kit';
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allPermissions,
  buildVaultTransactionCreateInstruction,
  buildVaultTransactionExecuteInstruction,
  createPermissions,
  fetchMultisig,
  findMultisigPda,
  findProposalPda,
  findVaultPda,
  getMultisigCreateV2InstructionAsync,
  getMultisigDecoder,
  getProposalApproveInstructionAsync,
  getProposalCreateInstructionAsync,
  getProposalDecoder,
  Permission,
} from '../../src';
import { createTestContext, programConfig } from './_setup';

const ctx = await createTestContext();
afterAll(() => ctx.client.surfnet.stop());

const connection = new Connection(ctx.client.rpcUrl, {
  commitment: 'confirmed',
  wsEndpoint: ctx.client.wsUrl,
});

async function buildCreateMultisig(createKey: Keypair, members: PublicKey[]) {
  return getMultisigCreateV2InstructionAsync(
    {
      treasury: ctx.treasury,
      createKey,
      creator: ctx.client.payer,
      configAuthority: null,
      threshold: 1,
      members: members.map((key, i) => ({
        key,
        permissions: i === 0 ? allPermissions() : createPermissions([Permission.Vote]),
      })),
      timeLock: 0,
      rentCollector: null,
    },
    programConfig,
  );
}

describe('@solana/web3.js v3 interop', () => {
  it('accepts PublicKey inputs and returns Kit addresses', async () => {
    const member = (await Keypair.generate()).publicKey;
    const [multisig] = await findMultisigPda({ createKey: member }, programConfig);
    expect(multisig).toBe(
      (await findMultisigPda({ createKey: member.toBase58() }, programConfig))[0],
    );
  });

  async function expectMultisigCreated(createKey: Keypair, members: PublicKey[]) {
    const [multisig] = await findMultisigPda({ createKey: createKey.publicKey }, programConfig);
    const account = await fetchMultisig(ctx.client.rpc, multisig);
    expect(account.data.createKey).toBe(createKey.publicKey.toBase58());
    expect(account.data.members.map((m) => m.key).sort()).toEqual(
      members.map((m) => m.toBase58()).sort(),
    );
  }

  it('sends a legacy Transaction with sendAndConfirmTransaction', async () => {
    const createKey = await Keypair.generate();
    const members = [(await Keypair.generate()).publicKey];
    const tx = new Transaction().add(await buildCreateMultisig(createKey, members));
    tx.feePayer = new PublicKey(ctx.client.payer.address);

    await sendAndConfirmTransaction(connection, tx, [ctx.client.payer, createKey]);

    await expectMultisigCreated(createKey, members);
  });

  it('sends a legacy Transaction built from SDK instructions', async () => {
    const createKey = await Keypair.generate();
    const members = [(await Keypair.generate()).publicKey, (await Keypair.generate()).publicKey];
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({
      feePayer: new PublicKey(ctx.client.payer.address),
      blockhash,
      lastValidBlockHeight,
    }).add(await buildCreateMultisig(createKey, members));
    await tx.sign(ctx.client.payer, createKey);

    const signature = await connection.sendRawTransaction(
      await tx.serialize({ verifySignatures: false }),
    );
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });

    await expectMultisigCreated(createKey, members);
  });

  it('sends a VersionedTransaction built from SDK instructions', async () => {
    const createKey = await Keypair.generate();
    const member = (await Keypair.generate()).publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: new PublicKey(ctx.client.payer.address),
      recentBlockhash: blockhash,
      instructions: [],
    });
    const legacy = new Transaction().add(await buildCreateMultisig(createKey, [member]));
    message.instructions = legacy.instructions;
    const tx = new VersionedTransaction(message.compileToV0Message());
    await tx.sign([ctx.client.payer, createKey], {
      lastValidBlockHeight: BigInt(lastValidBlockHeight),
    });

    const signature = await connection.sendTransaction(tx);
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });

    const [multisig] = await findMultisigPda({ createKey: createKey.publicKey }, programConfig);
    const account = await fetchMultisig(ctx.client.rpc, multisig);
    expect(account.programAddress).toBe(programConfig.programAddress);
    expect(account.data.members).toEqual([
      { key: member.toBase58(), permissions: allPermissions() },
    ]);
  });

  describe('vault transaction lifecycle driven from web3.js v3', () => {
    /** web3.js v3 has no converter, so a `TransactionInstruction` is mapped to a Kit `Instruction` by hand. */
    function toKitInstruction(ix: TransactionInstruction): Instruction {
      return {
        programAddress: ix.programId.toBase58(),
        accounts: ix.keys.map(({ pubkey, isSigner, isWritable }) => ({
          address: pubkey.toBase58(),
          role: isSigner
            ? isWritable
              ? AccountRole.WRITABLE_SIGNER
              : AccountRole.READONLY_SIGNER
            : isWritable
              ? AccountRole.WRITABLE
              : AccountRole.READONLY,
        })),
        data: ix.data,
      };
    }

    /** Sends instructions as a v0 transaction; `TransactionMessage` accepts Kit instructions as-is. */
    async function sendV0(
      payer: Keypair,
      instructions: Instruction[],
      signers: TransactionPartialSigner[] = [],
    ) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      await tx.sign([payer, ...signers], { lastValidBlockHeight: BigInt(lastValidBlockHeight) });
      const signature = await connection.sendTransaction(tx);
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
    }

    /** Sends instructions as a legacy transaction, skipping signature verification (see the known bug above). */
    async function sendLegacy(
      payer: Keypair,
      instructions: Instruction[],
      signers: TransactionPartialSigner[] = [],
    ) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({
        feePayer: payer.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(...instructions);
      await tx.sign(payer, ...signers);
      const signature = await connection.sendRawTransaction(
        await tx.serialize({ verifySignatures: false }),
      );
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
    }

    it('creates, approves and executes a SOL transfer', async () => {
      const [payer, createKey, alice, bob, executor] = await Promise.all(
        Array.from({ length: 5 }, () => Keypair.generate()),
      );
      ctx.fund(payer, 5);
      const members = [alice, bob, executor];
      const destination = (await Keypair.generate()).publicKey;
      const transactionIndex = 1n;
      const lamports = 1_000_000_000n;

      // A v3 `Keypair` implements Kit's `KeyPairSigner`, so it is passed to SDK signer inputs directly.
      await sendV0(
        payer,
        [
          await getMultisigCreateV2InstructionAsync(
            {
              treasury: ctx.treasury,
              createKey,
              creator: payer,
              configAuthority: null,
              threshold: 2,
              members: members.map((member) => ({
                key: member.publicKey,
                permissions: allPermissions(),
              })),
              timeLock: 0,
              rentCollector: null,
            },
            programConfig,
          ),
        ],
        [createKey],
      );
      const [multisig] = await findMultisigPda({ createKey: createKey.publicKey }, programConfig);
      const [vault] = await findVaultPda({ multisig, vaultIndex: 0 }, programConfig);

      const multisigInfo = await connection.getAccountInfo(new PublicKey(multisig));
      const multisigAccount = getMultisigDecoder().decode(multisigInfo!.data);
      expect(multisigAccount.threshold).toBe(2);
      expect(multisigAccount.transactionIndex).toBe(0n);
      expect(multisigAccount.members.map((m) => m.key).sort()).toEqual(
        members.map((m) => m.publicKey.toBase58()).sort(),
      );

      ctx.fund(vault, 2);
      const transfer = SystemProgram.transfer({
        fromPubkey: new PublicKey(vault),
        toPubkey: destination,
        lamports,
      });
      await sendV0(
        payer,
        [
          await buildVaultTransactionCreateInstruction(
            {
              multisig,
              creator: alice,
              rentPayer: payer,
              vaultIndex: 0,
              ephemeralSigners: 0,
              transactionIndex,
              memo: 'transfer 1 SOL',
              instructions: [toKitInstruction(transfer)],
            },
            programConfig,
          ),
          await getProposalCreateInstructionAsync(
            { multisig, creator: alice, rentPayer: payer, transactionIndex },
            programConfig,
          ),
          await getProposalApproveInstructionAsync(
            { multisig, member: alice, transactionIndex },
            programConfig,
          ),
        ],
        [alice],
      );
      await sendLegacy(
        payer,
        [
          await getProposalApproveInstructionAsync(
            { multisig, member: bob, transactionIndex },
            programConfig,
          ),
        ],
        [bob],
      );

      const [proposal] = await findProposalPda({ multisig, transactionIndex }, programConfig);
      const proposalInfo = await connection.getAccountInfo(new PublicKey(proposal));
      const approved = getProposalDecoder().decode(proposalInfo!.data);
      expect(approved.status.__kind).toBe('Approved');
      expect([...approved.approved].sort()).toEqual(
        [alice.publicKey.toBase58(), bob.publicKey.toBase58()].sort(),
      );

      const { instruction } = await buildVaultTransactionExecuteInstruction(
        { rpc: ctx.client.rpc, multisig, member: executor, transactionIndex },
        programConfig,
      );
      await sendV0(payer, [instruction], [executor]);

      expect(await connection.getBalance(destination)).toBe(lamports);
      expect(await connection.getBalance(new PublicKey(vault))).toBe(lamports);
      const executed = getProposalDecoder().decode(
        (await connection.getAccountInfo(new PublicKey(proposal)))!.data,
      );
      expect(executed.status.__kind).toBe('Executed');
    });
  });
});
