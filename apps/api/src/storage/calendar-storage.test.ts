import { describe, expect, it } from "vitest";
import { createCalendarStorage } from "./calendar-storage.js";

describe("calendar storage configuration", () => {
  it("keeps cloud storage optional for credential-free development", () => {
    expect(createCalendarStorage({})).toBeNull();
  });

  it("fails fast when only part of the server-only configuration is present", () => {
    expect(() =>
      createCalendarStorage({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_STORAGE_BUCKET: "calendar-sources",
      }),
    ).toThrow("Supabase Storage configuration is incomplete");
  });
});
