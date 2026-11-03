export const MAX_CHUNK_CHARACTERS = 2_400;
export const CHUNK_OVERLAP_CHARACTERS = 300;

export type ProjectDocumentChunk = {
  text: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
};

type Block = ProjectDocumentChunk;

function splitLongBlock(block: Block): Block[] {
  if (block.text.length <= MAX_CHUNK_CHARACTERS) return [block];

  const chunks: Block[] = [];
  let start = 0;
  while (start < block.text.length) {
    const proposedEnd = Math.min(start + MAX_CHUNK_CHARACTERS, block.text.length);
    const whitespace = proposedEnd < block.text.length ? block.text.lastIndexOf(" ", proposedEnd) : proposedEnd;
    const end = whitespace > start + CHUNK_OVERLAP_CHARACTERS ? whitespace : proposedEnd;
    chunks.push({ ...block, text: block.text.slice(start, end).trim() });
    if (end >= block.text.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARACTERS, start + 1);
  }
  return chunks;
}

function combineBlocks(blocks: Block[]): ProjectDocumentChunk[] {
  const chunks: ProjectDocumentChunk[] = [];
  let current: Block[] = [];

  const emit = () => {
    if (current.length === 0) return;
    chunks.push({
      text: current.map((block) => block.text).join("\n\n"),
      headingPath: current[0].headingPath,
      startLine: current[0].startLine,
      endLine: current[current.length - 1].endLine
    });
  };

  for (const block of blocks.flatMap(splitLongBlock)) {
    const sameHeading = current.length === 0 || current[0].headingPath.join("\0") === block.headingPath.join("\0");
    const candidateLength = current.length === 0 ? block.text.length : current.map((item) => item.text.length).reduce((sum, length) => sum + length, 0) + (current.length * 2) + block.text.length;
    if (!sameHeading || candidateLength > MAX_CHUNK_CHARACTERS) {
      emit();
      const overlap: Block[] = [];
      if (sameHeading) {
        let overlapLength = 0;
        for (let index = current.length - 1; index >= 0; index -= 1) {
          const previous = current[index];
          if (overlapLength + previous.text.length > CHUNK_OVERLAP_CHARACTERS) break;
          overlap.unshift(previous);
          overlapLength += previous.text.length + 2;
        }
      }
      current = overlap;
    }
    current.push(block);
  }
  emit();
  return chunks;
}

function paragraphBlocks(text: string, markdown: boolean): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const headings: Array<{ level: number; title: string }> = [];
  let paragraph: string[] = [];
  let startLine = 0;

  const emitParagraph = (endLine: number) => {
    const value = paragraph.join("\n").trim();
    if (value) blocks.push({ text: value, headingPath: headings.map((heading) => heading.title), startLine, endLine });
    paragraph = [];
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const heading = markdown ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      if (paragraph.length) emitParagraph(lineNumber - 1);
      const level = heading[1].length;
      while (headings.at(-1) && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, title: heading[2] });
      return;
    }
    if (line.trim() === "") {
      if (paragraph.length) emitParagraph(lineNumber - 1);
      return;
    }
    if (paragraph.length === 0) startLine = lineNumber;
    paragraph.push(line);
  });
  if (paragraph.length) emitParagraph(lines.length);
  return blocks;
}

export function chunkProjectDocument(text: string, markdown: boolean) {
  return combineBlocks(paragraphBlocks(text, markdown));
}
