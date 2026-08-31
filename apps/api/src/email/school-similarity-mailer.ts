import { Resend } from "resend";

export interface SchoolSimilarityAlertSchool {
  id: string;
  name: string;
  shortName: string;
  location: string;
}

export interface SimilarSchoolAlertMatch extends SchoolSimilarityAlertSchool {
  similarity: number;
}

export interface SchoolSimilarityAlert {
  id: string;
  status: "queued" | "sent";
  createdSchool: SchoolSimilarityAlertSchool;
  similarSchools: SimilarSchoolAlertMatch[];
}

export interface SchoolSimilarityAlertDelivery {
  providerMessageId: string;
}

export interface SchoolSimilarityAlertMailer {
  send(alert: SchoolSimilarityAlert): Promise<SchoolSimilarityAlertDelivery>;
}

export interface SchoolSimilarityMailerEnvironment {
  RESEND_API_KEY?: string;
  ALERT_EMAIL_FROM?: string;
  ALERT_EMAIL_TO?: string;
}

interface ResendEmailPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface ResendEmailResponse {
  data: { id: string } | null;
  error: { message: string } | null;
}

export type ResendEmailTransport = (
  payload: ResendEmailPayload,
  options: { idempotencyKey: string },
) => Promise<ResendEmailResponse>;

interface CreateResendSchoolSimilarityMailerOptions {
  apiKey: string;
  from: string;
  to: string;
  transport?: ResendEmailTransport;
}

function configuredValue(value: string | undefined) {
  return value?.trim() || undefined;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeSubjectValue(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
}

function similarityPercent(similarity: number) {
  const boundedSimilarity = Number.isFinite(similarity)
    ? Math.max(0, Math.min(1, similarity))
    : 0;
  return `${Math.round(boundedSimilarity * 100)}%`;
}

function textBody(alert: SchoolSimilarityAlert) {
  const matches = alert.similarSchools.map((school) =>
    `- ${school.name} (${school.location}) - ${similarityPercent(school.similarity)} similar`,
  );
  return [
    "A new school was added to Common Days even though its name resembles an existing school.",
    "The addition was not blocked. This message is only a private heads-up for the administrator.",
    "",
    "New school",
    `${alert.createdSchool.name} (${alert.createdSchool.location})`,
    "",
    "Possible existing matches",
    ...matches,
    "",
    `Alert ID: ${alert.id}`,
  ].join("\n");
}

function htmlBody(alert: SchoolSimilarityAlert) {
  const matches = alert.similarSchools.map((school) =>
    `<li><strong>${escapeHtml(school.name)}</strong> (${escapeHtml(school.location)}) - ${similarityPercent(school.similarity)} similar</li>`,
  ).join("");
  return [
    "<p>A new school was added to Common Days even though its name resembles an existing school.</p>",
    "<p><strong>The addition was not blocked.</strong> This message is only a private heads-up for the administrator.</p>",
    "<h2>New school</h2>",
    `<p><strong>${escapeHtml(alert.createdSchool.name)}</strong> (${escapeHtml(alert.createdSchool.location)})</p>`,
    "<h2>Possible existing matches</h2>",
    `<ul>${matches}</ul>`,
    `<p>Alert ID: <code>${escapeHtml(alert.id)}</code></p>`,
  ].join("");
}

export function createResendSchoolSimilarityMailer({
  apiKey,
  from,
  to,
  transport,
}: CreateResendSchoolSimilarityMailerOptions): SchoolSimilarityAlertMailer {
  const resend = transport ? null : new Resend(apiKey);
  const sendEmail: ResendEmailTransport = transport ?? (async (payload, options) =>
    resend!.emails.send(payload, options));

  return {
    async send(alert) {
      const response = await sendEmail({
        from,
        to,
        subject: `Possible duplicate school: ${safeSubjectValue(alert.createdSchool.name)}`,
        text: textBody(alert),
        html: htmlBody(alert),
      }, {
        idempotencyKey: `school-similarity-alert/${alert.id}`,
      });

      if (response.error) {
        throw new Error(`Resend could not deliver the school similarity alert: ${response.error.message}`);
      }
      if (!response.data?.id) {
        throw new Error("Resend did not return a message ID for the school similarity alert.");
      }
      return { providerMessageId: response.data.id };
    },
  };
}

export function createResendSchoolSimilarityMailerFromEnv(
  environment: SchoolSimilarityMailerEnvironment = process.env,
): SchoolSimilarityAlertMailer | null {
  const apiKey = configuredValue(environment.RESEND_API_KEY);
  const from = configuredValue(environment.ALERT_EMAIL_FROM);
  const to = configuredValue(environment.ALERT_EMAIL_TO);
  const configuredCount = [apiKey, from, to].filter(Boolean).length;
  if (configuredCount === 0) return null;
  if (!apiKey || !from || !to) {
    console.warn(
      "School similarity email is partially configured; alerts will remain queued until RESEND_API_KEY, ALERT_EMAIL_FROM, and ALERT_EMAIL_TO are all set.",
    );
    return null;
  }
  return createResendSchoolSimilarityMailer({ apiKey, from, to });
}
