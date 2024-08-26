const {
  Raydium,
  fetchMultipleInfo,
  PoolUtils,
  TxVersion,
  TickUtils,
} = require("@raydium-io/raydium-sdk-v2")
const web3 = require("@solana/web3.js")
const splToken = require("@solana/spl-token")
require("dotenv").config()
const bs58 = require("bs58")
const BN = require("bn.js")
const { default: Decimal } = require("decimal.js")

const connection = new web3.Connection(process.env.SOLANA_RPC_URL)
const owner = web3.Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))

const swapClmm = async (tokenAddressA, tokenAddressB, amount) => {
  const raydium = await Raydium.load({
    owner,
    connection,
    cluster: "mainnet",
    disableFeatureCheck: true,
  })

  const mintInfoA = await splToken.getMint(
    connection,
    new web3.PublicKey(tokenAddressA)
  )

  const mintInfoB = await splToken.getMint(
    connection,
    new web3.PublicKey(tokenAddressB)
  )

  const poolDatas = await raydium.api.fetchPoolByMints({
    mint1: mintInfoA.address,
    mint2: mintInfoB.address,
  })

  const poolData = poolDatas.data.find((item) => item.type === "Concentrated")

  if (!poolData) {
    throw new Error("No clmm pool data found")
  }

  const poolInfo = await PoolUtils.fetchComputeClmmInfo({
    connection: raydium.connection,
    poolInfo: poolData,
  })

  const tickCache = await PoolUtils.fetchMultiplePoolTickArrays({
    connection: raydium.connection,
    poolKeys: [poolInfo],
  })

  const parsedAmount = amount * Math.pow(10, mintInfoA.decimals)

  const { minAmountOut, remainingAccounts } =
    await PoolUtils.computeAmountOutFormat({
      poolInfo: poolInfo,
      tickArrayCache: tickCache[poolInfo.id.toBase58()],
      amountIn: new BN(parsedAmount),
      tokenOut: poolInfo.mintB,
      slippage: 0.01,
      epochInfo: await raydium.fetchEpochInfo(),
    })

  const { execute } = await raydium.clmm.swap({
    poolInfo: poolData,
    inputMint: poolInfo.mintA.address,
    amountIn: new BN(parsedAmount),
    amountOutMin: minAmountOut.amount.raw,
    observationId: poolInfo.observationId,
    ownerInfo: {},
    remainingAccounts,
    txVersion: TxVersion.V0,
  })

  const { txId } = await execute()

  console.log(txId)
}

const swapAmm = async (tokenAddressA, tokenAddressB, amount) => {
  const raydium = await Raydium.load({
    owner,
    connection,
    cluster: "mainnet",
    disableFeatureCheck: true,
  })

  const mintInfoA = await splToken.getMint(
    connection,
    new web3.PublicKey(tokenAddressA)
  )

  const mintInfoB = await splToken.getMint(
    connection,
    new web3.PublicKey(tokenAddressB)
  )

  const poolDatas = await raydium.api.fetchPoolByMints({
    mint1: mintInfoA.address,
    mint2: mintInfoB.address,
  })

  const poolData = poolDatas.data.find((item) => item.type === "Standard")

  if (!poolData) {
    throw new Error("No amm pool data found")
  }
  const poolKeys = await raydium.liquidity.getAmmPoolKeys(poolData.id)

  const poolInfo = (
    await fetchMultipleInfo({
      connection: raydium.connection,
      poolKeysList: [poolKeys],
      config: undefined,
    })
  )[0]

  await raydium.liquidity.initLayout()

  const parsedAmount = amount * Math.pow(10, mintInfoA.decimals)

  const out = raydium.liquidity.computeAmountOut({
    poolInfo: {
      ...poolData,
      baseReserve: poolInfo.baseReserve,
      quoteReserve: poolInfo.quoteReserve,
    },
    amountIn: new BN(parsedAmount),
    mintIn: poolData.mintA.address,
    mintOut: poolData.mintB.address,
    slippage: 0.01,
  })

  const { execute } = await raydium.liquidity.swap({
    poolInfo: poolData,
    amountIn: new BN(parsedAmount),
    amountOut: out.amountOut,
    fixedSide: "in",
    inputMint: poolData.mintA.address,
    associatedOnly: false,
    txVersion: TxVersion.V0,
  })

  const { txId } = await execute()

  console.log(txId)
}

const createNewPosition = async (
  poolAddress,
  tokenAddressA,
  tokenAddressB,
  SOLToInvestAmount,
  depth
) => {
  const parsedAmount = web3.LAMPORTS_PER_SOL * SOLToInvestAmount

  const raydium = await Raydium.load({
    owner,
    connection,
    cluster: "mainnet",
    disableFeatureCheck: true,
  })

  const poolData = await raydium.api.fetchPoolById({ ids: poolAddress })

  const poolInfo = await PoolUtils.fetchComputeClmmInfo({
    connection: raydium.connection,
    poolInfo: poolData[0],
  })
  const tickCache = await PoolUtils.fetchMultiplePoolTickArrays({
    connection: raydium.connection,
    poolKeys: [poolInfo],
  })

  const { minAmountOut, remainingAccounts } =
    await PoolUtils.computeAmountOutFormat({
      poolInfo: poolInfo,
      tickArrayCache: tickCache[poolAddress],
      amountIn: new BN(parsedAmount / 2),
      tokenOut: poolInfo.mintB,
      slippage: 0.01,
      epochInfo: await raydium.fetchEpochInfo(),
    })

  const { execute } = await raydium.clmm.swap({
    poolInfo: poolData[0],
    inputMint: poolInfo.mintA.address,
    amountIn: new BN(parsedAmount / 2),
    amountOutMin: minAmountOut.amount.raw,
    observationId: poolInfo.observationId,
    ownerInfo: {},
    remainingAccounts,
    txVersion: TxVersion.V0,
  })

  const { txId } = await execute()

  console.log(txId)

  const [startPrice, endPrice] = [
    (poolData[0].price * (100 - depth)) / 100,
    (poolData[0].price * (100 + depth)) / 100,
  ]

  const { tick: lowerTick } = TickUtils.getPriceAndTick({
    poolInfo: poolData[0],
    price: new Decimal(startPrice),
    baseIn: true,
  })

  const { tick: upperTick } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(endPrice),
    baseIn: true,
  })

  const res = await PoolUtils.getLiquidityAmountOutFromAmountIn({
    poolInfo: poolData[0],
    slippage: 0,
    inputA: true,
    tickUpper: Math.max(lowerTick, upperTick),
    tickLower: Math.min(lowerTick, upperTick),
    amount: new BN(
      new Decimal(parsedAmount / 2 || "0")
        .mul(10 ** poolData[0].mintA.decimals)
        .toFixed(0)
    ),
    add: true,
    amountHasFee: true,
    epochInfo: await raydium.fetchEpochInfo(),
  })

  const { execute: createExecute } = await raydium.clmm.openPositionFromBase({
    poolInfo: poolData[0],
    tickUpper: Math.max(lowerTick, upperTick),
    tickLower: Math.min(lowerTick, upperTick),
    base: "MintA",
    ownerInfo: {},
    baseAmount: new BN(
      new Decimal(parsedAmount / 2 || "0")
        .mul(10 ** poolData[0].mintA.decimals)
        .toFixed(0)
    ),
    otherAmountMax: res.amountSlippageB.amount,
    txVersion: TxVersion.V0,
  })

  const { txId: createTxId } = await createExecute()
}

const withdrawPosition = async (id) => {
  const data = await raydium.api.fetchPoolById({ ids: id })
  const poolInfo = data[0]
  if (!poolInfo) throw new Error("No pool data found")

  const allPosition = await raydium.clmm.getOwnerPositionInfo({
    programId: poolInfo.programId,
  })
  if (!allPosition.length) throw new Error("No position found")

  const position = allPosition.find((p) => p.poolId.toBase58() === poolInfo.id)
  if (!position) throw new Error(`No position found`)

  const { execute } = await raydium.clmm.closePosition({
    poolInfo,
    ownerPosition: position,
    txVersion: TxVersion.V0,
  })

  const { txId } = await execute()
}

const checkPosition = async (id) => {
  const data = await raydium.api.fetchPoolById({
    ids: id,
  })
  const poolInfo = data[0]
  if (!poolInfo) throw new Error("pool not found")

  const allPosition = await raydium.clmm.getOwnerPositionInfo({
    programId: poolInfo.programId,
  })
  if (!allPosition.length) throw new Error("No position found")

  const position = allPosition.find((p) => p.poolId.toBase58() === poolInfo.id)
  if (!position) throw new Error(`No position found`)

  return position
}

const doManagement = (
  poolAddress,
  tokenAddressA,
  tokenAddressB,
  SOLToInvestAmount,
  depth
) => {}

;(async () => {
  await swapAmm(
    "So11111111111111111111111111111111111111112",
    "Ak3ovnWQnAxPSFoSNCoNYJLnJtQDCKRBH4HwhWkb6hFm",
    0.001
  )
})()
