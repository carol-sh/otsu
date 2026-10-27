import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MemoryLimits {
  maxFileChars: number;
  maxFiles: number;
}

/**
 * One call's view of the memory directory. Reads see this call's own pending writes;
 * writes reach the disk only on `commit()`, so dropping the transaction leaves the files untouched.
 * Every method returns the text handed back to the LLM as the tool result.
 */
export interface MemoryTx {
  read(name: string): string;
  write(name: string, content: string): string;
  create(name: string, description: string, content: string): string;
  commit(): void;
}

const TEMPLATE_DIR = new URL("./templates/memory/", import.meta.url);
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}\.md$/;
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---(?:\n|$)/;

/** Copies the initial memory files into `dir` when it does not exist yet. */
export function installInitialMemory(dir: string): void {
  if (existsSync(dir)) return;
  cpSync(TEMPLATE_DIR, dir, { recursive: true });
}

/** Builds the INDEX block: one `- name: description` line per file, sorted by name. */
export function memoryIndex(dir: string): string {
  return listMemoryFiles(dir)
    .map((name) => `- ${name}: ${descriptionOf(readMemoryFile(dir, name)) ?? "(설명 없음)"}`)
    .join("\n");
}

export function openMemoryTx(dir: string, limits: MemoryLimits): MemoryTx {
  const pending = new Map<string, string>();
  const existing = new Set(listMemoryFiles(dir));
  const current = (name: string): string | undefined =>
    pending.get(name) ?? (existing.has(name) ? readMemoryFile(dir, name) : undefined);

  return {
    read(name) {
      const text = current(normalizeName(name));
      return text ?? `${name} 파일은 없다. INDEX에 있는 이름만 읽을 수 있다.`;
    },

    write(name, content) {
      const file = normalizeName(name);
      const previous = current(file);
      if (previous === undefined) {
        return `${name} 파일은 없다. 새 분류가 필요하면 memory_create를 쓴다.`;
      }
      const text = withDescription(normalizeNewlines(content), descriptionOf(previous));
      const rejection = sizeRejection(text, limits);
      if (rejection) return rejection;
      pending.set(file, text);
      return `${file}에 썼다.`;
    },

    create(name, description, content) {
      const file = normalizeName(name);
      if (!NAME_PATTERN.test(file)) {
        return `파일 이름 ${name}은 쓸 수 없다. 영문 소문자, 숫자, 하이픈으로 된 .md 이름을 쓴다.`;
      }
      if (current(file) !== undefined) {
        return `${file} 파일은 이미 있다. memory_write로 고친다.`;
      }
      const count = new Set([...existing, ...pending.keys()]).size;
      if (count >= limits.maxFiles) {
        return `파일이 이미 ${count}개라 더 만들 수 없다. 기존 파일에 합친다.`;
      }
      const text = renderFile(description, normalizeNewlines(content));
      const rejection = sizeRejection(text, limits);
      if (rejection) return rejection;
      pending.set(file, text);
      return `${file}을 만들었다.`;
    },

    commit() {
      for (const [name, text] of pending) {
        const path = join(dir, name);
        writeFileSync(`${path}.tmp`, text);
        renameSync(`${path}.tmp`, path);
      }
      pending.clear();
    },
  };
}

function listMemoryFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => NAME_PATTERN.test(name))
    .toSorted();
}

function readMemoryFile(dir: string, name: string): string {
  return normalizeNewlines(readFileSync(join(dir, name), "utf8"));
}

/** Accepts names with or without `.md` and in any case, since the LLM is loose about them. */
function normalizeName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function descriptionOf(text: string): string | undefined {
  const frontmatter = FRONTMATTER_PATTERN.exec(text)?.[1];
  const line = frontmatter?.split("\n").find((entry) => entry.startsWith("description:"));
  return line?.slice("description:".length).trim() || undefined;
}

/** Keeps the previous description when the LLM rewrote a file without its frontmatter. */
function withDescription(text: string, previous: string | undefined): string {
  if (descriptionOf(text) !== undefined || previous === undefined) return text;
  return renderFile(previous, text.replace(FRONTMATTER_PATTERN, ""));
}

function renderFile(description: string, body: string): string {
  const oneLine = description.replaceAll(/\s+/g, " ").trim();
  return `---\ndescription: ${oneLine}\n---\n${body}`;
}

function sizeRejection(text: string, limits: MemoryLimits): string | undefined {
  if (text.length <= limits.maxFileChars) return undefined;
  return `${text.length}자라 상한 ${limits.maxFileChars}자를 넘는다. 압축해서 다시 쓴다.`;
}
