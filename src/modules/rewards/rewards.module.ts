import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '@/modules/audit/audit.module';
import { DatabaseModule } from '@/database/database.module';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { RewardAwardRepository } from '@/database/repositories/reward-award.repository';
import { RewardEntitlementRepository } from '@/database/repositories/reward-entitlement.repository';
import { RewardProgramRepository } from '@/database/repositories/reward-program.repository';
import { RewardRuleRepository } from '@/database/repositories/reward-rule.repository';
import { RewardWalletRepository } from '@/database/repositories/reward-wallet.repository';
import { BenefitRegistry } from './benefits/benefit.registry';
import { ConvertValueBenefit } from './benefits/convert-value.benefit';
import { GrantCurrencyBenefit } from './benefits/grant-currency.benefit';
import { GrantPointsBenefit } from './benefits/grant-points.benefit';
import { IssueEntitlementBenefit } from './benefits/issue-entitlement.benefit';
import { ConditionRegistry } from './conditions/condition.registry';
import { ContentMatchCondition } from './conditions/content-match.condition';
import { CustomerTenureCondition } from './conditions/customer-tenure.condition';
import { TimeWindowCondition } from './conditions/time-window.condition';
import { BenefitDispatcher } from './benefit-dispatcher.service';
import { ConstantOneFactorProvider, FactorEvaluator } from './factor.provider';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';
import { RuleEvaluatorService } from './rule-evaluator.service';

/**
 * Reward programs.
 *
 * `RuleEvaluatorService` is exported so projectors can call it when a customer
 * does something. Nothing else outside this module needs any of it.
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [RewardsController],
  providers: [
    // Repositories are provided per feature module, matching how the inbox
    // does it — DatabaseModule carries only the cross-cutting ones.
    RewardProgramRepository,
    RewardRuleRepository,
    RewardAwardRepository,
    RewardWalletRepository,
    RewardEntitlementRepository,
    CustomerRepository,

    RewardsService,
    RuleEvaluatorService,
    BenefitDispatcher,
    BenefitRegistry,
    ConditionRegistry,
    FactorEvaluator,
    ConstantOneFactorProvider,
    GrantPointsBenefit,
    GrantCurrencyBenefit,
    IssueEntitlementBenefit,
    ConvertValueBenefit,
    TimeWindowCondition,
    CustomerTenureCondition,
    ContentMatchCondition,
  ],
  exports: [RuleEvaluatorService],
})
export class RewardsModule implements OnModuleInit {
  constructor(
    private readonly benefits: BenefitRegistry,
    private readonly conditions: ConditionRegistry,
  ) {}

  /**
   * VALIDATED AT BOOT, not at dispatch.
   *
   * The type system guarantees a handler EXISTS for every kind; it cannot
   * guarantee the instance was injected, and a misconfigured module yields
   * undefined at runtime with the types still happy.
   *
   * Keycloak discovers that case as a RuntimeException on a live user's login,
   * with an error message written to apologise for the design. Nobody in the
   * field validates the registry at boot. This is the cheap part of being
   * better than the field: a missing handler stops the process here, not when
   * a customer earns points.
   */
  onModuleInit(): void {
    this.benefits.assertComplete();
    this.conditions.assertComplete();
  }
}
