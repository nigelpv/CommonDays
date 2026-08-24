import { describe, expect, it } from "vitest";
import { addCalendarFiles } from "./calendar-upload.js";

function image(name: string) {
  return new File([name], name, { type: "image/png", lastModified: 1 });
}

function pdf(name: string) {
  return new File([name], name, { type: "application/pdf", lastModified: 1 });
}

describe("calendar file selection", () => {
  it("accepts multiple screenshots without showing a limit warning", () => {
    const result = addCalendarFiles([], [image("one.png"), image("two.png")]);
    expect(result.files).toHaveLength(2);
    expect(result.mode).toBe("screenshots");
    expect(result.error).toBe("");
  });

  it("accepts one PDF", () => {
    const result = addCalendarFiles([], [pdf("calendar.pdf")]);
    expect(result.files).toHaveLength(1);
    expect(result.mode).toBe("pdf");
  });

  it("does not allow screenshots and a PDF together", () => {
    const existing = [image("page.png")];
    const result = addCalendarFiles(existing, [pdf("calendar.pdf")]);
    expect(result.files).toEqual(existing);
    expect(result.error).toContain("not both");
  });

  it("rejects more than one PDF", () => {
    const result = addCalendarFiles([], [pdf("fall.pdf"), pdf("spring.pdf")]);
    expect(result.files).toHaveLength(0);
    expect(result.error).toContain("one PDF");
  });

  it("accepts the tenth screenshot and warns only on another attempt", () => {
    const firstNine = Array.from({ length: 9 }, (_, index) => image(`page-${index}.png`));
    const tenth = addCalendarFiles(firstNine, [image("page-9.png")]);
    expect(tenth.files).toHaveLength(10);
    expect(tenth.error).toBe("");

    const eleventh = addCalendarFiles(tenth.files, [image("page-10.png")]);
    expect(eleventh.files).toHaveLength(10);
    expect(eleventh.error).toContain("already added 10 screenshots");
  });

  it("allows another screenshot after one is removed", () => {
    const ten = Array.from({ length: 10 }, (_, index) => image(`page-${index}.png`));
    const afterRemoval = ten.slice(0, 9);
    const result = addCalendarFiles(afterRemoval, [image("replacement.png")]);
    expect(result.files).toHaveLength(10);
    expect(result.error).toBe("");
  });

  it("deduplicates identical files within one selection", () => {
    const duplicate = image("same-page.png");
    const result = addCalendarFiles([], [duplicate, duplicate]);
    expect(result.files).toHaveLength(1);
  });
});
