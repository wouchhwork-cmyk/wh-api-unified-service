import { Module } from '@nestjs/common';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { PostRepository } from '@/database/repositories/post.repository';
import { CommentProjectorService } from './comment-projector.service';
import { DirectMessageProjectorService } from './direct-message-projector.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { PostProjectorService } from './post-projector.service';

const PROVIDERS = [
  InboxService,
  CommentProjectorService,
  DirectMessageProjectorService,
  PostProjectorService,
  ConversationRepository,
  MessageRepository,
  CustomerRepository,
  PostRepository,
  OutboundEventRepository,
  ChannelRepository,
];

/**
 * The inbox: reading conversations, replying, and the projectors that turn
 * ledger events into those conversations.
 *
 * The projectors are exported because the worker process runs them — the same
 * code, in a process that serves no traffic.
 */
@Module({
  controllers: [InboxController],
  providers: PROVIDERS,
  exports: [
    InboxService,
    CommentProjectorService,
    DirectMessageProjectorService,
    PostProjectorService,
    ConversationRepository,
    MessageRepository,
    CustomerRepository,
  ],
})
export class InboxModule {}
