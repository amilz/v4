import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AnchorIdl, rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import {
  accountValueNode,
  addPdasVisitor,
  argumentValueNode,
  arrayTypeNode,
  assertIsNode,
  booleanValueNode,
  bottomUpTransformerVisitor,
  bytesTypeNode,
  bytesValueNode,
  conditionalValueNode,
  constantPdaSeedNodeFromString,
  createFromRoot,
  definedTypeLinkNode,
  definedTypeNode,
  flattenInstructionDataArgumentsVisitor,
  instructionArgumentNode,
  type InstructionAccountUpdates,
  type InstructionArgumentUpdates,
  noneValueNode,
  numberTypeNode,
  pdaLinkNode,
  pdaNode,
  pdaSeedValueNode,
  pdaValueNode,
  prefixedCountNode,
  programNode,
  publicKeyTypeNode,
  publicKeyValueNode,
  sizePrefixTypeNode,
  structFieldTypeNode,
  structTypeNode,
  unwrapDefinedTypesVisitor,
  updateAccountsVisitor,
  updateInstructionsVisitor,
  updateProgramsVisitor,
  variablePdaSeedNode,
} from 'codama';

const PROGRAM_ADDRESS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const packageFolder = fileURLToPath(new URL('..', import.meta.url));
const idlPath = fileURLToPath(
  new URL('../../multisig/idl/squads_multisig_program.json', import.meta.url),
);
const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as AnchorIdl;

const codama = createFromRoot(rootNodeFromAnchor(idl));

codama.update(
  updateProgramsVisitor({
    squadsMultisigProgram: { name: 'squadsMultisig', publicKey: PROGRAM_ADDRESS },
  }),
);

const prefix = constantPdaSeedNodeFromString('utf8', 'multisig');
const seed = (value: string) => constantPdaSeedNodeFromString('utf8', value);

codama.update(
  addPdasVisitor({
    squadsMultisig: [
      { name: 'programConfig', seeds: [prefix, seed('program_config')] },
      {
        name: 'multisig',
        seeds: [prefix, seed('multisig'), variablePdaSeedNode('createKey', publicKeyTypeNode())],
      },
      {
        name: 'vault',
        seeds: [
          prefix,
          variablePdaSeedNode('multisig', publicKeyTypeNode()),
          seed('vault'),
          variablePdaSeedNode('vaultIndex', numberTypeNode('u8')),
        ],
      },
      {
        name: 'ephemeralSigner',
        seeds: [
          prefix,
          variablePdaSeedNode('transaction', publicKeyTypeNode()),
          seed('ephemeral_signer'),
          variablePdaSeedNode('ephemeralSignerIndex', numberTypeNode('u8')),
        ],
      },
      {
        name: 'transaction',
        seeds: [
          prefix,
          variablePdaSeedNode('multisig', publicKeyTypeNode()),
          seed('transaction'),
          variablePdaSeedNode('transactionIndex', numberTypeNode('u64')),
        ],
      },
      {
        name: 'proposal',
        seeds: [
          prefix,
          variablePdaSeedNode('multisig', publicKeyTypeNode()),
          seed('transaction'),
          variablePdaSeedNode('transactionIndex', numberTypeNode('u64')),
          seed('proposal'),
        ],
      },
      {
        name: 'batchTransaction',
        seeds: [
          prefix,
          variablePdaSeedNode('multisig', publicKeyTypeNode()),
          seed('transaction'),
          variablePdaSeedNode('batchIndex', numberTypeNode('u64')),
          seed('batch_transaction'),
          variablePdaSeedNode('transactionIndex', numberTypeNode('u32')),
        ],
      },
      {
        name: 'spendingLimit',
        seeds: [
          prefix,
          variablePdaSeedNode('multisig', publicKeyTypeNode()),
          seed('spending_limit'),
          variablePdaSeedNode('createKey', publicKeyTypeNode()),
        ],
      },
      {
        name: 'transactionBuffer',
        seeds: [
          prefix,
          variablePdaSeedNode('multisig', publicKeyTypeNode()),
          seed('transaction_buffer'),
          variablePdaSeedNode('creator', publicKeyTypeNode()),
          variablePdaSeedNode('bufferIndex', numberTypeNode('u8')),
        ],
      },
    ],
  }),
);

codama.update(
  updateAccountsVisitor({
    multisig: { pda: pdaLinkNode('multisig') },
    programConfig: { pda: pdaLinkNode('programConfig') },
    spendingLimit: { pda: pdaLinkNode('spendingLimit') },
    transactionBuffer: { pda: pdaLinkNode('transactionBuffer') },
    proposal: { pda: pdaLinkNode('proposal') },
    vaultTransaction: { pda: pdaLinkNode('transaction') },
    configTransaction: { pda: pdaLinkNode('transaction') },
    batch: { pda: pdaLinkNode('transaction') },
    vaultBatchTransaction: { pda: pdaLinkNode('batchTransaction') },
  }),
);

const compactTypes = [
  definedTypeNode({
    name: 'compactTransactionMessage',
    docs: [
      'Compact transaction message accepted by `vaultTransactionCreate`, `batchAddTransaction`',
      'and transaction buffers. Vectors use `u8` length prefixes, except instruction data (`u16`).',
    ],
    type: structTypeNode([
      structFieldTypeNode({ name: 'numSigners', type: numberTypeNode('u8') }),
      structFieldTypeNode({ name: 'numWritableSigners', type: numberTypeNode('u8') }),
      structFieldTypeNode({ name: 'numWritableNonSigners', type: numberTypeNode('u8') }),
      structFieldTypeNode({
        name: 'accountKeys',
        type: arrayTypeNode(publicKeyTypeNode(), prefixedCountNode(numberTypeNode('u8'))),
      }),
      structFieldTypeNode({
        name: 'instructions',
        type: arrayTypeNode(
          definedTypeLinkNode('compactCompiledInstruction'),
          prefixedCountNode(numberTypeNode('u8')),
        ),
      }),
      structFieldTypeNode({
        name: 'addressTableLookups',
        type: arrayTypeNode(
          definedTypeLinkNode('compactMessageAddressTableLookup'),
          prefixedCountNode(numberTypeNode('u8')),
        ),
      }),
    ]),
  }),
  definedTypeNode({
    name: 'compactCompiledInstruction',
    type: structTypeNode([
      structFieldTypeNode({ name: 'programIdIndex', type: numberTypeNode('u8') }),
      structFieldTypeNode({
        name: 'accountIndexes',
        type: arrayTypeNode(numberTypeNode('u8'), prefixedCountNode(numberTypeNode('u8'))),
      }),
      structFieldTypeNode({
        name: 'data',
        type: sizePrefixTypeNode(bytesTypeNode(), numberTypeNode('u16')),
      }),
    ]),
  }),
  definedTypeNode({
    name: 'compactMessageAddressTableLookup',
    type: structTypeNode([
      structFieldTypeNode({ name: 'accountKey', type: publicKeyTypeNode() }),
      structFieldTypeNode({
        name: 'writableIndexes',
        type: arrayTypeNode(numberTypeNode('u8'), prefixedCountNode(numberTypeNode('u8'))),
      }),
      structFieldTypeNode({
        name: 'readonlyIndexes',
        type: arrayTypeNode(numberTypeNode('u8'), prefixedCountNode(numberTypeNode('u8'))),
      }),
    ]),
  }),
];

codama.update(
  bottomUpTransformerVisitor([
    {
      select: '[programNode]squadsMultisig',
      transform: (node) => {
        assertIsNode(node, 'programNode');
        return programNode({
          ...node,
          definedTypes: [...(node.definedTypes ?? []), ...compactTypes],
        });
      },
    },
  ]),
);

codama.update(unwrapDefinedTypesVisitor(['proposalVoteArgs', 'vaultTransactionCreateArgs']));
codama.update(flattenInstructionDataArgumentsVisitor());

codama.update(
  bottomUpTransformerVisitor([
    {
      select: '[instructionArgumentNode]memo',
      transform: (node) => {
        assertIsNode(node, 'instructionArgumentNode');
        return instructionArgumentNode({ ...node, defaultValue: noneValueNode() });
      },
    },
  ]),
);

const multisigSeed = pdaSeedValueNode('multisig', accountValueNode('multisig'));

const programConfigPda = pdaValueNode('programConfig', []);

const transactionPda = (indexArgument: string) =>
  pdaValueNode('transaction', [
    multisigSeed,
    pdaSeedValueNode('transactionIndex', argumentValueNode(indexArgument)),
  ]);

const proposalPda = (indexArgument: string) =>
  pdaValueNode('proposal', [
    multisigSeed,
    pdaSeedValueNode('transactionIndex', argumentValueNode(indexArgument)),
  ]);

const batchTransactionPda = pdaValueNode('batchTransaction', [
  multisigSeed,
  pdaSeedValueNode('batchIndex', argumentValueNode('batchIndex')),
  pdaSeedValueNode('transactionIndex', argumentValueNode('transactionIndex')),
]);

const transactionBufferPda = pdaValueNode('transactionBuffer', [
  multisigSeed,
  pdaSeedValueNode('creator', accountValueNode('creator')),
  pdaSeedValueNode('bufferIndex', argumentValueNode('bufferIndex')),
]);

const systemProgram = publicKeyValueNode(SYSTEM_PROGRAM_ADDRESS, 'systemProgram');

const transactionIndexArgument = {
  type: numberTypeNode('u64'),
  docs: ['Index of the multisig transaction, used to derive PDAs.'],
};
const batchIndexArgument = {
  type: numberTypeNode('u64'),
  docs: ['Index of the batch within the multisig transactions, used to derive PDAs.'],
};
const batchTransactionIndexArgument = {
  type: numberTypeNode('u32'),
  docs: ['Index of the transaction within the batch, used to derive PDAs.'],
};
const bufferIndexArgument = {
  type: numberTypeNode('u8'),
  docs: ['Index of the transaction buffer, used to derive its PDA.'],
};

const rentPayerFromCreator: InstructionAccountUpdates = {
  rentPayer: { defaultValue: accountValueNode('creator') },
};

const configAuthorityUpdates: InstructionAccountUpdates = {
  systemProgram: { defaultValue: systemProgram },
};

const proposalVoteUpdates = {
  accounts: { proposal: { defaultValue: proposalPda('transactionIndex') } },
  arguments: { transactionIndex: transactionIndexArgument } as InstructionArgumentUpdates,
};

const transactionAndProposalUpdates = {
  accounts: {
    proposal: { defaultValue: proposalPda('transactionIndex') },
    transaction: { defaultValue: transactionPda('transactionIndex') },
  },
  arguments: { transactionIndex: transactionIndexArgument } as InstructionArgumentUpdates,
};

const associatedTokenPda = (owner: string) =>
  conditionalValueNode({
    condition: accountValueNode('mint'),
    ifTrue: pdaValueNode(
      pdaNode({
        name: 'associatedToken',
        programId: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        seeds: [
          variablePdaSeedNode('owner', publicKeyTypeNode()),
          variablePdaSeedNode('tokenProgram', publicKeyTypeNode()),
          variablePdaSeedNode('mint', publicKeyTypeNode()),
        ],
      }),
      [
        pdaSeedValueNode('owner', accountValueNode(owner)),
        pdaSeedValueNode('tokenProgram', accountValueNode('tokenProgram')),
        pdaSeedValueNode('mint', accountValueNode('mint')),
      ],
    ),
  });

codama.update(
  updateInstructionsVisitor({
    programConfigInit: { accounts: { programConfig: { defaultValue: programConfigPda } } },
    programConfigSetAuthority: { accounts: { programConfig: { defaultValue: programConfigPda } } },
    programConfigSetMultisigCreationFee: {
      accounts: { programConfig: { defaultValue: programConfigPda } },
    },
    programConfigSetTreasury: { accounts: { programConfig: { defaultValue: programConfigPda } } },
    multisigCreate: { accounts: { null: { defaultValue: systemProgram } } },
    multisigCreateV2: {
      accounts: {
        programConfig: { defaultValue: programConfigPda },
        multisig: {
          defaultValue: pdaValueNode('multisig', [
            pdaSeedValueNode('createKey', accountValueNode('createKey')),
          ]),
        },
      },
    },
    multisigAddMember: { accounts: configAuthorityUpdates },
    multisigRemoveMember: { accounts: configAuthorityUpdates },
    multisigSetTimeLock: { accounts: configAuthorityUpdates },
    multisigChangeThreshold: { accounts: configAuthorityUpdates },
    multisigSetConfigAuthority: {
      accounts: configAuthorityUpdates,
      arguments: { configAuthority: { name: 'newConfigAuthority' } },
    },
    multisigSetRentCollector: { accounts: configAuthorityUpdates },
    multisigAddSpendingLimit: {
      accounts: {
        spendingLimit: {
          defaultValue: pdaValueNode('spendingLimit', [
            multisigSeed,
            pdaSeedValueNode('createKey', argumentValueNode('createKey')),
          ]),
        },
      },
    },
    configTransactionCreate: {
      accounts: {
        ...rentPayerFromCreator,
        transaction: { defaultValue: transactionPda('transactionIndex') },
      },
      arguments: { transactionIndex: transactionIndexArgument },
    },
    configTransactionExecute: {
      accounts: {
        ...transactionAndProposalUpdates.accounts,
        systemProgram: { defaultValue: systemProgram },
      },
      arguments: transactionAndProposalUpdates.arguments,
    },
    vaultTransactionCreate: {
      accounts: {
        ...rentPayerFromCreator,
        transaction: { defaultValue: transactionPda('transactionIndex') },
      },
      arguments: { transactionIndex: transactionIndexArgument },
    },
    transactionBufferCreate: {
      accounts: {
        ...rentPayerFromCreator,
        transactionBuffer: { defaultValue: transactionBufferPda },
      },
    },
    transactionBufferClose: {
      accounts: { transactionBuffer: { defaultValue: transactionBufferPda } },
      arguments: { bufferIndex: bufferIndexArgument },
    },
    transactionBufferExtend: {
      accounts: { transactionBuffer: { defaultValue: transactionBufferPda } },
      arguments: { bufferIndex: bufferIndexArgument },
    },
    vaultTransactionCreateFromBuffer: {
      accounts: {
        vaultTransactionCreateMultisig: { name: 'multisig' },
        vaultTransactionCreateTransaction: {
          name: 'transaction',
          defaultValue: transactionPda('transactionIndex'),
        },
        vaultTransactionCreateCreator: { name: 'creator' },
        vaultTransactionCreateRentPayer: {
          name: 'rentPayer',
          defaultValue: accountValueNode('creator'),
        },
        vaultTransactionCreateSystemProgram: { name: 'systemProgram', defaultValue: systemProgram },
        transactionBuffer: { defaultValue: transactionBufferPda },
        creator: { name: 'bufferCreator', defaultValue: accountValueNode('creator') },
      },
      arguments: {
        transactionMessage: {
          defaultValue: bytesValueNode('base16', '000000000000'),
          defaultValueStrategy: 'omitted',
        },
        transactionIndex: transactionIndexArgument,
        bufferIndex: bufferIndexArgument,
      },
    },
    vaultTransactionExecute: transactionAndProposalUpdates,
    batchCreate: {
      accounts: { ...rentPayerFromCreator, batch: { defaultValue: transactionPda('batchIndex') } },
      arguments: { batchIndex: batchIndexArgument },
    },
    batchAddTransaction: {
      accounts: {
        proposal: { defaultValue: proposalPda('batchIndex') },
        batch: { defaultValue: transactionPda('batchIndex') },
        transaction: { defaultValue: batchTransactionPda },
        rentPayer: { defaultValue: accountValueNode('member') },
      },
      arguments: {
        batchIndex: batchIndexArgument,
        transactionIndex: batchTransactionIndexArgument,
      },
    },
    batchExecuteTransaction: {
      accounts: {
        proposal: { defaultValue: proposalPda('batchIndex') },
        batch: { defaultValue: transactionPda('batchIndex') },
        transaction: { defaultValue: batchTransactionPda },
      },
      arguments: {
        batchIndex: batchIndexArgument,
        transactionIndex: batchTransactionIndexArgument,
      },
    },
    proposalCreate: {
      accounts: {
        ...rentPayerFromCreator,
        proposal: { defaultValue: proposalPda('transactionIndex') },
      },
      arguments: { draft: { defaultValue: booleanValueNode(false) } },
    },
    proposalActivate: proposalVoteUpdates,
    proposalApprove: proposalVoteUpdates,
    proposalReject: proposalVoteUpdates,
    proposalCancel: proposalVoteUpdates,
    proposalCancelV2: proposalVoteUpdates,
    spendingLimitUse: {
      accounts: {
        vault: {
          defaultValue: pdaValueNode('vault', [
            multisigSeed,
            pdaSeedValueNode('vaultIndex', argumentValueNode('vaultIndex')),
          ]),
        },
        systemProgram: { defaultValue: systemProgram },
        tokenProgram: {
          defaultValue: conditionalValueNode({
            condition: accountValueNode('mint'),
            ifTrue: publicKeyValueNode(TOKEN_PROGRAM_ADDRESS, 'tokenProgram'),
          }),
        },
        vaultTokenAccount: { defaultValue: associatedTokenPda('vault') },
        destinationTokenAccount: { defaultValue: associatedTokenPda('destination') },
      },
      arguments: {
        vaultIndex: {
          type: numberTypeNode('u8'),
          docs: ['Index of the vault the spending limit applies to, used to derive the vault PDA.'],
        },
      },
    },
    configTransactionAccountsClose: transactionAndProposalUpdates,
    vaultTransactionAccountsClose: transactionAndProposalUpdates,
    vaultBatchTransactionAccountClose: {
      accounts: {
        proposal: { defaultValue: proposalPda('batchIndex') },
        batch: { defaultValue: transactionPda('batchIndex') },
        transaction: { defaultValue: batchTransactionPda },
      },
      arguments: {
        batchIndex: batchIndexArgument,
        transactionIndex: batchTransactionIndexArgument,
      },
    },
    batchAccountsClose: {
      accounts: {
        proposal: { defaultValue: proposalPda('batchIndex') },
        batch: { defaultValue: transactionPda('batchIndex') },
      },
      arguments: { batchIndex: batchIndexArgument },
    },
  }),
);

await codama.accept(
  renderVisitor(packageFolder, {
    kitImportStrategy: 'rootOnly',
    syncPackageJson: false,
  }),
);
