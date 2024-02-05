# Proof of concept for Venus TWAP vulnerability

## Details
This is a fork of https://github.com/VenusProtocol/oracle with additioanal tests to show TWAP window vulnerability.


## Installing

```

yarn install

```

## Run vulnerability proof of concept


```sh
$ npx hardhat test test/PivotTwapOracleBug.ts
```