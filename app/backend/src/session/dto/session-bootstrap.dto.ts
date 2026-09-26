import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class SessionBackendMetadataDto {
  @ApiProperty({ example: "1.0.0" })
  appVersion!: string;

  @ApiProperty({ example: "1.0.0" })
  minAppVersion!: string;

  @ApiProperty({ example: "production" })
  environment!: string;

  @ApiProperty({ example: "mainnet" })
  stellarNetwork!: string;
}

export class SessionAccountContextDto {
  @ApiProperty({ example: "GAMOSFOKEYHFDGMXIEFEYBUYK3ZMFYN3PFLOTBRXFGBFGRKBKLQSLGLP" })
  publicKey!: string;
}

export class SessionBootstrapResponseDto {
  @ApiProperty({ type: SessionBackendMetadataDto })
  metadata!: SessionBackendMetadataDto;

  @ApiProperty({ example: 0 })
  unreadCount!: number;

  @ApiProperty({ example: { "testnet.contract_writes": true } })
  featureFlags!: Record<string, boolean>;

  @ApiPropertyOptional({ type: SessionAccountContextDto, nullable: true })
  accountContext!: SessionAccountContextDto | null;
}
