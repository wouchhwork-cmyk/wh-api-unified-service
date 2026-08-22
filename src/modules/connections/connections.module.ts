import { Module } from '@nestjs/common';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { ConnectionsController } from './connections.controller';
import { GraphApiClient } from './graph/graph-api.client';
import { MetaConnectionService } from './meta-connection.service';
import { MetaWebhookController } from './meta-webhook.controller';
import { MetaWebhookService } from './meta-webhook.service';
import { OauthStateService } from './oauth-state.service';
import { PageDiscoveryService } from './page-discovery.service';

@Module({
  controllers: [ConnectionsController, MetaWebhookController],
  providers: [
    GraphApiClient,
    PageDiscoveryService,
    OauthStateService,
    MetaConnectionService,
    MetaWebhookService,
    // Registered here rather than in DatabaseModule so the connection-specific
    // repositories live with the module that owns them.
    ProviderConnectionRepository,
    ChannelRepository,
    SyncJobRepository,
    InboundEventRepository,
  ],
  exports: [GraphApiClient, MetaConnectionService, ChannelRepository, InboundEventRepository],
})
export class ConnectionsModule {}
