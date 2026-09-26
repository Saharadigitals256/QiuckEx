import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StellarTomlResolver } from '@stellar/stellar-sdk';
import { isIP } from 'node:net';

type AnchorToml = {
  NAME?: string;
  NETWORK_PASSPHRASE?: string;
  WEB_AUTH_ENDPOINT?: string;
  TRANSFER_SERVER_SEP0024?: string;
  KYC_SERVER?: string;
};

type Sep24OperationInfo = {
  enabled?: boolean;
  authentication_required?: boolean;
  min_amount?: string | number;
  max_amount?: string | number;
  fee_fixed?: string | number;
  fee_percent?: string | number;
  country_codes?: string[];
};

type Sep24Info = Record<string, unknown> & {
  deposit?: Record<string, Sep24OperationInfo>;
  withdraw?: Record<string, Sep24OperationInfo>;
};

type ResolvedAnchor = {
  domain: string;
  toml: AnchorToml;
  sep24Server: string;
  info: Sep24Info;
};

type Sep24Request = {
  assetCode: string;
  amount: number | string;
  userAccount: string;
  anchorDomain: string;
  signedChallenge: string;
  countryCode?: string;
  lang?: string;
};

@Injectable()
export class FiatRampsService {
  private readonly logger = new Logger(FiatRampsService.name);
  private readonly requestTimeoutMs = 10_000;

  async getAvailableAnchors(assetCode?: string, country?: string, anchorDomain?: string) {
    const configuredDomains = (process.env.FIAT_RAMP_ANCHOR_DOMAINS ?? '')
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean);
    const domains = anchorDomain
      ? [this.validateConfiguredDomain(anchorDomain)]
      : configuredDomains;

    if (domains.length === 0) {
      return { status: 'success', data: [] };
    }

    const results = await Promise.allSettled(
      domains.map(async (domain) => this.discoverAnchor(domain, assetCode, country)),
    );
    const anchors = results.flatMap((result) =>
      result.status === 'fulfilled' && result.value ? [result.value] : [],
    );

    if (anchors.length === 0 && results.some((result) => result.status === 'rejected')) {
      throw new BadGatewayException('Anchor discovery failed for all configured anchors');
    }

    return { status: 'success', data: anchors };
  }

  async getSep10Challenge(anchorDomain: string, userAccount: string) {
    this.validateAccount(userAccount);
    const anchor = await this.resolveAnchor(anchorDomain);
    if (!anchor.toml.NETWORK_PASSPHRASE) {
      throw new BadGatewayException('Anchor Stellar TOML is missing NETWORK_PASSPHRASE');
    }
    const authEndpoint = this.requireHttpsEndpoint(anchor.toml.WEB_AUTH_ENDPOINT, 'SEP-10 web auth');
    const challengeUrl = new URL(authEndpoint);
    challengeUrl.searchParams.set('account', userAccount);

    const response = await this.fetchJson<{ transaction?: unknown }>(challengeUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (typeof response.transaction !== 'string' || response.transaction.length === 0) {
      throw new BadGatewayException('Anchor returned an invalid SEP-10 challenge');
    }

    return {
      status: 'success',
      anchorDomain: anchor.domain,
      transaction: response.transaction,
      networkPassphrase: anchor.toml.NETWORK_PASSPHRASE,
    };
  }

  async initiateDeposit(depositDto: Sep24Request) {
    return this.initiateTransfer('deposit', depositDto);
  }

  async initiateWithdrawal(withdrawalDto: Sep24Request) {
    return this.initiateTransfer('withdraw', withdrawalDto);
  }

  async getKycStatus(params: {
    anchorDomain: string;
    userAccount: string;
    signedChallenge: string;
    customerId?: string;
  }) {
    this.validateSignedChallenge(params.signedChallenge);
    const anchor = await this.resolveAnchor(params.anchorDomain);
    const kycServer = this.requireHttpsEndpoint(anchor.toml.KYC_SERVER, 'SEP-12 KYC server');
    const token = await this.authenticate(anchor, params.userAccount, params.signedChallenge);
    const customerUrl = new URL(`${kycServer.replace(/\/+$/, '')}/customer`);
    if (params.customerId) customerUrl.searchParams.set('id', params.customerId);

    const response = await this.fetchJson<{ status?: unknown; id?: unknown }>(customerUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });

    return {
      status: 'success',
      customerId: typeof response.id === 'string' ? response.id : params.customerId ?? null,
      kycStatus: this.normalizeKycStatus(response.status),
    };
  }

  async handleKycCallback(_callbackData: unknown) {
    this.logger.warn('Ignoring unauthenticated anchor KYC callback; poll the anchor SEP-12 endpoint instead');
    throw new ServiceUnavailableException('Anchor callbacks are not enabled; use authenticated SEP-12 status polling');
  }

  async updateTransactionStatus(_statusData: unknown) {
    this.logger.warn('Ignoring unauthenticated anchor transaction callback; poll the SEP-24 transaction endpoint instead');
    throw new ServiceUnavailableException('Anchor callbacks are not enabled; transaction status must be queried from the anchor');
  }

  private async initiateTransfer(type: 'deposit' | 'withdraw', input: Sep24Request) {
    this.validateAccount(input.userAccount);
    this.validateSignedChallenge(input.signedChallenge);
    const amount = this.validateAmount(input.amount);
    const assetCode = input.assetCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(assetCode)) {
      throw new BadRequestException('assetCode must be a valid asset code');
    }

    const anchor = await this.resolveAnchor(input.anchorDomain);
    const operation = this.findOperation(anchor.info, type, assetCode, input.countryCode);
    if (!operation || operation.enabled === false) {
      throw new BadRequestException(`Anchor does not support ${type} for ${assetCode}`);
    }
    this.validateAmountAgainstLimits(amount, operation);

    const token = await this.authenticate(anchor, input.userAccount, input.signedChallenge);
    const transferUrl = new URL(
      `${anchor.sep24Server.replace(/\/+$/, '')}/transactions/${type}`,
    );
    const form = new URLSearchParams({
      asset_code: assetCode,
      amount,
      account: input.userAccount,
    });
    if (input.countryCode) form.set('country_code', input.countryCode.toUpperCase());
    if (input.lang) form.set('lang', input.lang);

    const response = await this.fetchJson<{ id?: unknown; type?: unknown; url?: unknown }>(transferUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });

    if (typeof response.id !== 'string' || typeof response.url !== 'string') {
      throw new BadGatewayException('Anchor returned an invalid SEP-24 transaction response');
    }
    const interactiveUrl = this.requireHttpsEndpoint(response.url, 'SEP-24 interactive URL');

    return {
      status: 'success',
      transaction_id: response.id,
      type: typeof response.type === 'string' ? response.type : 'interactive_customer_info_needed',
      url: interactiveUrl,
    };
  }

  private async discoverAnchor(domainInput: string, assetCode?: string, country?: string) {
    const anchor = await this.resolveAnchor(domainInput);
    const capabilities: Record<string, unknown> = {};
    const supportedAssets = new Set<string>();
    const requestedAsset = assetCode?.trim().toUpperCase();

    for (const [type, operations] of [
      ['deposit', anchor.info.deposit],
      ['withdraw', anchor.info.withdraw],
    ] as const) {
      for (const [assetKey, details] of Object.entries(operations ?? {})) {
        const code = assetKey.split(':', 1)[0].toUpperCase();
        if (requestedAsset && code !== requestedAsset) continue;
        const countryCodes = Array.isArray(details.country_codes)
          ? details.country_codes.map((value) => value.toUpperCase())
          : [];
        if (country && countryCodes.length > 0 && !countryCodes.includes(country.toUpperCase())) continue;
        if (details.enabled === false) continue;

        const assetCapabilities = (capabilities[code] as Record<string, unknown> | undefined) ?? {};
        assetCapabilities[type] = this.normalizeOperation(details);
        capabilities[code] = assetCapabilities;
        supportedAssets.add(code);
      }
    }

    if (requestedAsset && !supportedAssets.has(requestedAsset)) return null;

    return {
      id: anchor.domain,
      name: anchor.toml.NAME?.trim() || anchor.domain,
      domain: anchor.domain,
      supportedAssets: [...supportedAssets].sort(),
      type: 'sep24',
      capabilities,
      sep10: Boolean(anchor.toml.WEB_AUTH_ENDPOINT),
      kyc: Boolean(anchor.toml.KYC_SERVER),
    };
  }

  private async resolveAnchor(domainInput: string): Promise<ResolvedAnchor> {
    const domain = this.validateConfiguredDomain(domainInput);
    let toml: AnchorToml;
    try {
      toml = (await StellarTomlResolver.resolve(domain)) as AnchorToml;
    } catch (error) {
      this.logger.warn(`Failed to resolve Stellar TOML for ${domain}: ${this.errorMessage(error)}`);
      throw new BadGatewayException('Unable to resolve anchor Stellar TOML');
    }

    const sep24Server = this.requireHttpsEndpoint(
      toml.TRANSFER_SERVER_SEP0024,
      'SEP-24 transfer server',
    );
    const infoUrl = new URL(`${sep24Server.replace(/\/+$/, '')}/info`);
    const info = await this.fetchJson<Sep24Info>(infoUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    return { domain, toml, sep24Server, info };
  }

  private validateConfiguredDomain(domainInput: string): string {
    const domain = this.validateDomain(domainInput);
    const allowedDomains = (process.env.FIAT_RAMP_ALLOWED_ANCHOR_DOMAINS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const configuredDomains = (process.env.FIAT_RAMP_ANCHOR_DOMAINS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (![...allowedDomains, ...configuredDomains].includes(domain)) {
      throw new BadRequestException('Anchor domain is not allowlisted');
    }
    return domain;
  }

  private async authenticate(anchor: ResolvedAnchor, userAccount: string, signedChallenge: string) {
    this.validateAccount(userAccount);
    const authEndpoint = this.requireHttpsEndpoint(anchor.toml.WEB_AUTH_ENDPOINT, 'SEP-10 web auth');
    const response = await this.fetchJson<{ token?: unknown }>(authEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ transaction: signedChallenge }),
    });

    if (typeof response.token !== 'string' || response.token.length === 0) {
      throw new BadGatewayException('Anchor rejected SEP-10 authentication');
    }
    const tokenParts = response.token.split('.');
    if (tokenParts.length !== 3) {
      throw new BadGatewayException('Anchor returned an invalid SEP-10 token');
    }
    let claims: { sub?: unknown };
    try {
      claims = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString('utf8')) as { sub?: unknown };
    } catch {
      throw new BadGatewayException('Anchor returned an invalid SEP-10 token');
    }
    if (claims.sub !== userAccount) {
      throw new BadGatewayException('SEP-10 token is not bound to the requested Stellar account');
    }
    return response.token;
  }

  private findOperation(
    info: Sep24Info,
    type: 'deposit' | 'withdraw',
    assetCode: string,
    countryCode?: string,
  ): Sep24OperationInfo | null {
    const operations = info[type];
    if (!operations) return null;
    const match = Object.entries(operations).find(([key]) => key.split(':', 1)[0].toUpperCase() === assetCode);
    if (!match) return null;

    const details = match[1];
    const countries = details.country_codes?.map((value) => value.toUpperCase()) ?? [];
    if (countryCode && countries.length > 0 && !countries.includes(countryCode.toUpperCase())) return null;
    return details;
  }

  private normalizeOperation(details: Sep24OperationInfo) {
    return {
      enabled: details.enabled !== false,
      authenticationRequired: details.authentication_required === true,
      minAmount: this.normalizeDecimal(details.min_amount),
      maxAmount: this.normalizeDecimal(details.max_amount),
      feeFixed: this.normalizeDecimal(details.fee_fixed),
      feePercent: this.normalizeDecimal(details.fee_percent),
      countryCodes: details.country_codes?.map((value) => value.toUpperCase()) ?? [],
    };
  }

  private normalizeKycStatus(value: unknown): 'accepted' | 'pending' | 'needs_info' | 'rejected' | 'unknown' {
    if (typeof value !== 'string') return 'unknown';
    const status = value.toLowerCase();
    if (['accepted', 'approved', 'verified'].includes(status)) return 'accepted';
    if (['pending', 'pending_review', 'processing'].includes(status)) return 'pending';
    if (['needs_info', 'needs_more_info', 'incomplete'].includes(status)) return 'needs_info';
    if (['rejected', 'denied'].includes(status)) return 'rejected';
    return 'unknown';
  }

  private validateDomain(value: string): string {
    if (typeof value !== 'string' || value.length > 253 || value.includes('://')) {
      throw new BadRequestException('anchorDomain must be a DNS hostname');
    }
    const domain = value.trim().toLowerCase().replace(/\.$/, '');
    if (
      !domain ||
      domain === 'localhost' ||
      domain.endsWith('.localhost') ||
      domain.endsWith('.local') ||
      isIP(domain) !== 0 ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    ) {
      throw new BadRequestException('anchorDomain must be a public DNS hostname');
    }
    return domain;
  }

  private requireHttpsEndpoint(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new BadGatewayException(`Anchor is missing ${label}`);
    let endpoint: URL;
    try {
      endpoint = new URL(value);
    } catch {
      throw new BadGatewayException(`Anchor returned an invalid ${label} URL`);
    }
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.port !== '' && endpoint.port !== '443') ||
      endpoint.hostname === 'localhost' ||
      endpoint.hostname.endsWith('.local') ||
      isIP(endpoint.hostname.replace(/^\[|\]$/g, '')) !== 0
    ) {
      throw new BadGatewayException(`${label} must use a public HTTPS endpoint`);
    }
    return endpoint.toString().replace(/\/$/, '');
  }

  private validateAccount(value: string): void {
    if (typeof value !== 'string' || !/^G[A-Z2-7]{55}$/.test(value)) {
      throw new BadRequestException('userAccount must be a Stellar public key');
    }
  }

  private validateSignedChallenge(value: string): void {
    if (typeof value !== 'string' || value.length === 0 || value.length > 100_000) {
      throw new BadRequestException('signedChallenge must contain the client-signed SEP-10 transaction');
    }
  }

  private validateAmount(value: number | string): string {
    const amount = String(value);
    if (
      !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,7})?$/.test(amount) ||
      this.compareDecimals(amount, '0') <= 0
    ) {
      throw new BadRequestException('amount must be a positive decimal with at most 7 fractional digits');
    }
    return amount;
  }

  private validateAmountAgainstLimits(amount: string, operation: Sep24OperationInfo): void {
    const minimum = this.normalizeDecimal(operation.min_amount);
    const maximum = this.normalizeDecimal(operation.max_amount);
    if (minimum !== null && this.compareDecimals(amount, minimum) < 0) {
      throw new BadRequestException(`amount is below the anchor minimum of ${minimum}`);
    }
    if (maximum !== null && this.compareDecimals(amount, maximum) > 0) {
      throw new BadRequestException(`amount exceeds the anchor maximum of ${maximum}`);
    }
  }

  private compareDecimals(left: string, right: string): number {
    const [leftWhole, leftFraction = ''] = left.split('.');
    const [rightWhole, rightFraction = ''] = right.split('.');
    const normalizedLeft = leftWhole.replace(/^0+(?=\d)/, '');
    const normalizedRight = rightWhole.replace(/^0+(?=\d)/, '');
    if (normalizedLeft.length !== normalizedRight.length) {
      return normalizedLeft.length < normalizedRight.length ? -1 : 1;
    }
    if (normalizedLeft !== normalizedRight) return normalizedLeft < normalizedRight ? -1 : 1;
    const fractionLength = Math.max(leftFraction.length, rightFraction.length);
    const paddedLeft = leftFraction.padEnd(fractionLength, '0');
    const paddedRight = rightFraction.padEnd(fractionLength, '0');
    if (paddedLeft === paddedRight) return 0;
    return paddedLeft < paddedRight ? -1 : 1;
  }

  private normalizeDecimal(value: string | number | undefined): string | null {
    if (value === undefined || value === null || value === '') return null;
    const decimal = String(value);
    return /^\d+(?:\.\d+)?$/.test(decimal) ? decimal : null;
  }

  private async fetchJson<T>(url: string | URL, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      this.logger.warn(`Anchor request failed: ${this.errorMessage(error)}`);
      throw new BadGatewayException('Anchor request failed');
    }

    if (!response.ok) {
      throw new BadGatewayException(`Anchor request failed with HTTP ${response.status}`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new BadGatewayException('Anchor returned invalid JSON');
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown error';
  }
}
