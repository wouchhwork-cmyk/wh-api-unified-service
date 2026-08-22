import { Module } from '@nestjs/common';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { GraphApiClient } from './graph/graph-api.client';
import { MetaConnectionService } from './meta-connection.service';
import { MetaWebhookController } from './meta-webhook.controller';
import { MetaWebhookService } from './meta-webhook.service';
import { OauthStateService } from './oauth-state.service';
import { PageDiscoveryService } from './page-discovery.service';
import { PROVIDER_CONNECTORS } from './provider-connector';

@Module({
  controllers: [ConnectionsController, MetaWebhookController],
  providers: [
    GraphApiClient,
    PageDiscoveryService,
    OauthStateService,
    MetaConnectionService,
    ConnectionsService,
    /*
     * THE LIST OF CONNECTABLE PLATFORMS, in one place.
     *
     * Adding TikTok means writing a connector and adding it here — not a branch
     * in the controller, and not a string the client can influence. Provider has
     * four values and exactly one is implemented, which is why asking for one of
     * the other three returns 501 rather than failing obscurely.
     */
    {
      provide: PROVIDER_CONNECTORS,
      useFactory: (meta: MetaConnectionService) => [meta],
      inject: [MetaConnectionService],
    },
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
