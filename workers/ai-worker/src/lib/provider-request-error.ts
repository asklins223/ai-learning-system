/** Privacy-safe provider transport error. */
export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly providerCode: string | null;
  readonly code: string;

  constructor(input: {
    provider: string;
    status: number;
    providerCode?: string | number | null;
  }) {
    super(`${input.provider} request failed with HTTP ${input.status}`);
    this.name = "ProviderRequestError";
    this.provider = input.provider;
    this.status = input.status;
    this.providerCode = input.providerCode == null
      ? null
      : String(input.providerCode).slice(0, 80);
    this.code = `provider_http_${input.status}`;
  }
}
