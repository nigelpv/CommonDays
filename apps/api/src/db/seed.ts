import "dotenv/config";
import { schoolDirectory } from "../data.js";
import { createDatabase } from "./client.js";
import { schools as schoolTable } from "./schema.js";
const connection = createDatabase();

if (!connection) {
  throw new Error("DATABASE_URL is required to seed the database.");
}

try {
  for (const school of schoolDirectory) {
    await connection.db
      .insert(schoolTable)
      .values({
        id: school.id,
        name: school.name,
        shortName: school.shortName,
        location: school.location,
        initials: school.initials,
        color: school.color,
      })
      .onConflictDoUpdate({
        target: schoolTable.id,
        set: {
          name: school.name,
          shortName: school.shortName,
          location: school.location,
          initials: school.initials,
          color: school.color,
          updatedAt: new Date(),
        },
      });
  }

  console.log("Common Days school directory is ready.");
} finally {
  await connection.close();
}
