import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  HttpCode,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags, ApiHeader } from "@nestjs/swagger";
import { AppConfigService } from "../config/app-config.service";
import { InAppNotificationRepository } from "../notifications/in-app-notification.repository";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { SessionBootstrapResponseDto } from "./dto/session-bootstrap.dto";

@ApiTags("session")
@Controller("session")
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

  constructor(
    private readonly appConfigService: AppConfigService,
    private readonly featureFlagsService: FeatureFlagsService,
    @Optional() private readonly inAppRepo?: InAppNotificationRepository,
  ) {}

  @Get("bootstrap")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Mobile session bootstrap",
    description:
      "Returns runtime configuration, feature flags, unread notifications count, and account context for mobile clients.",
  })
  @ApiHeader({
    name: "authorization",
    required: false,
    description: "Bearer <StellarPublicKey> for authenticated wallet sessions",
  })
  @ApiResponse({
    status: 200,
    description: "Successful session bootstrap payload",
    type: SessionBootstrapResponseDto,
  })
  async getSessionBootstrap(
    @Headers("authorization") authHeader?: string,
  ): Promise<SessionBootstrapResponseDto> {
    let publicKey: string | null = null;
    let unreadCount = 0;

    if (authHeader) {
      if (!authHeader.startsWith("Bearer ")) {
        throw new UnauthorizedException("Invalid authorization header format");
      }
      const token = authHeader.slice(7).trim();
      if (!/^G[A-Z2-7]{55}$/.test(token)) {
        throw new UnauthorizedException("Invalid Stellar public key format");
      }
      publicKey = token;
      if (this.inAppRepo) {
        try {
          unreadCount = await this.inAppRepo.getUnreadCount(publicKey);
        } catch (err) {
          this.logger.warn(
            `Could not fetch unread count for ${publicKey.slice(0, 8)}: ${(err as Error).message}`,
          );
          unreadCount = 0;
        }
      }
    }

    const base = this.appConfigService.getBootstrapBase();
    let featureFlagsRecord: Record<string, boolean> = {};

    try {
      const allFlags = await this.featureFlagsService.listFlags();
      if (allFlags?.flags) {
        for (const flag of allFlags.flags) {
          featureFlagsRecord[flag.name ?? flag.key] = flag.enabled;
        }
      }
    } catch {
      const flagsJson = this.appConfigService.featureFlagsBootstrapJson;
      if (flagsJson) {
        try {
          featureFlagsRecord = JSON.parse(flagsJson);
        } catch {
          // ignore parsing error
        }
      }
    }

    return {
      metadata: {
        appVersion: base.backendMetadata.appVersion,
        minAppVersion: base.backendMetadata.minAppVersion,
        environment: base.backendMetadata.environment,
        stellarNetwork: base.backendMetadata.stellarNetwork,
      },
      unreadCount,
      featureFlags: featureFlagsRecord,
      accountContext: publicKey ? { publicKey } : null,
    };
  }
}
