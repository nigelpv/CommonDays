import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

function connect(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    prepare: false,
    max: 5,
    connect_timeout: 10,
    idle_timeout: 20,
  });

  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

export type DatabaseConnection = ReturnType<typeof connect>;

export function createDatabase(databaseUrl = process.env.DATABASE_URL): DatabaseConnection | null {
  return databaseUrl ? connect(databaseUrl) : null;
}

