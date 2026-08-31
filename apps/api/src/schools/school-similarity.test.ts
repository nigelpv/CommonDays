import { describe, expect, it } from "vitest";
import {
  deriveSchoolPresentation,
  normalizeSchoolName,
  rankSimilarSchools,
  schoolNameSimilarity,
} from "./school-similarity.js";

describe("school similarity", () => {
  it("normalizes punctuation, spacing, accents, and ampersands", () => {
    expect(normalizeSchoolName("  Université  of A & B, Inc. ")).toBe("universite of a and b inc");
    expect(normalizeSchoolName("東京大学（本郷）")).toBe("東京大学 本郷");
  });

  it("recognizes close full-name typos without treating unrelated schools as similar", () => {
    expect(
      schoolNameSimilarity(
        "University of California Los Angles",
        "University of California Los Angeles",
      ),
    ).toBeGreaterThan(0.9);
    expect(
      schoolNameSimilarity(
        "University of California Los Angeles",
        "New York University",
      ),
    ).toBeLessThan(0.7);
  });

  it("orders and limits similar schools", () => {
    const matches = rankSimilarSchools("University of Illinois Urbana Champaigne", [
      { id: "nyu", name: "New York University", location: "New York, New York" },
      { id: "uic", name: "University of Illinois Chicago", location: "Chicago, Illinois" },
      {
        id: "uiuc",
        name: "University of Illinois Urbana-Champaign",
        location: "Champaign, Illinois",
      },
    ]);

    expect(matches.map((match) => match.id)).toEqual(["uiuc"]);
  });

  it("derives compact presentation fields for new schools", () => {
    expect(deriveSchoolPresentation("University of California Los Angeles")).toMatchObject({
      shortName: "UCLA",
      initials: "UCL",
    });
  });
});
