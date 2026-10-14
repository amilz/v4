import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createClient,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  assertAccountExists,
  fetchEncodedAccount,
  getI64Decoder,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  isProgramError,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type AddressesByLookupTableAddress,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit';
import { surfpool } from '@solana/surfpool/kit';
import { expect } from 'vitest';
import {
  buildVaultTransactionExecuteInstruction,
  fetchMultisig,
  findMultisigPda,
  findVaultPda,
  getProposalApproveInstructionAsync,
  getProposalCreateInstructionAsync,
  getMultisigCreateV2InstructionAsync,
  getProgramConfigInitInstructionAsync,
  getSquadsMultisigErrorMessage,
  type MemberArgs,
  type SquadsMultisigError,
  allPermissions,
  createPermissions,
  Permission,
} from '../../src';

export const PROGRAM_ADDRESS = address('GyhGAqjokLwF9UXdQ2dR5Zwiup242j4mX4J1tSMKyAmD');
export const programConfig = { programAddress: PROGRAM_ADDRESS };
const SYSVAR_CLOCK_ADDRESS = address('SysvarC1ock11111111111111111111111111111111');
export const LAMPORTS_PER_SOL = 1_000_000_000;

const PROGRAM_SO_PATH = fileURLToPath(
  new URL('../../../../target/deploy/squads_multisig_program.so', import.meta.url),
);
const INITIALIZER_KEYPAIR_PATH = fileURLToPath(
  new URL('../../../../test-program-config-initializer-keypair.json', import.meta.url),
);

export type TestMembers = {
  almighty: KeyPairSigner;
  proposer: KeyPairSigner;
  voter: KeyPairSigner;
  executor: KeyPairSigner;
};

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;

export async function createTestContext({ initProgramConfig = true } = {}) {
  if (!existsSync(PROGRAM_SO_PATH)) {
    throw new Error(`Missing ${PROGRAM_SO_PATH}. Run \`pnpm build:program\` first.`);
  }

  const client = await createClient().use(surfpool());
  client.surfnet.deploy({ programId: PROGRAM_ADDRESS, soPath: PROGRAM_SO_PATH });
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc: client.rpc,
    rpcSubscriptions: client.rpcSubscriptions,
  });

  const initializer = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(INITIALIZER_KEYPAIR_PATH, 'utf8'))),
  );
  const programConfigAuthority = await generateKeyPairSigner();
  const treasury = (await generateKeyPairSigner()).address;

  function fund(target: Address | { address: Address }, sol = 1) {
    const addr = typeof target === 'string' ? target : target.address;
    client.surfnet.fundSol(addr, sol * LAMPORTS_PER_SOL);
  }

  async function buildMessage(
    instructions: readonly Instruction[],
    feePayer: TransactionSigner = client.payer,
    addressesByLookupTableAddress: AddressesByLookupTableAddress = {},
  ) {
    const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send();
    return pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => compressTransactionMessageUsingAddressLookupTables(m, addressesByLookupTableAddress),
    );
  }

  async function sendMessage(message: Awaited<ReturnType<typeof buildMessage>>) {
    const transaction = await signTransactionMessageWithSigners(message);
    assertIsSendableTransaction(transaction);
    assertIsTransactionWithBlockhashLifetime(transaction);
    await sendAndConfirm(transaction, { commitment: 'confirmed' });
    return getSignatureFromTransaction(transaction);
  }

  async function send(
    instructions: readonly Instruction[],
    feePayer?: TransactionSigner,
    addressesByLookupTableAddress?: AddressesByLookupTableAddress,
  ) {
    return sendMessage(await buildMessage(instructions, feePayer, addressesByLookupTableAddress));
  }

  async function expectProgramError(
    instructions: readonly Instruction[],
    code: SquadsMultisigError,
    feePayer?: TransactionSigner,
  ) {
    const message = await buildMessage(instructions, feePayer);
    const error = await sendMessage(message).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error, `expected ${getSquadsMultisigErrorMessage(code)}`).toBeDefined();
    let cause: unknown = error;
    while (cause && !isProgramError(cause, message, PROGRAM_ADDRESS)) {
      cause = (cause as { cause?: unknown }).cause;
    }
    expect(cause, `no custom program error in ${String(error)}`).toBeDefined();
    const actual = (cause as { context: { code: SquadsMultisigError } }).context.code;
    expect(getSquadsMultisigErrorMessage(actual)).toBe(getSquadsMultisigErrorMessage(code));
  }

  async function initProgramConfigAccount() {
    fund(initializer);
    await send([
      await getProgramConfigInitInstructionAsync(
        {
          initializer,
          authority: programConfigAuthority.address,
          multisigCreationFee: 0,
          treasury,
        },
        programConfig,
      ),
    ]);
  }

  async function generateMembers(): Promise<TestMembers> {
    const [almighty, proposer, voter, executor] = await Promise.all(
      Array.from({ length: 4 }, () => generateKeyPairSigner()),
    );
    return { almighty, proposer, voter, executor };
  }

  function memberArgs(members: TestMembers): MemberArgs[] {
    return [
      { key: members.almighty.address, permissions: allPermissions() },
      { key: members.proposer.address, permissions: createPermissions([Permission.Initiate]) },
      { key: members.voter.address, permissions: createPermissions([Permission.Vote]) },
      { key: members.executor.address, permissions: createPermissions([Permission.Execute]) },
    ];
  }

  async function createMultisig({
    members,
    threshold,
    timeLock = 0,
    configAuthority = null,
    rentCollector = null,
  }: {
    members: MemberArgs[];
    threshold: number;
    timeLock?: number;
    configAuthority?: Address | null;
    rentCollector?: Address | null;
  }) {
    const createKey = await generateKeyPairSigner();
    await send([
      await getMultisigCreateV2InstructionAsync(
        {
          treasury,
          createKey,
          creator: client.payer,
          configAuthority,
          threshold,
          members,
          timeLock,
          rentCollector,
        },
        programConfig,
      ),
    ]);
    const [multisig] = await findMultisigPda({ createKey: createKey.address }, programConfig);
    return multisig;
  }

  async function createAutonomousMultisig({ rentCollector }: { rentCollector?: Address } = {}) {
    const members = await generateMembers();
    const multisig = await createMultisig({
      members: memberArgs(members),
      threshold: 2,
      rentCollector,
    });
    const [vault] = await findVaultPda({ multisig, vaultIndex: 0 }, programConfig);
    return { members, multisig, vault };
  }

  async function proposeAndApprove(
    multisig: Address,
    members: TestMembers,
    transactionIndex: bigint,
  ) {
    return [
      await getProposalCreateInstructionAsync(
        { multisig, creator: members.proposer, rentPayer: client.payer, transactionIndex },
        programConfig,
      ),
      await getProposalApproveInstructionAsync(
        { multisig, member: members.voter, transactionIndex },
        programConfig,
      ),
      await getProposalApproveInstructionAsync(
        { multisig, member: members.almighty, transactionIndex },
        programConfig,
      ),
    ];
  }

  async function executeVaultTransaction(
    multisig: Address,
    member: TransactionSigner,
    transactionIndex: bigint,
  ) {
    const { instruction, addressesByLookupTableAddress } =
      await buildVaultTransactionExecuteInstruction(
        { rpc: client.rpc, multisig, member, transactionIndex },
        programConfig,
      );
    return send([instruction], undefined, addressesByLookupTableAddress);
  }

  async function getMultisig(multisig: Address) {
    return (await fetchMultisig(client.rpc, multisig)).data;
  }

  async function getBalance(target: Address) {
    return (await client.rpc.getBalance(target).send()).value;
  }

  async function timeTravelSeconds(seconds: number) {
    const clock = await fetchEncodedAccount(client.rpc, SYSVAR_CLOCK_ADDRESS);
    assertAccountExists(clock);
    const unixTimestamp = getI64Decoder().decode(clock.data, 32);
    client.surfnet.timeTravelToTimestamp((Number(unixTimestamp) + seconds) * 1000);
  }

  if (initProgramConfig) await initProgramConfigAccount();

  return {
    client,
    initializer,
    programConfigAuthority,
    treasury,
    fund,
    buildMessage,
    sendMessage,
    send,
    expectProgramError,
    initProgramConfigAccount,
    generateMembers,
    memberArgs,
    createMultisig,
    createAutonomousMultisig,
    proposeAndApprove,
    executeVaultTransaction,
    getMultisig,
    getBalance,
    timeTravelSeconds,
  };
}
