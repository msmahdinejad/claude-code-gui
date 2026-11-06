// What an API failure means, in words. Shared by the retry notice, the assistant error banner and the activity log.
import { t } from "../core/i18n.js";

const STATUS = {
  400: "The request was rejected as invalid",
  401: "The sign-in or gateway key was refused",
  403: "Access was refused",
  404: "The model or endpoint was not found",
  408: "The request timed out",
  413: "The request was too large",
  429: "Rate limited",
  500: "The API failed with an internal error",
  502: "The gateway got a bad answer from the model provider",
  503: "The service is unavailable",
  504: "The gateway timed out waiting for the model provider",
  529: "The model provider is overloaded",
};

const KIND = {
  authentication_failed: "The sign-in or gateway key was refused",
  billing_error: "Billing or usage limit reached",
  rate_limit: "Rate limited",
  invalid_request: "The request was rejected as invalid",
  server_error: "The API returned a server error",
  max_output_tokens: "The reply hit the maximum output length",
  unknown: "Unknown error",
};

/** One sentence: what happened. `status` is the HTTP code (if any), `kind` the SDK's error category. */
export function describeApiFailure(status, kind) {
  const code = Number(status);
  if (STATUS[code]) return t(STATUS[code]);
  if (code >= 500) return t("The API failed on the server side");
  if (code >= 400) return t("The request was refused");
  if (KIND[kind]) return t(KIND[kind]);
  return kind ? String(kind) : t("The request failed");
}

/** Whose side the failure is on, so the reader knows whether to wait, resend or sign in. */
export function failureAdvice(status, kind) {
  const code = Number(status);
  if (code === 401 || code === 403 || kind === "authentication_failed") return t("Check your sign-in; this is not a temporary fault.");
  if (code === 429 || kind === "rate_limit") return t("You are sending too fast or over a quota; it clears by itself.");
  if (kind === "billing_error") return t("A usage limit was reached; waiting will not help.");
  if (code >= 500 || kind === "server_error") return t("This is on the gateway or the model provider, not your login or this app. It usually clears by itself; if it does not, stop and send again.");
  return "";
}

export const seconds = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
