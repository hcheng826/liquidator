/* eslint-disable no-continue */
/* eslint-disable no-constant-condition */
/* eslint-disable no-restricted-syntax */
import {
  Account,
  Connection,
  PublicKey,
} from '@solana/web3.js';
import _ from 'underscore';
import dotenv from 'dotenv';
import { liquidateObligation } from 'libs/actions/liquidateObligation';
import { ObligationParser } from 'models/layouts/obligation';
import {
  getCollateralBalances,
  getObligations, getReserves, getWalletTokenData, wait,
} from 'libs/utils';
import { getTokensOracleData } from 'libs/pyth';
import { calculateRefreshedObligation } from 'libs/refreshObligation';
import { redeemCollateral } from 'libs/actions/redeemCollateral';
import { readSecret } from 'libs/secret';
import { clusterUrl, getConfig } from './config';

dotenv.config();

async function runLiquidator() {
  const startTime = Date.now();
  const marketAddress = process.env.MARKET;
  if (!marketAddress) {
    throw new Error('no process.env.MARKET provided');
  }
  const config = await getConfig();
  const lendingMarkets = _.findWhere(config.markets, { address: marketAddress });
  const { reserves } = lendingMarkets;
  const connection = new Connection(clusterUrl!.endpoint, 'confirmed');
  const lendingMarketPubKey = new PublicKey(lendingMarkets.address);

  // liquidator's keypair.
  const payer = new Account(JSON.parse(readSecret('keypair')));

  console.log(`
    app: ${process.env.APP}
    lendingMarket: ${marketAddress}
    clusterUrl: ${clusterUrl!.endpoint}
    wallet: ${payer.publicKey.toBase58()}
  `);

  for (let epoch = 0; ; epoch += 1) {
    console.log(`epoch: ${epoch} - time:  ${Date.now() - startTime}`);
    const tokensOracle = await getTokensOracleData(connection, config, reserves);
    console.log('tokensOracle sample: ', tokensOracle[0]);
    console.log('tokensOracles fetched - time: ', Date.now() - startTime);

    const allObligations = await getObligations(connection, config, lendingMarketPubKey);
    console.log('obligation sample: ', allObligations[0]);
    console.log('Obligation count: ', allObligations.length, ' - time: ', Date.now() - startTime);

    const allReserves = await getReserves(connection, config, lendingMarketPubKey);
    console.log('reserve sample: ', allReserves[0]);
    console.log('Reserves count: ', allReserves.length, ' - time ', Date.now() - startTime);

    let healthyObligationCount = 0;
    for (let obligation of allObligations) {
      try {
        while (obligation) {
          const {
            borrowedValue,
            unhealthyBorrowValue,
            deposits,
            borrows,
          } = calculateRefreshedObligation(
            obligation.info,
            allReserves,
            tokensOracle,
          );

          // Do nothing if obligation is healthy
          if (borrowedValue.isLessThanOrEqualTo(unhealthyBorrowValue)) {
            // console.log(`obligation is healthy: `, obligation.account.owner);
            healthyObligationCount += 1;
            break;
          }

          console.log(
            `Obligation ${obligation.pubkey.toString()} is underwater`,
            'borrowedValue: ', borrowedValue.toString(),
            'unhealthyBorrowValue', unhealthyBorrowValue.toString(),
          );

          // select repay token that has the highest market value
          let selectedBorrow;
          borrows.forEach((borrow) => {
            if (!selectedBorrow || borrow.marketValue.gt(selectedBorrow.marketValue)) {
              selectedBorrow = borrow;
            }
          });

          // select the withdrawal collateral token with the highest market value
          let selectedDeposit;
          deposits.forEach((deposit) => {
            if (!selectedDeposit || deposit.marketValue.gt(selectedDeposit.marketValue)) {
              selectedDeposit = deposit;
            }
          });

          if (!selectedBorrow || !selectedDeposit) {
            // skip toxic obligations caused by toxic oracle data
            break;
          }

          // get wallet balance for selected borrow token
          const { balanceBase } = await getWalletTokenData(connection, config, payer, selectedBorrow.mintAddress, selectedBorrow.symbol);
          if (balanceBase === 0) {
            console.log(`insufficient ${selectedBorrow.symbol} to liquidate obligation ${obligation.pubkey.toString()}`);
            break;
          } else if (balanceBase < 0) {
            console.log(`failed to get wallet balance for ${selectedBorrow.symbol}. Potentially network error or token account does not exist in wallet`);
            break;
          }

          // Set super high liquidation amount which acts as u64::MAX as program will only liquidate max
          // 50% val of all borrowed assets.
          await liquidateObligation(
            connection,
            config,
            payer,
            balanceBase,
            selectedBorrow.symbol,
            selectedDeposit.symbol,
            lendingMarkets,
            obligation,
          );

          const postLiquidationObligation = await connection.getAccountInfo(
            new PublicKey(obligation.pubkey),
          );
          obligation = ObligationParser(obligation.pubkey, postLiquidationObligation!);
        }
      } catch (err) {
        console.error(`error liquidating ${obligation!.pubkey.toString()}: `, err);
        continue;
      }
    }

    console.log('All obligation count: ', allObligations.length, ' - time: ', Date.now() - startTime);
    console.log('Healthy obligation count: ', healthyObligationCount, ' - time: ', Date.now() - startTime);

    // check if collateral redeeming is required
    const collateralBalances = await getCollateralBalances(connection, config, payer, reserves);
    console.log('collateralBalances: ', collateralBalances);
    collateralBalances.forEach(({ balanceBase, symbol }) => {
      if (balanceBase > 0) {
        redeemCollateral(connection, config, payer, balanceBase.toString(), symbol, lendingMarkets);
      }
    });

    // Throttle to avoid rate limiter
    if (process.env.THROTTLE) {
      await wait(process.env.THROTTLE);
    }
  }
}

runLiquidator();
