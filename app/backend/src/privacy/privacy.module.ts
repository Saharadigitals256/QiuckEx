import { Module } from "@nestjs/common";
import { PrivacyController } from "./privacy.controller";
import { AdminPrivacyController } from "./admin-privacy.controller";
import { PrivacyService } from "./privacy.service";
import { DeletionRequestService, InMemoryDeletionRequestRepository, SupabaseDeletionRequestRepository, DELETION_REQUEST_REPOSITORY } from "./deletion-requests/deletion-request.service";
import { RetentionService, RETENTION_DRIVER, InMemoryRetentionDriver } from "./retention/retention.service";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { ApiKeyGuard } from "../auth/guards/api-key.guard";
import { AuditModule } from "../audit/audit.module";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { MetricsModule } from "../metrics/metrics.module";
import { SupabaseModule } from "../supabase/supabase.module";
import { UsernamesModule } from "../usernames/usernames.module";

@Module({
  imports: [
    ApiKeysModule,
    AuditModule,
    FeatureFlagsModule,
    MetricsModule,
    SupabaseModule,
    UsernamesModule,
  ],
  controllers: [PrivacyController, AdminPrivacyController],
  providers: [
    PrivacyService,
    DeletionRequestService,
    RetentionService,
    {
      provide: DELETION_REQUEST_REPOSITORY,
      useClass: SupabaseDeletionRequestRepository,
    },
    {
      provide: RETENTION_DRIVER,
      useClass: InMemoryRetentionDriver,
    },
    ApiKeyGuard,
  ],
  exports: [PrivacyService, DeletionRequestService, RetentionService],
})
export class PrivacyModule {}
