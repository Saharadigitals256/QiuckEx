import { Module } from "@nestjs/common";

import { SupabaseModule } from "../supabase/supabase.module";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { MetricsModule } from "../metrics/metrics.module";
import { UsernamesController } from "./usernames.controller";
import { UsernamesService } from "./usernames.service";
import { DiscoveryCacheService } from "./cache/discovery-cache.service";
import { UsernameRankingService } from "./username-ranking.service";
import { UsernameReconciliationService } from "./username-reconciliation.service";
import { UsernameReconciliationController } from "./username-reconciliation.controller";

@Module({
  imports: [SupabaseModule, FeatureFlagsModule, MetricsModule],
  controllers: [UsernamesController, UsernameReconciliationController],
  providers: [
    UsernamesService,
    DiscoveryCacheService,
    UsernameRankingService,
    UsernameReconciliationService,
  ],
  exports: [UsernamesService, UsernameRankingService, UsernameReconciliationService],
})
export class UsernamesModule {}
