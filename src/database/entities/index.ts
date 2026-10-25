/**
 * Every entity, listed explicitly.
 *
 * NOT a glob: TypeORM resolves a glob at runtime and requires the matched files
 * itself, which bypasses the build's transform. Under the test runner that means
 * TypeORM tries to execute raw TypeScript and fails on the first type
 * annotation; in a bundled context the glob matches nothing at all. An explicit
 * list is compiler-checked and works everywhere.
 */

import { AuditLog } from './audit-log.entity';
import { EntityVersion } from './entity-version.entity';
import { Channel } from './channel.entity';
import { Conversation } from './conversation.entity';
import { CustomerEngagement } from './customer-engagement.entity';
import { CustomerIdentifier } from './customer-identifier.entity';
import { Customer } from './customer.entity';
import { EnterpriseFeature } from './enterprise-feature.entity';
import { EnterpriseEmployee } from './enterprise-employee.entity';
import { Enterprise } from './enterprise.entity';
import { Feature } from './feature.entity';
import { Identity } from './identity.entity';
import { InboundEvent } from './inbound-event.entity';
import { EmployeeRole } from './employee-role.entity';
import { ProviderApiUsage } from './provider-api-usage.entity';
import { MessageAttachment } from './message-attachment.entity';
import { Message } from './message.entity';
import { OauthState } from './oauth-state.entity';
import { OutboundEvent } from './outbound-event.entity';
import { Permission } from './permission.entity';
import { Post } from './post.entity';
import { ProviderConnection } from './provider-connection.entity';
import { RolePermission } from './role-permission.entity';
import { Role } from './role.entity';
import { Session } from './session.entity';
import { StaffMember } from './staff-member.entity';
import { StaffRole } from './staff-role.entity';
import { SyncJob } from './sync-job.entity';
import { Verification } from './verification.entity';
import { RewardProgram } from './reward-program.entity';
import { RewardRule } from './reward-rule.entity';
import { RewardRuleBenefit } from './reward-rule-benefit.entity';
import { RewardRuleCondition } from './reward-rule-condition.entity';
import { RewardAward } from './reward-award.entity';
import { RewardAwardBenefit } from './reward-award-benefit.entity';
import { RewardCapCounter } from './reward-cap-counter.entity';
import { RewardWallet } from './reward-wallet.entity';
import { RewardLedgerEntry } from './reward-ledger-entry.entity';
import { RewardEntitlement } from './reward-entitlement.entity';

export { BaseEntity, PublicEntity } from './base.entity';
export { AuditLog } from './audit-log.entity';
export { EntityVersion } from './entity-version.entity';
export { Channel } from './channel.entity';
export { Conversation } from './conversation.entity';
export { CustomerEngagement } from './customer-engagement.entity';
export { CustomerIdentifier } from './customer-identifier.entity';
export { Customer } from './customer.entity';
export { EnterpriseFeature } from './enterprise-feature.entity';
export { EnterpriseEmployee } from './enterprise-employee.entity';
export { Enterprise } from './enterprise.entity';
export { Feature } from './feature.entity';
export { Identity } from './identity.entity';
export { InboundEvent } from './inbound-event.entity';
export { EmployeeRole } from './employee-role.entity';
export { ProviderApiUsage } from './provider-api-usage.entity';
export { MessageAttachment } from './message-attachment.entity';
export { Message } from './message.entity';
export { OauthState } from './oauth-state.entity';
export { OutboundEvent } from './outbound-event.entity';
export { Permission } from './permission.entity';
export { Post } from './post.entity';
export { ProviderConnection } from './provider-connection.entity';
export { RolePermission } from './role-permission.entity';
export { Role } from './role.entity';
export { Session } from './session.entity';
export { StaffMember } from './staff-member.entity';
export { StaffRole } from './staff-role.entity';
export { SyncJob } from './sync-job.entity';
export { Verification } from './verification.entity';
export { RewardProgram } from './reward-program.entity';
export { RewardRule } from './reward-rule.entity';
export { RewardRuleBenefit } from './reward-rule-benefit.entity';
export { RewardRuleCondition } from './reward-rule-condition.entity';
export { RewardAward } from './reward-award.entity';
export { RewardAwardBenefit } from './reward-award-benefit.entity';
export { RewardCapCounter } from './reward-cap-counter.entity';
export { RewardWallet } from './reward-wallet.entity';
export { RewardLedgerEntry } from './reward-ledger-entry.entity';
export { RewardEntitlement } from './reward-entitlement.entity';

/** The array TypeORM is configured with. */
export const ENTITIES = [
  AuditLog,
  Channel,
  Conversation,
  CustomerEngagement,
  CustomerIdentifier,
  Customer,
  EnterpriseFeature,
  EnterpriseEmployee,
  Enterprise,
  Feature,
  Identity,
  InboundEvent,
  EmployeeRole,
  ProviderApiUsage,
  MessageAttachment,
  Message,
  OauthState,
  OutboundEvent,
  Permission,
  Post,
  ProviderConnection,
  RolePermission,
  Role,
  Session,
  StaffMember,
  StaffRole,
  SyncJob,
  Verification,
  RewardProgram,
  RewardRule,
  RewardRuleBenefit,
  RewardRuleCondition,
  RewardAward,
  RewardAwardBenefit,
  RewardCapCounter,
  RewardWallet,
  RewardLedgerEntry,
  RewardEntitlement,
  EntityVersion,
];
