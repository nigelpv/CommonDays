import { describe, expect, it, vi } from "vitest";
import {
  createResendSchoolSimilarityMailer,
  createResendSchoolSimilarityMailerFromEnv,
  type SchoolSimilarityAlert,
} from "./school-similarity-mailer.js";

const alert: SchoolSimilarityAlert = {
  id: "bc36f274-e94e-4381-b35e-2e62b33166cb",
  status: "queued",
  createdSchool: {
    id: "new-ucla",
    name: "University of California, Los <Angeles>",
    shortName: "UC Los Angeles",
    location: "Los Angeles, CA",
  },
  similarSchools: [{
    id: "ucla",
    name: "University of California, Los Angeles",
    shortName: "UCLA",
    location: "Los Angeles, CA",
    similarity: 0.986,
  }, {
    id: "uc-la",
    name: "University of California Los Angeles Extension",
    shortName: "UCLA Extension",
    location: "Los Angeles, CA",
    similarity: 0.743,
  }],
};

describe("school similarity alert mailer", () => {
  it("stays disabled unless every server-only email variable is present", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(createResendSchoolSimilarityMailerFromEnv({})).toBeNull();
    expect(createResendSchoolSimilarityMailerFromEnv({ RESEND_API_KEY: "re_test" })).toBeNull();
    expect(createResendSchoolSimilarityMailerFromEnv({
      RESEND_API_KEY: "re_test",
      ALERT_EMAIL_FROM: "Common Days <alerts@example.com>",
    })).toBeNull();
    expect(createResendSchoolSimilarityMailerFromEnv({
      RESEND_API_KEY: "re_test",
      ALERT_EMAIL_FROM: "Common Days <alerts@example.com>",
      ALERT_EMAIL_TO: "admin@example.com",
    })).not.toBeNull();
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it("sends a private, idempotent alert containing the new school and every match", async () => {
    const transport = vi.fn().mockResolvedValue({ data: { id: "email_123" }, error: null });
    const mailer = createResendSchoolSimilarityMailer({
      apiKey: "re_test",
      from: "Common Days <alerts@example.com>",
      to: "admin@example.com",
      transport,
    });

    await expect(mailer.send(alert)).resolves.toEqual({ providerMessageId: "email_123" });
    expect(transport).toHaveBeenCalledOnce();
    const [payload, options] = transport.mock.calls[0]!;
    expect(payload).toMatchObject({
      from: "Common Days <alerts@example.com>",
      to: "admin@example.com",
      subject: "Possible duplicate school: University of California, Los <Angeles>",
    });
    expect(payload.text).toContain("The addition was not blocked");
    expect(payload.text).toContain("University of California, Los Angeles");
    expect(payload.text).toContain("University of California Los Angeles Extension");
    expect(payload.html).toContain("Los &lt;Angeles&gt;");
    expect(options).toEqual({
      idempotencyKey: "school-similarity-alert/bc36f274-e94e-4381-b35e-2e62b33166cb",
    });
  });

  it("turns provider errors and missing message IDs into retryable failures", async () => {
    const providerFailure = createResendSchoolSimilarityMailer({
      apiKey: "re_test",
      from: "alerts@example.com",
      to: "admin@example.com",
      transport: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "daily quota reached" },
      }),
    });
    await expect(providerFailure.send(alert)).rejects.toThrow("daily quota reached");

    const missingId = createResendSchoolSimilarityMailer({
      apiKey: "re_test",
      from: "alerts@example.com",
      to: "admin@example.com",
      transport: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
    await expect(missingId.send(alert)).rejects.toThrow("did not return a message ID");
  });
});
