export interface Config {
  username: string;
  password: string;
  nsHost?: string;
  nsBaseUrl?: string;
  nsSecret: string;
  interval: number;
  sgvLimit: number;
  maxRetryDuration: number;
  maxRetries: number;
  heartbeatInterval: number;
  careLinkLoginTimeout: number;
  careLinkFetchTimeout: number;
  nightscoutPreflightTimeout: number;
  nightscoutUploadTimeout: number;
  verbose: boolean;
  patientId?: string;
  countryCode: string;
  language: string;
}
