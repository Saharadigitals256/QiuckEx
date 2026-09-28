import { Module } from "@nestjs/common";
import { SessionController } from "./session.controller";
import { NotificationsModule } from "../notifications/notifications.module";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { AppConfigModule } from "../config/config.module";

@Module({
  imports: [AppConfigModule, NotificationsModule, FeatureFlagsModule],
  controllers: [SessionController],
})
export class SessionModule {}
