import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule, AppConfigService } from '@/config';
import { buildDataSourceOptions } from '@/database/data-source';
import { DatabaseModule } from '@/database/database.module';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { OutboundEventRepository } from '@/database/repositories/outbound-event.repository';
import { PostRepository } from '@/database/repositories/post.repository';
import { ProviderConnectionRepository } from '@/database/repositories/provider-connection.repository';
import { QueueMetricsRepository } from '@/database/repositories/queue-metrics.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { GraphApiClient } from '@/modules/connections/graph/graph-api.client';
import { InboxModule } from '@/modules/inbox/inbox.module';
import { CryptoModule } from '@/shared/crypto';
import { buildLoggerConfig } from '@/shared/logging/logger.config';
import { BackfillWorker } from './backfill.worker';
import { InboundProjectorWorker } from './inbound-projector.worker';
import { LeaseReaperWorker } from './lease-reaper.worker';
import { OutboundRelayWorker } from './outbound-relay.worker';
import { QueueGaugeWorker } from './queue-gauge.worker';
import { QueueListenerService } from './queue-listener.service';
import { SweeperWorker } from './sweeper.worker';

/**
 * The worker process.
 *
 * A SEPARATE bootstrap from the HTTP app (see main.ts here), sharing the same
 * modules and the same image: a backlog of sync jobs cannot starve the API, and
 * each scales independently. It deliberately registers no controllers — this
 * process serves no traffic.
 */
@Module({
  imports: [
    AppConfigModule,
    CryptoModule,
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => buildLoggerConfig(config),
    }),
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => buildDataSourceOptions(config.database),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    // The projectors run here; the same code the API imports, in a process that
    // serves no traffic.
    InboxModule,
  ],
  providers: [
    InboundEventRepository,
    OutboundEventRepository,
    MessageRepository,
    ChannelRepository,
    ProviderConnectionRepository,
    PostRepository,
    SyncJobRepository,
    QueueMetricsRepository,
    GraphApiClient,
    InboundProjectorWorker,
    OutboundRelayWorker,
    BackfillWorker,
    LeaseReaperWorker,
    QueueGaugeWorker,
    QueueListenerService,
    SweeperWorker,
  ],
})
export class WorkersModule {}
