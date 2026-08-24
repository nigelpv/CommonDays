import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface CalendarStorageUpload {
  path: string;
  content: Uint8Array;
  contentType: string;
}

export interface CalendarStorage {
  readonly bucket: string;
  upload(file: CalendarStorageUpload): Promise<void>;
  remove(paths: string[]): Promise<void>;
}

interface SupabaseCalendarStorageOptions {
  url: string;
  secretKey: string;
  bucket: string;
  client?: SupabaseClient;
}

export class SupabaseCalendarStorage implements CalendarStorage {
  readonly bucket: string;
  private readonly client: SupabaseClient;

  constructor({ url, secretKey, bucket, client }: SupabaseCalendarStorageOptions) {
    this.bucket = bucket;
    this.client =
      client ??
      createClient(url, secretKey, {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
      });
  }

  async upload({ path, content, contentType }: CalendarStorageUpload) {
    const { error } = await this.client.storage.from(this.bucket).upload(path, content, {
      contentType,
      upsert: false,
    });

    if (error) {
      throw new Error("Supabase Storage could not save a calendar source file.", { cause: error });
    }
  }

  async remove(paths: string[]) {
    if (paths.length === 0) return;

    const { error } = await this.client.storage.from(this.bucket).remove(paths);
    if (error) {
      throw new Error("Supabase Storage could not remove calendar source files.", { cause: error });
    }
  }
}

interface StorageEnvironment {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_STORAGE_BUCKET?: string;
}

export function createCalendarStorage(environment: StorageEnvironment = process.env): CalendarStorage | null {
  const url = environment.SUPABASE_URL?.trim();
  const secretKey = environment.SUPABASE_SECRET_KEY?.trim();
  const bucket = environment.SUPABASE_STORAGE_BUCKET?.trim();
  const configuredValues = [url, secretKey, bucket].filter(Boolean);

  if (configuredValues.length === 0) return null;
  if (!url || !secretKey || !bucket) {
    throw new Error(
      "Supabase Storage configuration is incomplete. Set SUPABASE_URL, SUPABASE_SECRET_KEY, and SUPABASE_STORAGE_BUCKET together.",
    );
  }

  return new SupabaseCalendarStorage({ url, secretKey, bucket });
}
