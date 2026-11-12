import Decimal from 'decimal.js';
import { config } from './config';

const WEI_PER_SQD = new Decimal(10).pow(18);

export type FixedBudgetRule = {
  /** First reward window (by its start block) that is paid under this rule. */
  fromBlock: number;
  /** Wei. */
  budgetPerYear: Decimal;
  operatorApr: Decimal;
  delegatorApr: Decimal;
};

export function fixedBudgetRule(): FixedBudgetRule {
  const { fromBlock, budgetSqdPerMonth, operatorApr, delegatorApr } =
    config.fixedBudget;

  const rule = {
    fromBlock,
    budgetPerYear: new Decimal(budgetSqdPerMonth).mul(12).mul(WEI_PER_SQD),
    operatorApr: new Decimal(operatorApr),
    delegatorApr: new Decimal(delegatorApr),
  };

  // Every distributor must compute the same commitment, so a bad value has to
  // stop the bot instead of producing a different reward set.
  if (Number.isNaN(rule.fromBlock)) {
    throw new Error('FIXED_BUDGET_FROM_BLOCK is not a number');
  }
  for (const [name, value] of Object.entries(rule)) {
    if (value instanceof Decimal && !value.gt(0)) {
      throw new Error(`Fixed budget ${name} must be positive`);
    }
  }

  return rule;
}

export function isFixedBudgetActive(
  rule: FixedBudgetRule,
  windowStartBlock: number,
) {
  return windowStartBlock >= rule.fromBlock;
}

/**
 * The share of the target APRs that the budget can pay. Both targets are
 * scaled by the same factor, so their ratio stays fixed.
 */
export function budgetFactor(
  rule: FixedBudgetRule,
  totalBond: Decimal,
  totalDelegated: Decimal,
) {
  const costAtTargets = rule.operatorApr
    .mul(totalBond)
    .add(rule.delegatorApr.mul(totalDelegated));

  if (costAtTargets.isZero()) {
    return new Decimal(1);
  }

  return Decimal.min(1, rule.budgetPerYear.div(costAtTargets));
}
