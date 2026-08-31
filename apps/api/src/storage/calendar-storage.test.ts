import { describe, expect, it, vi } from "vitest";
import { SupabaseCalendarStorage, createCalendarStorage } from "./calendar-storage.js";

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

  it("downloads private source bytes through the server client", async () => {
    const download = vi.fn(async () => ({
      data: new Blob([new Uint8Array([1, 2, 3])]),
      error: null,
    }));
    const client = {
      storage: {
        from: vi.fn(() => ({ download })),
      },
    };
    const storage = new SupabaseCalendarStorage({
      url: "https://example.supabase.co",
      secretKey: "server-secret",
      bucket: "calendar-sources",
      client: client as never,
    });

    await expect(storage.download("calendar/page.pdf")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(client.storage.from).toHaveBeenCalledExactlyOnceWith("calendar-sources");
    expect(download).toHaveBeenCalledExactlyOnceWith("calendar/page.pdf");
  });

  it("creates a short-lived private source link through the server client", async () => {
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: "https://example.supabase.co/storage/signed/calendar.pdf?token=secret" },
      error: null,
    }));
    const client = {
      storage: {
        from: vi.fn(() => ({ createSignedUrl })),
      },
    };
    const storage = new SupabaseCalendarStorage({
      url: "https://example.supabase.co",
      secretKey: "server-secret",
      bucket: "calendar-sources",
      client: client as never,
    });

    await expect(storage.createSignedUrl("calendar/page.pdf", 300)).resolves.toContain(
      "token=secret",
    );
    expect(client.storage.from).toHaveBeenCalledExactlyOnceWith("calendar-sources");
    expect(createSignedUrl).toHaveBeenCalledExactlyOnceWith("calendar/page.pdf", 300);
  });

  it("does not return an empty private source link", async () => {
    const client = {
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: vi.fn(async () => ({ data: null, error: new Error("unavailable") })),
        })),
      },
    };
    const storage = new SupabaseCalendarStorage({
      url: "https://example.supabase.co",
      secretKey: "server-secret",
      bucket: "calendar-sources",
      client: client as never,
    });

    await expect(storage.createSignedUrl("calendar/page.pdf", 300)).rejects.toThrow(
      "could not create a private calendar source link",
    );
  });

});
