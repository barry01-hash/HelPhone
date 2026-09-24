import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Buffer } from 'buffer'
import {
  Transaction,
  Keypair,
  Account,
  Networks,
  BASE_FEE,
  StrKey,
  SorobanDataBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import {
  inspectFootprint,
  buildSorobanTransaction,
  clearFootprintCache,
  footprintCacheStats,
  makeFootprintArgsKey,
  summarizeFootprint,
} from '../src/lib/footprint'

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7))
const randomAddress = () => Keypair.random().publicKey()

function makeLedgerKey(keyStr) {
  const scAddress = xdr.ScAddress.scAddressTypeAccount(
    xdr.AccountId.publicKeyTypeEd25519(xdr.Uint256.fromXDR(Buffer.alloc(32))),
  )
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: scAddress,
      key: xdr.ScVal.scvString(keyStr),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )
}

function makeSim({ readOnly, readWrite, fee = '100000' }) {
  const data = new SorobanDataBuilder()
    .setReadOnly(readOnly)
    .setReadWrite(readWrite)
    .setResourceFee(fee)
    .build()
  return {
    transactionData: data.toXDR('base64'),
    minResourceFee: fee,
    error: undefined,
    results: [{ auth: [] }],
  }
}

function makeAccount() {
  return new Account(Keypair.random().publicKey(), '0')
}

describe('footprint inspection (#517)', () => {
  beforeEach(() => {
    clearFootprintCache()
  })

  afterEach(() => {
    clearFootprintCache()
  })

  it('derives a template from a simulateTransaction response', async () => {
    const sim = makeSim({
      readOnly: [makeLedgerKey('admin'), makeLedgerKey('req')],
      readWrite: [makeLedgerKey('req'), makeLedgerKey('resp')],
    })
    const template = await inspectFootprint({
      contractId: CONTRACT_ID,
      functionName: 'mark_arrived',
      args: [
        { type: 'address', value: randomAddress() },
        { type: 'u64', value: '7' },
      ],
      simulate: async () => sim,
    })

    expect(template.success).toBe(true)
    expect(template.template.readOnly).toHaveLength(2)
    expect(template.template.readWrite).toHaveLength(2)
    expect(template.template.resourceFee).toBe('100000')
    expect(template.template.contractId).toBe(CONTRACT_ID)
    expect(template.template.functionName).toBe('mark_arrived')
    expect(typeof template.template.footprintXdr).toBe('string')
    expect(template.template.footprintXdr.length).toBeGreaterThan(0)
  })

  it('returns summary without another inspection call', async () => {
    const sim = makeSim({
      readOnly: [makeLedgerKey('admin')],
      readWrite: [makeLedgerKey('req')],
    })
    const summary = await inspectFootprint({
      contractId: CONTRACT_ID,
      functionName: 'cancel_request',
      args: [
        { type: 'address', value: randomAddress() },
        { type: 'u64', value: '3' },
      ],
      simulate: async () => sim,
    }).then((r) => summarizeFootprint(r.template))

    expect(summary.readOnlyCount).toBe(1)
    expect(summary.readWriteCount).toBe(1)
    expect(summary.totalKeys).toBe(2)
    expect(summary.resourceFee).toBe('100000')
  })

  it('reuses the in-memory cache for identical calls (no second simulation)', async () => {
    let calls = 0
    const simulate = async () => {
      calls += 1
      return makeSim({
        readOnly: [makeLedgerKey('admin')],
        readWrite: [makeLedgerKey('req')],
      })
    }
    const opts = {
      contractId: CONTRACT_ID,
      functionName: 'mark_arrived',
      args: [
        { type: 'address', value: randomAddress() },
        { type: 'u64', value: '7' },
      ],
      simulate,
    }

    const first = await inspectFootprint(opts)
    const second = await inspectFootprint(opts)
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(second.fromCache).toBe(true)
    expect(calls).toBe(1)
    expect(footprintCacheStats().hits).toBeGreaterThanOrEqual(1)
  })

  it('does not reuse cache entries across different argument sets', async () => {
    let calls = 0
    const simulate = async () => {
      calls += 1
      return makeSim({
        readOnly: [makeLedgerKey('admin')],
        readWrite: [makeLedgerKey('req')],
      })
    }
    await inspectFootprint({
      contractId: CONTRACT_ID,
      functionName: 'resolve_request',
      args: [{ type: 'address', value: randomAddress() }, { type: 'u64', value: '1' }],
      simulate,
    })
    const second = await inspectFootprint({
      contractId: CONTRACT_ID,
      functionName: 'resolve_request',
      args: [{ type: 'address', value: randomAddress() }, { type: 'u64', value: '2' }],
      simulate,
    })
    expect(second.fromCache).toBe(false)
    expect(calls).toBe(2)
  })

  it('exposes a stable, order-sensitive args key', () => {
    const a = makeFootprintArgsKey([{ type: 'address', value: 'A' }, { type: 'u64', value: '1' }])
    const b = makeFootprintArgsKey([{ type: 'address', value: 'A' }, { type: 'u64', value: '1' }])
    const c = makeFootprintArgsKey([{ type: 'u64', value: '1' }, { type: 'address', value: 'A' }])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('builds an envelope with the footprint baked into sorobanData', async () => {
    const template = (
      await inspectFootprint({
        contractId: CONTRACT_ID,
        functionName: 'mark_arrived',
        args: [
          { type: 'address', value: randomAddress() },
          { type: 'u64', value: '7' },
        ],
        simulate: async () =>
          makeSim({
            readOnly: [makeLedgerKey('admin'), makeLedgerKey('req')],
            readWrite: [makeLedgerKey('req')],
          }),
      })
    ).template

    const account = makeAccount()
    const { builder, transaction } = buildSorobanTransaction({
      account,
      contractId: CONTRACT_ID,
      functionName: 'mark_arrived',
      args: [
        { type: 'address', value: randomAddress() },
        { type: 'u64', value: '7' },
      ],
      template,
    })

    expect(builder.sorobanData).not.toBeNull()
    expect(builder.sorobanData.resourceFee().toBigInt().toString()).toBe('100000')
    expect(transaction).toBeInstanceOf(Transaction)
  })

  it('builds a footprint-free envelope when no template is supplied', () => {
    const account = makeAccount()
    const { builder } = buildSorobanTransaction({
      account,
      contractId: CONTRACT_ID,
      functionName: 'mark_arrived',
      args: [
        { type: 'address', value: randomAddress() },
        { type: 'u64', value: '7' },
      ],
    })
    expect(builder.sorobanData).toBeNull()
  })

  it('propagates simulation errors as a non-success result', async () => {
    const result = await inspectFootprint({
      contractId: CONTRACT_ID,
      functionName: 'boom',
      args: [],
      simulate: async () => ({ error: 'HostError: bad', transactionData: undefined }),
    })
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })
})