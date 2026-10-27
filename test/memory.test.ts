import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  installInitialMemory,
  memoryIndex,
  openMemoryTx,
  type MemoryLimits,
} from "../src/memory.ts";

const LIMITS: MemoryLimits = { maxFileChars: 200, maxFiles: 5 };

describe("memory", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "otsu-memory-"));
    dir = join(root, "memory");
    installInitialMemory(dir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("installs the four initial files and indexes their descriptions", () => {
    assert.equal(
      memoryIndex(dir),
      [
        "- journal.md: 흐름별 한 줄 요약(날짜 포함). 최근 것만 유지",
        "- relationship.md: 약속, 갈등, 앙금 같은 관계 상태",
        "- task-history.md: 과업별로 무엇을 시켰고 어떻게 됐는지",
        "- user-profile.md: 사용자 성향, 약점, 반응 패턴",
      ].join("\n"),
    );
  });

  it("keeps writes off the disk until commit and lets the same call read them", () => {
    const tx = openMemoryTx(dir, LIMITS);
    tx.write("journal", "---\ndescription: 일지\n---\n10-27 산책 시킴");
    assert.match(tx.read("journal.md"), /산책/);
    assert.doesNotMatch(readFileSync(join(dir, "journal.md"), "utf8"), /산책/);

    tx.commit();
    assert.match(readFileSync(join(dir, "journal.md"), "utf8"), /산책/);
    assert.match(memoryIndex(dir), /- journal.md: 일지/);
  });

  it("leaves files untouched when a call is dropped without commit", () => {
    const before = readFileSync(join(dir, "journal.md"), "utf8");
    openMemoryTx(dir, LIMITS).write("journal.md", "버려질 내용");
    assert.equal(readFileSync(join(dir, "journal.md"), "utf8"), before);
  });

  it("keeps the old description when a rewrite drops the frontmatter", () => {
    const tx = openMemoryTx(dir, LIMITS);
    tx.write("journal.md", "10-27 산책 시킴");
    assert.match(tx.read("journal.md"), /^---\ndescription: 흐름별 한 줄 요약/);
  });

  it("rejects files over the size limit", () => {
    const tx = openMemoryTx(dir, LIMITS);
    assert.match(tx.write("journal.md", "가".repeat(300)), /압축/);
    assert.doesNotMatch(tx.read("journal.md"), /가/);
  });

  it("rejects new files past the count limit", () => {
    const tx = openMemoryTx(dir, LIMITS);
    assert.match(tx.create("habits", "습관", "아침형"), /만들었다/);
    assert.match(tx.create("places", "장소", "공원"), /더 만들 수 없다/);
    tx.commit();
    assert.equal(existsSync(join(dir, "places.md")), false);
    assert.match(memoryIndex(dir), /- habits.md: 습관/);
  });

  it("refuses names that escape the directory or do not exist", () => {
    const tx = openMemoryTx(dir, LIMITS);
    assert.match(tx.read("../.env"), /없다/);
    assert.match(tx.write("../escape", "x"), /없다/);
    assert.match(tx.create("../escape", "x", "x"), /쓸 수 없다/);
    assert.match(tx.create("journal", "x", "x"), /이미 있다/);
    tx.commit();
    assert.equal(existsSync(join(root, "escape.md")), false);
  });
});
