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

  describe("token config", () => {
    describe("add single token config", () => {
      it("should revert on calling updateTwap without setting token configs", async function () {
        await expect(this.twapOracle.updateTwap(this.bnbAddr)).to.be.revertedWith("asset not exist");
      });

      it("vToken can\"t be zero & pool address can't be zero & anchorPeriod can't be 0", async function () {
        const config = {
          asset: addr0000,
          baseUnit: BigNumber.from(0),
          pancakePool: addr0000,
          isBnbBased: false,
          isReversedPool: false,
          anchorPeriod: 0,
        };
        await expect(this.twapOracle.setTokenConfig(config)).to.be.revertedWith("can't be zero address");

        config.asset = this.wBnb.address;
        await expect(this.twapOracle.setTokenConfig(config)).to.be.revertedWith("can't be zero address");

        config.pancakePool = this.simplePair.address;
        await expect(this.twapOracle.setTokenConfig(config)).to.be.revertedWith("anchor period must be positive");

        config.anchorPeriod = 100;
        await expect(this.twapOracle.setTokenConfig(config)).to.be.revertedWith(
          "base unit decimals must be same as asset decimals",
        );
        config.baseUnit = EXP_SCALE;

        // nothing happen
        await this.twapOracle.setTokenConfig(config);
      });

      it("reset token config", async function () {
        const token = await makeToken("Token", "Token");

        const config1 = {
          asset: this.wBnb.address,
          baseUnit: EXP_SCALE,
          pancakePool: this.simplePair.address,
          isBnbBased: true,
          isReversedPool: false,
          anchorPeriod: 10,
        };
        const config2 = {
          asset: await token.address,
          baseUnit: EXP_SCALE,
          pancakePool: this.simplePair.address,
          isBnbBased: false,
          isReversedPool: true,
          anchorPeriod: 100,
        };
        await this.twapOracle.setTokenConfig(config1);
        expect((await this.twapOracle.tokenConfigs(this.wBnb.address)).anchorPeriod).to.equal(10);
        await this.twapOracle.setTokenConfig(config2);
        expect((await this.twapOracle.tokenConfigs(await token.address)).anchorPeriod).to.equal(100);
      });

      it("token config added successfully & events check", async function () {
        const config = {
          asset: this.wBnb.address,
          baseUnit: EXP_SCALE,
          pancakePool: this.simplePair.address,
          isBnbBased: false,
          isReversedPool: false,
          anchorPeriod: 888,
        };
        const result = await this.twapOracle.setTokenConfig(config);
        await expect(result)
          .to.emit(this.twapOracle, "TokenConfigAdded")
          .withArgs(await this.wBnb.address, this.simplePair.address, 888);

        // starting accumulative price
        const ts = await getTime();
        const acc = Q112.mul(ts);
        await checkObservations(this.twapOracle, await this.wBnb.address, ts, acc, 0);
      });
    });

    describe("batch add token configs", () => {
      it("length check", async function () {
        await expect(this.twapOracle.setTokenConfigs([])).to.be.revertedWith("length can't be 0");
      });

      it("token config added successfully & data check", async function () {
        const config = {
          asset: this.wBnb.address,
          baseUnit: EXP_SCALE,
          pancakePool: this.simplePair.address,
          isBnbBased: false,
          isReversedPool: false,
          anchorPeriod: 888,
        };
        await this.twapOracle.setTokenConfigs([config]);
        const savedConfig = await this.twapOracle.tokenConfigs(this.wBnb.address);
        expect(savedConfig.anchorPeriod).to.equal(888);
        expect(savedConfig.asset).to.equal(this.wBnb.address);
        expect(savedConfig.pancakePool).to.equal(this.simplePair.address);
        expect(savedConfig.baseUnit).to.equal(EXP_SCALE);
      });
    });
  });

  describe("update twap", () => {
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

    it("revert if get underlying price of not existing token", async function () {
      await expect(this.twapOracle.getPrice(this.token1.address)).to.be.revertedWith("asset not exist");
    });

    it("revert if get underlying price of token has not been updated", async function () {
      await expect(this.twapOracle.getPrice(this.token0.address)).to.be.revertedWith("TWAP price must be positive");
    });

    it("twap update after multiple observations", async function () {
      const ts = await getTime();
      const acc = Q112.mul(ts);
      const price = 1;
      await checkObservations(this.twapOracle, await this.token0.address, ts, acc, 0); //
      await increaseTime(100);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1

      await increaseTime(801);
      const result = await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1
      // window changed
      const timeDelta = 801 + 100 + 1 + 1;
      await checkObservations(
        this.twapOracle,
        await this.token0.address,
        ts + timeDelta,
        acc.add(Q112.mul(timeDelta).mul(price)),
        2,
      );
      await expect(result)
        .to.emit(this.twapOracle, "TwapWindowUpdated")
        .withArgs(
          await this.token0.address,
          ts + 101,
          acc.add(Q112.mul(101)),
          ts + timeDelta,
          acc.add(Q112.mul(timeDelta)),
        );
    });

    it("should delete observation which does not fall in current window and add latest observation", async function () {
      const ts = await getTime();
      const acc = Q112.mul(ts);
      await checkObservations(this.twapOracle, await this.token0.address, ts, acc, 0);
      await increaseTime(100);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1
      await increaseTime(801);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1
      // window changed
      const firstObservation = await this.twapOracle.observations(this.token0.address, 0);
      expect(firstObservation.acc).to.be.equal(0);
      const lastObservation = await this.twapOracle.observations(this.token0.address, 2);
      expect(lastObservation.timestamp).be.closeTo(BigNumber.from(ts + 903), 1);
    });

    it("should pick last available observation if none observations are in window and also delete privious one", async function () {
      const ts = await getTime();
      const acc = Q112.mul(ts);
      await checkObservations(this.twapOracle, await this.token0.address, ts, acc, 0);
      await increaseTime(901);
      // window changed
      const firstObservation = await this.twapOracle.observations(this.token0.address, 0);
      expect(firstObservation.timestamp).to.be.equal(ts);

      const result1 = await this.twapOracle.updateTwap(this.token0.address);
      await expect(result1)
        .to.emit(this.twapOracle, "TwapWindowUpdated")
        .withArgs(await this.token0.address, ts, acc, ts + 902, acc.add(Q112.mul(902)));
      const windowStartIndex = await this.twapOracle.windowStart(this.token0.address);
      expect(windowStartIndex).to.be.equal(0);

      const secondObservation = await this.twapOracle.observations(this.token0.address, 1);
      expect(secondObservation.timestamp).to.be.equal(ts + 902);
      await increaseTime(901);
      // window changed
      await this.twapOracle.updateTwap(this.token0.address);
      const firstObservationAfter = await this.twapOracle.observations(this.token0.address, 0);
      expect(firstObservationAfter.timestamp).to.be.equal(0);
    });

    it("should add latest observation after delete observations which does not fall in current window", async function () {
      const ts = await getTime();
      const acc = Q112.mul(ts);
      await checkObservations(this.twapOracle, await this.token0.address, ts, acc, 0);
      await increaseTime(100);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1
      await increaseTime(801);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1
      // window changed
      const firstObservation = await this.twapOracle.observations(this.token0.address, 0);
      expect(firstObservation.acc).to.be.equal(0);
      const lastObservation = await this.twapOracle.observations(this.token0.address, 2);
      expect(lastObservation.timestamp).be.closeTo(BigNumber.from(ts + 903), 1);
    });

    it("should delete multiple observation and pick observation which falling under window", async function () {
      const initialTs = await getTime();
      const acc = Q112.mul(initialTs);
      await checkObservations(this.twapOracle, await this.token0.address, initialTs, acc, 0);

      const secondTs = initialTs + 100;
      await increaseTo(secondTs);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1

      const thirdTs = secondTs + 100;
      await increaseTo(thirdTs);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1

      const fourthTs = thirdTs + 100;
      await increaseTo(fourthTs);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1

      const fifthTs = fourthTs + 100;
      await increaseTo(fifthTs);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1

      const sixthTs = fifthTs + 600;
      await increaseTo(sixthTs);
      await this.twapOracle.updateTwap(this.token0.address); // timestamp + 1

      // window changed
      const firstObservation = await this.twapOracle.observations(this.token0.address, 0);
      expect(firstObservation.timestamp).to.be.equal(0);
      const secondObservation = await this.twapOracle.observations(this.token0.address, 1);
      expect(secondObservation.timestamp).to.be.equal(secondTs + 1);
      const thirdObservation = await this.twapOracle.observations(this.token0.address, 2);
      expect(thirdObservation.timestamp).to.be.equal(thirdTs + 1);
      const lastObservation = await this.twapOracle.observations(this.token0.address, 5);
      expect(lastObservation.timestamp).to.be.equal(sixthTs + 1);
    });
    it("cumulative value", async function () {
      const currentTimestamp = await getTime();
      const acc = Q112.mul(currentTimestamp);
      let cp = await this.twapOracle.currentCumulativePrice(this.tokenConfig);
      // initial acc
      expect(cp).to.equal(acc);

      await increaseTime(100);
      cp = await this.twapOracle.currentCumulativePrice(this.tokenConfig);
      // increase the time but don't update the pair
      const acc1 = acc.add(Q112.mul(100));
      expect(cp).be.closeTo(BigNumber.from(acc1), 100);

      // update the pair to update the timestamp, and test again
      await this.simplePair.update(100, 100, 100, 100); // timestamp + 1
      cp = await this.twapOracle.currentCumulativePrice(this.tokenConfig);
      const acc2 = acc1.add(Q112);
      expect(cp).to.equal(acc2);

      // change reserves, increase the time, and test again
      await increaseTime(33);
      await this.simplePair.update(200, 100, 200, 100); // timestamp + 1
      cp = await this.twapOracle.currentCumulativePrice(this.tokenConfig);
      const acc3 = acc2.add(
        Q112.mul(100)
          .div(200)
          .mul(33 + 1),
      );
      expect(cp).be.closeTo(acc3, 100);

      // change reserves, increase the time, and test again
      await increaseTime(66);
      await this.simplePair.update(100, 400, 100, 400); // timestamp + 1
      cp = await this.twapOracle.currentCumulativePrice(this.tokenConfig);
      const acc4 = acc3.add(
        Q112.mul(400)
          .div(100)
          .mul(66 + 1),
      );
      expect(cp).to.equal(acc4);
    });

    it("test reversed pair", async function () {
      // choose another token
      const reserves = await this.simplePair.getReserves();
      const lastPrice = await this.simplePair.price1CumulativeLast();

      const time = await getTime();
      const spread = Q112.mul(reserves[0]).div(Q112.mul(reserves[1]));
      let acc = spread.mul(Q112.mul(time - reserves[2]));

      const config = {
        asset: await this.token1.address,
        baseUnit: EXP_SCALE,
        pancakePool: this.simplePair.address,
        isBnbBased: false,
        isReversedPool: true,
        anchorPeriod: 900, // 15min
      };
      // initial acc
      let cp = await this.twapOracle.currentCumulativePrice(config);

      expect(cp).to.equal(acc.add(lastPrice));

      await increaseTime(100);
      cp = await this.twapOracle.currentCumulativePrice(config);
      acc = spread.mul(Q112.mul(time - reserves[2] + 100));
      expect(cp).be.closeTo(acc.add(lastPrice), 100);

      const oldPrice = await this.simplePair.price1CumulativeLast();

      const pairLastTime = (await this.simplePair.getReserves())[2];
      const deltaTime = (await getTime()) - pairLastTime + 1;

      // update the pair to update the timestamp, and test again
      await this.simplePair.update(200, 100, 200, 100); // timestamp + 1

      cp = await this.twapOracle.currentCumulativePrice(config);

      const newSpread = Q112.mul(200).div(Q112.mul(100));
      acc = newSpread.mul(Q112.mul(deltaTime));

      expect(cp).to.equal(oldPrice.add(acc));
    });

    it("twap calculation for non BNB based token", async function () {
      let ts1 = await getTime();
      await this.simplePair.update(200, 100, 100, 100);
      let [cp0, pairLastTime] = [
        await this.simplePair.price0CumulativeLast(),
        (await this.simplePair.getReserves())[2],
      ];

      await increaseTime(1000);

      let result = await this.twapOracle.updateTwap(this.token0.address);
      let ts2 = await getTime();
      let oldObservation = await this.twapOracle.observations(await this.token0.address, 0);
      let newAcc = Q112.mul(100)
        .div(200)
        .mul(ts2 - pairLastTime)
        .add(cp0);
      let oldAcc = oldObservation.acc;

      let avgPrice0 = newAcc
        .sub(oldAcc)
        .div(RATIO)
        .div(ts2 - oldObservation.timestamp.toNumber());

      await expect(result)
        .to.emit(this.twapOracle, "TwapWindowUpdated")
        .withArgs(await this.token0.address, oldObservation.timestamp, oldObservation.acc, ts2, newAcc);
      await expect(result)
        .to.emit(this.twapOracle, "AnchorPriceUpdated")
        .withArgs(await this.token0.address, avgPrice0, ts1, ts2);

      // check saved price
      let price = await this.twapOracle.getPrice(this.token0.address);
      expect(price).to.equal(avgPrice0);

      // ============= increase another 888, price change ============
      ts1 = await getTime();
      await this.simplePair.update(2000, 100, 200, 100);
      [cp0, pairLastTime] = [await this.simplePair.price0CumulativeLast(), (await this.simplePair.getReserves())[2]];

      await increaseTime(888);

      result = await this.twapOracle.updateTwap(this.token0.address);
      ts2 = await getTime();
      oldObservation = await this.twapOracle.observations(await this.token0.address, 1);
      newAcc = Q112.mul(100)
        .div(2000)
        .mul(ts2 - pairLastTime)
        .add(cp0);
      oldAcc = oldObservation.acc;
      avgPrice0 = newAcc
        .sub(oldAcc)
        .div(RATIO)
        .div(ts2 - oldObservation.timestamp.toNumber());

      // >>> No TwapWindowUpdated event emitted <<<

      // old timestamp should be the timestamp of old observation
      await expect(result)
        .to.emit(this.twapOracle, "AnchorPriceUpdated")
        .withArgs(await this.token0.address, avgPrice0, oldObservation.timestamp, ts2);

      // check saved price
      price = await this.twapOracle.getPrice(this.token0.address);
      expect(price).to.equal(avgPrice0);

      // @todo: maybe one more test - increase time no greater than anchorPeriod, nothing happen
    });

    describe("twap calculation for BNB based token", () => {
      beforeEach(async function () {
        // add bnb pair config

        const token0 = await makeToken("ETH1", "ETH1");
        const token1 = await makeToken("MATIC1", "MATIC1");
        this.tokenConfig = {
          asset: await token0.address,
          baseUnit: EXP_SCALE,
          pancakePool: this.bnbBasedPair.address,
          isBnbBased: true,
          isReversedPool: false,
          anchorPeriod: 900, // 15min
        };
        // prepare busd-bnb config
        this.bnbConfig = {
          asset: this.wBnb.address,
          baseUnit: EXP_SCALE,
          pancakePool: this.bnbPair.address,
          isBnbBased: false,
          isReversedPool: true,
          anchorPeriod: 600, // 10min
        };
        this.token0 = token0;
        this.token1 = token1;
        await this.twapOracle.setTokenConfig(this.tokenConfig);
      });
      it("if no BNB config is added, revert", async function () {
        await expect(this.twapOracle.updateTwap(this.token0.address)).to.be.revertedWith("WBNB not exist");
      });

      it("twap calculation", async function () {
        await this.twapOracle.setTokenConfig(this.bnbConfig);
        await this.bnbPair.update(1000, 100, 100, 100); // bnb: $10
        await this.bnbBasedPair.update(200, 100, 100, 100); // token: 0.5bnb

        // this only trigger bnb price update
        await increaseTime(666);

        // update bnb based pair
        let [cp0, pairLastTime] = [
          await this.bnbBasedPair.price0CumulativeLast(),
          (await this.bnbBasedPair.getReserves())[2],
        ];

        await this.twapOracle.updateTwap(this.token0.address);
        let oldObservation = await this.twapOracle.observations(await this.token0.address, 0);

        // get bnb price here, after token0 twap updated, during which bnb price got updated again
        let bnbPrice = await this.twapOracle.getPrice(this.bnbAddr);

        let ts2 = await getTime();
        let newAcc = Q112.mul(100)
          .div(200)
          .mul(ts2 - pairLastTime)
          .add(cp0);
        let oldAcc = oldObservation.acc;
        let avgPrice0InBnb = newAcc
          .sub(oldAcc)
          .div(RATIO)
          .div(ts2 - oldObservation.timestamp.toNumber());
        let expectedPrice = avgPrice0InBnb.mul(bnbPrice).div(EXP_SCALE);
        expect(expectedPrice).to.equal(await this.twapOracle.getPrice(this.token0.address));

        // increase time and test again
        await increaseTime(800);
        [cp0, pairLastTime] = [
          await this.bnbBasedPair.price0CumulativeLast(),
          (await this.bnbBasedPair.getReserves())[2],
        ];

        await this.twapOracle.updateTwap(this.token0.address);

        oldObservation = await this.twapOracle.observations(await this.token0.address, 1);
        bnbPrice = await this.twapOracle.getPrice(this.bnbAddr);
        ts2 = await getTime();
        newAcc = Q112.mul(100)
          .div(200)
          .mul(ts2 - pairLastTime)
          .add(cp0);
        oldAcc = oldObservation.acc;
        avgPrice0InBnb = newAcc
          .sub(oldAcc)
          .div(RATIO)
          .div(ts2 - oldObservation.timestamp.toNumber());
        expectedPrice = avgPrice0InBnb.mul(bnbPrice).div(EXP_SCALE);
        expect(expectedPrice).to.equal(await this.twapOracle.getPrice(this.token0.address));
      });
    });
  });

  describe("validation", () => {
    it("validate price", async function () {
      const token2 = await makeToken("BNB2", "BNB2");

      const validationConfig = {
        asset: await this.token1.address,
        upperBoundRatio: EXP_SCALE.mul(12).div(10),
        lowerBoundRatio: EXP_SCALE.mul(8).div(10),
      };
      await this.boundValidator.setValidateConfigs([validationConfig]);

      // sanity check
      await expect(this.boundValidator.validatePriceWithAnchorPrice(token2.address, 100, 100)).to.be.revertedWith(
        "validation config not exist",
      );

      const tokenConfig = {
        asset: await this.token1.address,
        baseUnit: EXP_SCALE,
        pancakePool: this.simplePair.address,
        isBnbBased: false,
        isReversedPool: true,
        anchorPeriod: 900, // 15min
      };
      await this.twapOracle.setTokenConfig(tokenConfig);

      // without updateTwap the price is not written and should revert
      await expect(this.twapOracle.getPrice(this.token1.address)).to.be.revertedWith("TWAP price must be positive");

      await this.twapOracle.updateTwap(this.token1.address);

      let validateResult = await this.boundValidator.validatePriceWithAnchorPrice(
        this.token1.address,
        EXP_SCALE,
        await this.twapOracle.getPrice(this.token1.address),
      );
      expect(validateResult).to.equal(true);
      validateResult = await this.boundValidator.validatePriceWithAnchorPrice(
        this.token1.address,
        EXP_SCALE.mul(100).div(79),
        await this.twapOracle.getPrice(this.token1.address),
      );
      expect(validateResult).to.equal(false);
      validateResult = await this.boundValidator.validatePriceWithAnchorPrice(
        this.token1.address,
        EXP_SCALE.mul(100).div(121),
        await this.twapOracle.getPrice(this.token1.address),
      );
      expect(validateResult).to.equal(false);
    });
  });
});
