import type { School } from "@commondays/shared";

export type SchoolDirectoryEntry = Omit<School, "availableYears">;

// This is directory metadata only. Calendar availability is always derived from
// published database records and must never be encoded in the school catalog.
export const schoolDirectory: SchoolDirectoryEntry[] = [
  {
    id: "uiuc",
    name: "University of Illinois Urbana-Champaign",
    shortName: "UIUC",
    location: "Champaign, Illinois",
    initials: "IL",
    color: "#6574f7",
  },
  {
    id: "berkeley",
    name: "University of California, Berkeley",
    shortName: "UC Berkeley",
    location: "Berkeley, California",
    initials: "CA",
    color: "#ff765f",
  },
  {
    id: "nyu",
    name: "New York University",
    shortName: "NYU",
    location: "New York, New York",
    initials: "NY",
    color: "#1fb09f",
  },
  {
    id: "purdue",
    name: "Purdue University",
    shortName: "Purdue",
    location: "West Lafayette, Indiana",
    initials: "IN",
    color: "#bd8c32",
  },
  {
    id: "michigan",
    name: "University of Michigan",
    shortName: "Michigan",
    location: "Ann Arbor, Michigan",
    initials: "MI",
    color: "#e3ad22",
  },
];
