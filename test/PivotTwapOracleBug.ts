import { smock } from "@defi-wonderland/smock";
import { increaseTo } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time/increaseTo";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "chai";
import { BigNumber } from "ethers";
import { ethers, upgrades } from "hardhat";

import { AccessControlManager, BoundValidator } from "../typechain-types";
import { TwapOracle } from "../typechain-types/contracts/oracles/TwapOracle";
import { addr0000 } from "./utils/data";
import { makePairWithTokens } from "./utils/makePair";
import { makeToken } from "./utils/makeToken";
import { getTime, increaseTime } from "./utils/time";

const EXP_SCALE = BigNumber.from(10).pow(18);
const Q112 = BigNumber.from(2).pow(112);
const RATIO = Q112.div(EXP_SCALE);

// helper functions
async function checkObservations(
  twapOracleContract: TwapOracle,
  token: string,
  time: number,
  acc: BigNumber,
  index: number,
) {
  // check observations
  const newObservation = await twapOracleContract.observations(token, index);
  expect(newObservation.timestamp).be.closeTo(BigNumber.from(time), 1);
  expect(newObservation.acc).be.closeTo(acc, 100);
}

describe("Twap Oracle unit tests", () => {
  beforeEach(async function () {
    const signers: SignerWithAddress[] = await ethers.getSigners();
    const admin = signers[0];
    this.signers = signers;
    this.admin = admin;
    this.vai = signers[5]; // Not your usual vToken
    this.wBnb = await makeToken("Wrapped BNB", "WBNB", 18);
    this.bnbAddr = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";

    const twapOracle = await ethers.getContractFactory("TwapOracle", admin);
    const fakeAccessControlManager = await smock.fake<AccessControlManager>("AccessControlManagerScenario");
    fakeAccessControlManager.isAllowedToCall.returns(true);

    const twapInstance = <TwapOracle>await upgrades.deployProxy(twapOracle, [fakeAccessControlManager.address], {
      constructorArgs: [this.wBnb.address],
    });
    this.twapOracle = twapInstance;

    const boundValidator = await ethers.getContractFactory("BoundValidator", admin);
    const boundValidatorInstance = <BoundValidator>await upgrades.deployProxy(
      boundValidator,
      [fakeAccessControlManager.address],
      {
        constructorArgs: [],
      },
    );
    this.boundValidator = boundValidatorInstance;

    const token1 = await makeToken("TOKEN1", "TOKEN1");
    const tokenBusd = await makeToken("BUSD1", "BUSD1", 18);
    const simplePair = await makePairWithTokens(token1.address, tokenBusd.address);
    this.simplePair = simplePair;

    // set up bnb based pair for later test
    const token3 = await makeToken("TOKEN3", "TOKEN3", 18);
    const BEP20HarnessFactory = await ethers.getContractFactory("BEP20Harness");
    const tokenWbnb = BEP20HarnessFactory.attach(await this.twapOracle.WBNB());
    const bnbBasedPair = await makePairWithTokens(token3.address, tokenWbnb.address);
    this.bnbBasedPair = bnbBasedPair;

    const bnbPair = await makePairWithTokens(tokenBusd.address, tokenWbnb.address);
    this.bnbPair = bnbPair;
    this.token1 = token1;
  });

  describe("twap update after empty anchor period without observations", () => {
    beforeEach(async function () {
      const token0 = await makeToken("ETH", "ETH");
      const token1 = await makeToken("MATIC", "MATIC");

      // this. simplePair = await makePairWithTokens(token0.address, token1.address);

      this.tokenConfig = {
        asset: await token0.address,
        baseUnit: EXP_SCALE,
        pancakePool: this.simplePair.address,
        isBnbBased: false,
        isReversedPool: false,
        anchorPeriod: 900, // 15min
      };
      this.token0 = token0;
      this.token1 = token1;
      await this.twapOracle.setTokenConfig(this.tokenConfig);
    });

    it("update twap twice inside anchor window since last observation", async function () {
      await increaseTime(100);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1
      await increaseTime(801);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1

      console.log(
        "Price before 1 block manipulation:",
        ethers.utils.formatUnits(await this.twapOracle.getPrice(this.token0.address), 18),
      );
      console.log("Waiting less than the anchor window...");
      await increaseTime(888);
      await this.simplePair.update(200, 100, 100, 100);
      await this.twapOracle.updateTwap(this.token0.address);
      await this.twapOracle.updateTwap(this.token0.address);
      console.log(
        "Price after 1 block manipulation:",
        ethers.utils.formatUnits(await this.twapOracle.getPrice(this.token0.address), 18),
      );
    });

    it("update twap twice after anchor window without observations", async function () {
      await increaseTime(100);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1
      await increaseTime(801);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1

      console.log(
        "Price before 1 block manipulation:",
        ethers.utils.formatUnits(await this.twapOracle.getPrice(this.token0.address), 18),
      );
      console.log("Waiting a bit more than the anchor window...");
      await increaseTime(901);
      await this.simplePair.update(200, 100, 100, 100);
      await this.twapOracle.updateTwap(this.token0.address);
      await this.twapOracle.updateTwap(this.token0.address);
      console.log(
        "Price after 1 block manipulation:",
        ethers.utils.formatUnits(await this.twapOracle.getPrice(this.token0.address), 18),
      );
    });
  });
});
