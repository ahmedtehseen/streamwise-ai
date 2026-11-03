import { describe, expect, it } from "vitest";

import {
  CHUNK_OVERLAP_CHARACTERS,
  MAX_CHUNK_CHARACTERS,
  chunkProjectDocument
} from "./chunks";

describe("Project Document chunking", () => {
  it("caps long passages at 2400 characters with 300 characters of overlap and slice-accurate line locators", () => {
    const longParagraph = ["a".repeat(1_500), "b".repeat(1_500), "c".repeat(1_500)].join("\n");

    const chunks = chunkProjectDocument(`# Operations\n\n${longParagraph}`, true);

    expect(MAX_CHUNK_CHARACTERS).toBe(2_400);
    expect(CHUNK_OVERLAP_CHARACTERS).toBe(300);
    expect(chunks.map(({ startLine, endLine, text }) => ({ startLine, endLine, length: text.length }))).toEqual([
      { startLine: 3, endLine: 4, length: 2_400 },
      { startLine: 4, endLine: 5, length: 2_400 },
      { startLine: 5, endLine: 5, length: 302 }
    ]);
    expect(chunks[0].text.slice(-300)).toBe(chunks[1].text.slice(0, 300));
    expect(chunks[1].text.slice(-300)).toBe(chunks[2].text.slice(0, 300));
  });

  it("preserves heading paths and paragraph boundary line locators", () => {
    const chunks = chunkProjectDocument([
      "# Atlas",
      "",
      "First paragraph",
      "continues here.",
      "",
      "Second paragraph.",
      "",
      "## Launch",
      "",
      "Deploy on Fridays."
    ].join("\n"), true);

    expect(chunks).toEqual([
      {
        text: "First paragraph\ncontinues here.\n\nSecond paragraph.",
        headingPath: ["Atlas"],
        startLine: 3,
        endLine: 6
      },
      {
        text: "Deploy on Fridays.",
        headingPath: ["Atlas", "Launch"],
        startLine: 10,
        endLine: 10
      }
    ]);
  });
});
