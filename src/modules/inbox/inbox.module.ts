import { Module } from '@nestjs/common';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { MessageAttachmentRepository } from '@/database/repositories/message-attachment.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { PostRepository } from '@/database/repositories/post.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { AuditModule } from '@/modules/audit';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { SendReconciliationService } from './send-reconciliation.service';
import { MetaUsageCollector } from '@/modules/connections/graph/meta-usage.collector';
import { CommentProjectorService } from './comment-projector.service';
import { DirectMessageProjectorService } from './direct-message-projector.service';
import { InboxController } from './inbox.controller';
import { InboxEventsService } from './inbox-events.service';
import { InboxService } from './inbox.service';
import { PostProjectorService } from './post-projector.service';

const PROVIDERS = [
  InboxService,
  SendReconciliationService,
  InboxEventsService,
  CommentProjectorService,
  DirectMessageProjectorService,
  PostProjectorService,
  ConversationRepository,
  MessageRepository,
  MessageAttachmentRepository,
  CustomerRepository,
  PostRepository,
  OutboundEventRepository,
  ChannelRepository,
  SyncJobRepository,
  /*
   * Provided here rather than imported from ConnectionsModule, which imports
   * this module's projectors — the cycle would be real. The client is stateless
   * (config plus fetch), so a second instance costs nothing.
   */
  GraphApiClient,
  /*
   * AND ITS COLLECTOR, because a second instance costs nothing ONLY if it is
   * wired the same way.
   *
   * It was not, and the client takes its collector optionally — so this
   * instance silently had none, and every Graph call the inbox makes recorded
   * nothing: avatar refreshes, mention media, attachment recovery. On the API
   * side that is most of the Graph traffic there is. Found by making a real
   * call against the live API and watching the monitor stay empty; no test
   * caught it, because the wiring test knew about two modules and this is the
   * third.
   */
  MetaUsageCollector,
];

/**
 * The inbox: reading conversations, replying, and the projectors that turn
 * ledger events into those conversations.
 *
 * The projectors are exported because the worker process runs them — the same
 * code, in a process that serves no traffic.
 */
@Module({
  imports: [AuditModule],
  controllers: [InboxController],
  providers: PROVIDERS,
  exports: [
    InboxService,
    SendReconciliationService,
    CommentProjectorService,
    DirectMessageProjectorService,
    PostProjectorService,
    ConversationRepository,
    MessageRepository,
    MessageAttachmentRepository,
    CustomerRepository,
  ],
})
export class InboxModule {}
