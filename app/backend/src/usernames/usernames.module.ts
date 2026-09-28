import { Module } from "@nestjs/common";

import { SupabaseModule } from "../supabase/supabase.module";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { MetricsModule } from "../metrics/metrics.module";
import { UsernamesController } from "./usernames.controller";
import { UsernamesService } from "./usernames.service";
import { DiscoveryCacheService } from "./cache/discovery-cache.service";
import { UsernameRankingService } from "./username-ranking.service";
import { UsernameExpiryService } from "./username-expiry.service";
import {
  UsernameReservationController,
  UsernameExpiryAdminController,
} from "./username-expiry.controller";
import { UsernameReconciliationService } from "./username-reconciliation.service";
import { UsernameReconciliationController } from "./username-reconciliation.controller";

@Module({
  imports: [SupabaseModule, FeatureFlagsModule, MetricsModule],
  controllers: [
    UsernamesController,
    UsernameReservationController,
    UsernameExpiryAdminController,
    UsernameReconciliationController,
  ],
  providers: [
    UsernamesService,
    DiscoveryCacheService,
    UsernameRankingService,
    UsernameExpiryService,
    UsernameReconciliationService,
  ],
  exports: [UsernamesService, UsernameRankingService, UsernameExpiryService, UsernameReconciliationService],
})
export class UsernamesModule {}
