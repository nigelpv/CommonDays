export function getAcademicYearDateWindow(academicYear: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(academicYear);
  if (!match) throw new Error("The academic year must use YYYY-YY format.");

  const startYear = Number(match[1]);
  const statedEndYear = Number(match[2]);
  if (statedEndYear !== (startYear + 1) % 100) {
    throw new Error("The academic year must contain two sequential years.");
  }

  // The product does not assume a Northern-Hemisphere semester cadence.
  // Only source-backed free intervals can become available inside this broad
  // two-calendar-year envelope, so widening it cannot invent free days.
  return {
    startDate: `${String(startYear).padStart(4, "0")}-01-01`,
    endDate: `${String(startYear + 1).padStart(4, "0")}-12-31`,
  };
}
