import ArLocal from "arlocal";
import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet";
import {
  getTag,
  LoggerFactory,
  SmartWeave,
  SmartWeaveNodeFactory,
  SmartWeaveTags,
} from "redstone-smartweave";
import { addFunds, mineBlock } from "../utils";

import {
  connect as connectTokenContract,
  deploy as deployTokenContract,
  TokenContract,
  TokenState,
} from "../../token/tests/contract";

import {
  connect as connectBundlersContract,
  deploy as deployBundlersContract,
  BundlersContract,
  State as BundlersState,
} from "../../bundlers/tests/contract";

import { connect, deploy, State, ValidatorsContract } from "./contract";

jest.setTimeout(30000);

describe("Bundlers Contract", () => {
  let accounts: { wallet: JWKInterface; address: string }[];

  let initialState: State;
  let initialBundlersContractState: BundlersState;
  let initialTokenContractState: TokenState;

  let arweave: Arweave;
  let arlocal: ArLocal;
  let smartweave: SmartWeave;
  let connections: {
    token: TokenContract;
    bundlers: BundlersContract;
    validators: ValidatorsContract;
  }[];

  let contractTxId: string;
  let bundlersContractTxId: string;
  let tokenContractTxId: string;

  beforeAll(async () => {
    // note: each tests suit (i.e. file with tests that Jest is running concurrently
    // with another files has to have ArLocal set to a different port!)
    arlocal = new ArLocal(1820, false);
    await arlocal.start();

    arweave = Arweave.init({
      host: "localhost",
      port: 1820,
      protocol: "http",
    });

    LoggerFactory.INST.logLevel("error");
    LoggerFactory.INST.logLevel("debug", "WASM:Rust");
    LoggerFactory.INST.logLevel("debug", "WasmContractHandlerApi");

    smartweave = SmartWeaveNodeFactory.memCached(arweave);

    // Create accounts, fund them and get address
    accounts = await Promise.all(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(async (_) => {
        let wallet = await arweave.wallets.generate();
        await addFunds(arweave, wallet);
        let address = await arweave.wallets.jwkToAddress(wallet);
        return {
          wallet,
          address,
        };
      })
    );

    [initialTokenContractState, tokenContractTxId] = await deployTokenContract(
      smartweave,
      accounts[0]
    );
    [initialBundlersContractState, bundlersContractTxId] =
      await deployBundlersContract(
        smartweave,
        tokenContractTxId,
        BigInt(10) ** BigInt(initialTokenContractState.decimals),
        accounts[0]
      );
    [initialState, contractTxId] = await deploy(
      smartweave,
      tokenContractTxId,
      bundlersContractTxId,
      BigInt(10) ** BigInt(initialTokenContractState.decimals),
      accounts[1]
    );
    await mineBlock(arweave);

    console.log(`Token Contract TX ID: ${tokenContractTxId}`);
    console.log(`Bundlers Contract TX ID: ${bundlersContractTxId}`);
    console.log(`Validators Contract TX ID: ${contractTxId}`);

    connections = await Promise.all(
      accounts.map(async (account) => {
        return Promise.all([
          connectTokenContract(smartweave, tokenContractTxId, account.wallet),
          connectBundlersContract(
            smartweave,
            bundlersContractTxId,
            account.wallet
          ),
          connect(smartweave, contractTxId, account.wallet),
        ]).then(([token, bundlers, validators]) => {
          return { token, bundlers, validators };
        });
      })
    );

    let decimals = await connections[0].token
      .decimals()
      .then((decimals) => BigInt(decimals));
    for (let i = 1; i < accounts.length; ++i) {
      await connections[0].token.transfer(
        accounts[i].address,
        BigInt(200) * BigInt(10) ** decimals
      );
    }
    await mineBlock(arweave);
  });

  afterAll(async () => {
    await arlocal.stop();
  });

  it("should properly deploy contract", async () => {
    const contractTx = await arweave.transactions.get(contractTxId);

    expect(contractTx).not.toBeNull();

    const contractSrcTx = await arweave.transactions.get(
      getTag(contractTx, SmartWeaveTags.CONTRACT_SRC_TX_ID)
    );
    expect(getTag(contractSrcTx, SmartWeaveTags.CONTENT_TYPE)).toEqual(
      "application/wasm"
    );
    expect(getTag(contractSrcTx, SmartWeaveTags.WASM_LANG)).toEqual("rust");
  });

  it("join should fail when allowance is not properly set", async () => {
    await connections[2].validators.join();
    await mineBlock(arweave);

    expect(await connections[2].validators.validators()).not.toEqual(
      expect.objectContaining({ [accounts[2].address]: false })
    );
  });

  it("join should succeed after approving allowance for the stake", async () => {
    let stake = await connections[2].validators
      .stake()
      .then((stake) => BigInt(stake));
    await connections[2].token.approve(contractTxId, stake);
    await mineBlock(arweave);

    await connections[2].validators.join();
    await mineBlock(arweave);

    expect(await connections[2].validators.validators()).toEqual(
      expect.objectContaining({ [accounts[2].address]: false })
    );

    // TODO: check token balances
  });

  it("leave removes validator and returns the stake", async () => {
    await connections[2].validators.leave();
    await mineBlock(arweave);

    expect(await connections[2].validators.validators()).not.toEqual(
      expect.objectContaining({ [accounts[2].address]: false })
    );

    // TODO: check token balances
  });

  it("owner can update epoch", async () => {
    let stake = await connections[2].validators
      .stake()
      .then((stake) => BigInt(stake));
    await connections[2].token.approve(contractTxId, stake);
    await mineBlock(arweave);

    await connections[2].validators.join();
    await mineBlock(arweave);

    await connections[1].validators.updateEpoch();
    await mineBlock(arweave);

    expect(await connections[1].validators.nominatedValidators()).toEqual(
      expect.objectContaining({ [accounts[2].address]: true })
    );
  });

  it("too frequent updates to epoch fails", async () => {
    await connections[2].validators.join();
    await mineBlock(arweave);

    // TODO: how to check that the tx fails?
    // currently just check the test output
  });

  it("update epoch selects 10 random validators", async () => {
    let stake = await connections[1].validators
      .stake()
      .then((stake) => BigInt(stake));

    let epoch: { seq: bigint; tx: string; height: bigint } =
      await connections[1].validators.epoch().then((epoch) => {
        return {
          seq: BigInt(epoch.seq),
          tx: epoch.tx,
          height: BigInt(epoch.height),
        };
      });

    let epochDuration = await connections[1].validators
      .epochDuration()
      .then((duration) => BigInt(duration));

    for (let i = 3; i < accounts.length; ++i) {
      await connections[i].token.approve(contractTxId, stake);
    }
    await mineBlock(arweave);

    for (let i = 3; i < accounts.length; ++i) {
      await connections[i].validators.join();
    }
    await mineBlock(arweave);

    let networkInfo = connections[1].validators.getNetworkInfo();

    let blocksNeeded = Math.max(
      0,
      Number(epoch.height + epochDuration - BigInt(networkInfo.height))
    );

    // Mine enought blocks so that withdraw should become available
    for (let i = 0; i < blocksNeeded; ++i) {
      await mineBlock(arweave);
    }

    await connections[1].validators.updateEpoch();
    await mineBlock(arweave);

    console.log(await connections[1].validators.nominatedValidators());
  });
});