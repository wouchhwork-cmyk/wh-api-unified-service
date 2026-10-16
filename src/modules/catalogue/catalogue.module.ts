import { Module } from '@nestjs/common';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { PostRepository } from '@/database/repositories/post.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';

/**
 * Posts and customers: the two reads that existed as tables and repository
 * methods with nothing to call them.
 */
@Module({
  controllers: [CatalogueController],
  providers: [
    CatalogueService,
    PostRepository,
    CustomerRepository,
    ChannelRepository,
    // A post feed that finds dead preview links queues its own repair.
    SyncJobRepository,
  ],
})
export class CatalogueModule {}
