import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { SessionController } from "./session.controller";
import { AppConfigService } from "../config/app-config.service";
import { InAppNotificationRepository } from "../notifications/in-app-notification.repository";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";

describe("SessionController", () => {
  let controller: SessionController;
  let mockAppConfigService: Partial<AppConfigService>;
  let mockInAppRepo: Partial<InAppNotificationRepository>;
  let mockFeatureFlagsService: Partial<FeatureFlagsService>;

  const validPublicKey = "GAMOSFOKEYHFDGMXIEFEYBUYK3ZMFYN3PFLOTBRXFGBFGRKBKLQSLGLP";

  beforeEach(async () => {
    mockAppConfigService = {
      getBootstrapBase: jest.fn().mockReturnValue({
        network: "testnet",
        contracts: {},
        backendMetadata: {
          appVersion: "1.0.0",
          minAppVersion: "1.0.0",
          environment: "testnet",
          stellarNetwork: "testnet",
        },
      }),
      featureFlagsBootstrapJson: JSON.stringify({ "testnet.contract_writes": true }),
    };

    mockInAppRepo = {
      getUnreadCount: jest.fn().mockResolvedValue(4),
    };

    mockFeatureFlagsService = {
      listFlags: jest.fn().mockResolvedValue({
        flags: [
          { name: "testnet.contract_writes", enabled: true },
          { name: "mainnet.contract_writes", enabled: false },
        ],
        source: "store",
        storeAvailable: true,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SessionController],
      providers: [
        { provide: AppConfigService, useValue: mockAppConfigService },
        { provide: InAppNotificationRepository, useValue: mockInAppRepo },
        { provide: FeatureFlagsService, useValue: mockFeatureFlagsService },
      ],
    }).compile();

    controller = module.get<SessionController>(SessionController);
  });

  it("should return guest bootstrap data when no auth header is provided", async () => {
    const result = await controller.getSessionBootstrap(undefined);

    expect(result.accountContext).toBeNull();
    expect(result.unreadCount).toBe(0);
    expect(result.metadata.appVersion).toBe("1.0.0");
    expect(result.featureFlags["testnet.contract_writes"]).toBe(true);
    expect(mockInAppRepo.getUnreadCount).not.toHaveBeenCalled();
  });

  it("should return authenticated bootstrap data with unreadCount when valid Bearer token provided", async () => {
    const result = await controller.getSessionBootstrap(`Bearer ${validPublicKey}`);

    expect(result.accountContext).toEqual({ publicKey: validPublicKey });
    expect(result.unreadCount).toBe(4);
    expect(mockInAppRepo.getUnreadCount).toHaveBeenCalledWith(validPublicKey);
  });

  it("should throw UnauthorizedException when auth header does not start with Bearer", async () => {
    await expect(controller.getSessionBootstrap(`Basic ${validPublicKey}`)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("should throw UnauthorizedException when public key format is invalid", async () => {
    await expect(controller.getSessionBootstrap("Bearer NOT_A_VALID_KEY")).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
